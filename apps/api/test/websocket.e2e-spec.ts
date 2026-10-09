import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConversationEventType, ConversationStatus, Role } from '@prisma/client';
import type {
  ChatMessage,
  ConversationJoinResult,
  MessageSendResult,
  WsAck,
} from '@chatflow/types';
import request from 'supertest';
import { io, type Socket } from 'socket.io-client';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { PasswordService } from '../src/security/password.service';

const TAG = 'phase5-ws';
const TEST_DOMAIN = 'chatflow.test';
const PASSWORD = 'Passw0rd123';

const email = (name: string): string => `${name}-${TAG}@${TEST_DOMAIN}`;
const domain = (name: string): string => `${name}-${TAG}.${TEST_DOMAIN}`;

interface TestWebsite {
  id: string;
  publicKey: string;
}

interface TestVisitor {
  visitorKey: string;
  name: string | null;
}

interface TestConversation {
  id: string;
  status: string;
}

interface TestPage {
  data: ChatMessage[];
  nextCursor: string | null;
}

/** Default-typed socket: emits are untyped on purpose (ack payloads cast here). */
type RawSocket = Socket;

describe('Phase 5b: messaging realtime over Socket.IO (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let baseUrl: string;

  let adminToken: string;
  let agentAToken: string;
  let agentBToken: string;
  let offlineToken: string;

  let siteA: TestWebsite;
  let siteB: TestWebsite;
  let visitorA: TestVisitor;
  let visitorA2: TestVisitor;
  let visitorB: TestVisitor;

  let convA: TestConversation;
  let convB: TestConversation;
  let convClosed: TestConversation;
  let convClosedSend: TestConversation;
  let convPending: TestConversation;
  let convFlood: TestConversation;
  let convValidation: TestConversation;

  const openSockets = new Set<RawSocket>();

  const websiteFilter = { domain: { endsWith: `-${TAG}.${TEST_DOMAIN}` } };

  const cleanup = async (): Promise<void> => {
    const siteIds = (
      await prisma.website.findMany({ where: websiteFilter, select: { id: true } })
    ).map((w) => w.id);

    await prisma.conversation.deleteMany({ where: { websiteId: { in: siteIds } } });
    await prisma.visitor.deleteMany({ where: { websiteId: { in: siteIds } } });
    await prisma.websiteMembership.deleteMany({ where: { websiteId: { in: siteIds } } });
    await prisma.website.deleteMany({ where: { id: { in: siteIds } } });
    await prisma.user.deleteMany({ where: { email: { endsWith: `@${TEST_DOMAIN}` } } });
  };

  const connect = (auth?: Record<string, unknown>): Promise<RawSocket> =>
    new Promise((resolve, reject) => {
      const socket = io(baseUrl, {
        ...(auth ? { auth } : {}),
        transports: ['websocket'],
        forceNew: true,
        reconnection: false,
        timeout: 4000,
      });
      const timer = setTimeout(() => {
        socket.disconnect();
        reject(new Error('connect timed out'));
      }, 5000);
      socket.once('connect', () => {
        clearTimeout(timer);
        resolve(socket);
      });
      socket.once('connect_error', (err: Error) => {
        clearTimeout(timer);
        socket.disconnect();
        reject(err);
      });
    });

  const openSocket = async (auth?: Record<string, unknown>): Promise<RawSocket> => {
    const socket = await connect(auth);
    openSockets.add(socket);
    return socket;
  };

  const emitAck = <T>(socket: RawSocket, event: string, payload: unknown): Promise<WsAck<T>> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ack for ${event}`)), 4000);
      socket.emit(event, payload, (result: WsAck<T>) => {
        clearTimeout(timer);
        resolve(result);
      });
    });

  const waitForEvent = <T>(
    socket: RawSocket,
    event: string,
    predicate?: (payload: T) => boolean,
    timeoutMs = 3000,
  ): Promise<T> =>
    new Promise((resolve, reject) => {
      const handler = (payload: T): void => {
        if (predicate && !predicate(payload)) return;
        clearTimeout(timer);
        socket.off(event, handler);
        resolve(payload);
      };
      const timer = setTimeout(() => {
        socket.off(event, handler);
        reject(new Error(`timed out waiting for "${event}"`));
      }, timeoutMs);
      socket.on(event, handler);
    });

  const expectAcked = <T>(ack: WsAck<T>): T => {
    if (!ack.ok) {
      throw new Error(`expected ok ack, got ${ack.error.code}: ${ack.error.message}`);
    }
    return ack;
  };

  const expectFailed = (ack: WsAck): string => {
    if (ack.ok !== false) {
      throw new Error('expected a failed ack');
    }
    return ack.error.code;
  };

  const staffAuth = (token: string): Record<string, unknown> => ({ token });
  const visitorAuth = (site: TestWebsite, visitor: TestVisitor): Record<string, unknown> => ({
    publicKey: site.publicKey,
    visitorKey: visitor.visitorKey,
  });

  const join = (socket: RawSocket, conversationId: string) =>
    emitAck<ConversationJoinResult>(socket, 'conversation:join', { conversationId });

  const send = (
    socket: RawSocket,
    payload: Record<string, unknown>,
  ): Promise<WsAck<MessageSendResult>> =>
    emitAck<MessageSendResult>(socket, 'message:send', payload);

  const history = (
    publicKey: string,
    visitorKey: string,
    conversationId: string,
  ): Promise<TestPage> =>
    request(app.getHttpServer())
      .get(
        `/api/public/websites/${publicKey}/visitor/${visitorKey}/conversations/${conversationId}/messages?limit=100`,
      )
      .then((res) => {
        expect(res.status).toBe(200);
        return res.body as TestPage;
      });

  beforeAll(async () => {
    // Per-suite WebSocket limits: generous connect (shared per IP across every
    // socket this suite opens) and a tight per-socket message bucket so the
    // flood test stays fast. Restored in afterAll — jest shares the process.
    process.env.WS_RATE_LIMIT_CONNECT_MAX = '1000';
    process.env.WS_RATE_LIMIT_MESSAGE_MAX = '8';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    await app.listen(0);

    const address = app.getHttpServer().address();
    if (address === null || typeof address === 'string') {
      throw new Error('failed to bind an ephemeral port');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;

    prisma = app.get(PrismaService);
    const password = app.get(PasswordService);
    await cleanup();

    const hash = await password.hash(PASSWORD);
    await prisma.user.create({
      data: { email: email('admin'), role: Role.ADMIN, passwordHash: hash, name: 'WS Admin' },
    });
    await prisma.user.create({
      data: { email: email('agent-a'), role: Role.AGENT, passwordHash: hash, name: 'WS Alice' },
    });
    await prisma.user.create({
      data: { email: email('agent-b'), role: Role.AGENT, passwordHash: hash, name: 'WS Bob' },
    });
    await prisma.user.create({
      data: { email: email('offline'), role: Role.AGENT, passwordHash: hash, name: 'WS Offline' },
    });

    const login = async (name: string): Promise<string> => {
      const res = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: email(name), password: PASSWORD });
      expect(res.status).toBe(200);
      return res.body.accessToken as string;
    };
    adminToken = await login('admin');
    agentAToken = await login('agent-a');
    agentBToken = await login('agent-b');
    offlineToken = await login('offline');

    // Deactivated *after* login: the token is still cryptographically valid,
    // but the handshake re-loads the user and must refuse it.
    await prisma.user.update({
      where: { email: email('offline') },
      data: { isActive: false },
    });

    const createSite = async (name: string): Promise<TestWebsite> => {
      const res = await request(app.getHttpServer())
        .post('/api/websites')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name, domain: domain(name.toLowerCase().replace(/\s+/g, '-')) });
      expect(res.status).toBe(201);
      return res.body as TestWebsite;
    };
    siteA = await createSite('WS Site A');
    siteB = await createSite('WS Site B');

    const agentAId = (await prisma.user.findUniqueOrThrow({ where: { email: email('agent-a') } }))
      .id;
    const membership = await request(app.getHttpServer())
      .post(`/api/websites/${siteA.id}/memberships`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ userId: agentAId });
    expect(membership.status).toBe(201);

    const init = async (site: TestWebsite, name?: string): Promise<TestVisitor> => {
      const res = await request(app.getHttpServer())
        .post(`/api/public/websites/${site.publicKey}/visitor`)
        .send(name ? { name } : {});
      expect(res.status).toBe(201);
      return res.body as TestVisitor;
    };
    visitorA = await init(siteA, 'WS Visitor A');
    visitorA2 = await init(siteA, 'WS Visitor A2');
    visitorB = await init(siteB, 'WS Visitor B');

    const createConversation = async (
      site: TestWebsite,
      visitor: TestVisitor,
    ): Promise<TestConversation> => {
      const res = await request(app.getHttpServer())
        .post(`/api/public/websites/${site.publicKey}/conversations`)
        .send({ visitorKey: visitor.visitorKey });
      expect(res.status).toBe(201);
      return res.body as TestConversation;
    };
    convA = await createConversation(siteA, visitorA);
    convB = await createConversation(siteB, visitorB);
    convClosed = await createConversation(siteA, visitorA);
    convClosedSend = await createConversation(siteA, visitorA);
    convPending = await createConversation(siteA, visitorA);
    convFlood = await createConversation(siteA, visitorA);
    convValidation = await createConversation(siteA, visitorA);

    const closeRes = await request(app.getHttpServer())
      .post(
        `/api/public/websites/${siteA.publicKey}/visitor/${visitorA.visitorKey}/conversations/${convClosedSend.id}/close`,
      )
      .send({});
    expect(closeRes.status).toBe(200);
  });

  afterEach(() => {
    for (const socket of openSockets) {
      socket.disconnect();
    }
    openSockets.clear();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
    delete process.env.WS_RATE_LIMIT_CONNECT_MAX;
    delete process.env.WS_RATE_LIMIT_MESSAGE_MAX;
  });

  // ----------------------------------------------------------- handshake

  describe('handshake authentication', () => {
    it('accepts staff with the same JWT used for REST', async () => {
      const socket = await openSocket(staffAuth(agentAToken));
      expect(socket.connected).toBe(true);
    });

    it('accepts a visitor with publicKey + visitorKey', async () => {
      const socket = await openSocket(visitorAuth(siteA, visitorA));
      expect(socket.connected).toBe(true);
    });

    it('refuses a tampered or foreign token', async () => {
      await expect(connect(staffAuth(agentAToken.slice(0, -4) + 'AAAA'))).rejects.toThrow();
    });

    it('refuses a connection with no credentials', async () => {
      await expect(connect()).rejects.toThrow();
      await expect(connect({})).rejects.toThrow();
    });

    it('refuses a deactivated user even with a still-valid token', async () => {
      await expect(connect(staffAuth(offlineToken))).rejects.toThrow();
    });

    it('refuses a visitor with a wrong visitorKey', async () => {
      await expect(
        connect({
          publicKey: siteA.publicKey,
          visitorKey: visitorA2.visitorKey.slice(0, -1) + 'x',
        }),
      ).rejects.toThrow();
    });
  });

  // ------------------------------------------------------ join authorization

  describe('conversation:join authorization', () => {
    it('lets a member agent join their website conversation', async () => {
      const socket = await openSocket(staffAuth(agentAToken));
      const ack = await join(socket, convA.id);
      const result = expectAcked<ConversationJoinResult>(ack);
      expect(result.conversation.id).toBe(convA.id);
    });

    it('lets the owning visitor join', async () => {
      const socket = await openSocket(visitorAuth(siteA, visitorA));
      const ack = await join(socket, convA.id);
      expect(expectAcked<ConversationJoinResult>(ack).conversation.id).toBe(convA.id);
    });

    it('forbids an agent without membership', async () => {
      const socket = await openSocket(staffAuth(agentBToken));
      const code = expectFailed(await join(socket, convA.id));
      expect(code).toBe('FORBIDDEN');
    });

    it('forbids a member agent from a foreign tenant conversation', async () => {
      const socket = await openSocket(staffAuth(agentAToken));
      const code = expectFailed(await join(socket, convB.id));
      expect(code).toBe('FORBIDDEN');
    });

    it('reports an unknown conversation as NOT_FOUND', async () => {
      const socket = await openSocket(staffAuth(agentAToken));
      const code = expectFailed(await join(socket, crypto.randomUUID()));
      expect(code).toBe('NOT_FOUND');
    });

    it('hides foreign conversations behind NOT_FOUND for visitors', async () => {
      const sockets = [
        await openSocket(visitorAuth(siteB, visitorB)),
        await openSocket(visitorAuth(siteA, visitorA2)),
      ];
      const codes = await Promise.all(
        sockets.map(async (socket) => expectFailed(await join(socket, convA.id))),
      );
      expect(codes).toEqual(['NOT_FOUND', 'NOT_FOUND']);
    });

    it('validates the join payload', async () => {
      const socket = await openSocket(staffAuth(agentAToken));
      expect(expectFailed(await emitAck(socket, 'conversation:join', {}))).toBe('VALIDATION');
      expect(
        expectFailed(await emitAck(socket, 'conversation:join', { conversationId: 'nope' })),
      ).toBe('VALIDATION');
      expect(expectFailed(await emitAck(socket, 'conversation:join', 'not-an-object'))).toBe(
        'VALIDATION',
      );
    });
  });

  // ------------------------------------------------------------ messaging

  describe('message:send through the realtime transport', () => {
    it('persists a visitor message and fans it out to the joined agent', async () => {
      const staffSocket = await openSocket(staffAuth(agentAToken));
      const visitorSocket = await openSocket(visitorAuth(siteA, visitorA));
      expect(expectAcked<ConversationJoinResult>(await join(staffSocket, convA.id))).toBeTruthy();
      expect(expectAcked<ConversationJoinResult>(await join(visitorSocket, convA.id))).toBeTruthy();

      const delivered = waitForEvent<{ conversationId: string; message: ChatMessage }>(
        staffSocket,
        'message:new',
        (payload) => payload.conversationId === convA.id,
      );

      const clientMessageId = crypto.randomUUID();
      const ack = await send(visitorSocket, {
        conversationId: convA.id,
        content: 'Realtime hello',
        clientMessageId,
      });
      const { message, replay } = expectAcked<MessageSendResult>(ack);
      expect(replay).toBe(false);
      expect(message.content).toBe('Realtime hello');

      const event = await delivered;
      expect(event.message.id).toBe(message.id);

      // Database is the source of truth — the row and audit event exist.
      const row = await prisma.message.findUniqueOrThrow({ where: { id: message.id } });
      expect(row.visitorId).toBeTruthy();
      expect(row.clientMessageId).toBe(clientMessageId);
      const audit = await prisma.conversationEvent.findFirst({
        where: { conversationId: convA.id, type: ConversationEventType.MESSAGE_SENT },
      });
      expect((audit?.metadata as { messageId?: string })?.messageId).toBe(message.id);
    });

    it('lets the agent reply over the socket and delivers to the visitor', async () => {
      const staffSocket = await openSocket(staffAuth(agentAToken));
      const visitorSocket = await openSocket(visitorAuth(siteA, visitorA));
      await join(staffSocket, convA.id);
      await join(visitorSocket, convA.id);

      const delivered = waitForEvent<{ message: ChatMessage }>(visitorSocket, 'message:new');
      const ack = await send(staffSocket, {
        conversationId: convA.id,
        content: 'Agent realtime reply',
      });
      const { message } = expectAcked<MessageSendResult>(ack);
      expect(message.senderType).toBe('AGENT');
      expect(message.senderName).toBe('WS Alice');

      const event = await delivered;
      expect(event.message.id).toBe(message.id);
    });

    it('delivers messages sent over REST to joined sockets (shared bus)', async () => {
      const staffSocket = await openSocket(staffAuth(agentAToken));
      await join(staffSocket, convA.id);

      const delivered = waitForEvent<{ message: ChatMessage }>(
        staffSocket,
        'message:new',
        (payload) => payload.message.content === 'Sent via REST',
      );

      const restSend = await request(app.getHttpServer())
        .post(
          `/api/public/websites/${siteA.publicKey}/visitor/${visitorA.visitorKey}/conversations/${convA.id}/messages`,
        )
        .send({ content: 'Sent via REST' });
      expect(restSend.status).toBe(201);

      const event = await delivered;
      expect(event.message.senderType).toBe('VISITOR');
    });

    it('reopens a PENDING conversation and publishes conversation:updated', async () => {
      await prisma.conversation.update({
        where: { id: convPending.id },
        data: { status: ConversationStatus.PENDING },
      });

      const staffSocket = await openSocket(staffAuth(agentAToken));
      const visitorSocket = await openSocket(visitorAuth(siteA, visitorA));
      await join(staffSocket, convPending.id);
      await join(visitorSocket, convPending.id);

      const updated = waitForEvent<{ conversation: { id: string; status: string } }>(
        staffSocket,
        'conversation:updated',
        (payload) => payload.conversation.id === convPending.id,
      );
      const messageEvent = waitForEvent<{ message: ChatMessage }>(staffSocket, 'message:new');

      const ack = await send(visitorSocket, {
        conversationId: convPending.id,
        content: 'Visitor is back',
      });
      expect(expectAcked<MessageSendResult>(ack).message.content).toBe('Visitor is back');

      expect((await updated).conversation.status).toBe('OPEN');
      await messageEvent;

      const row = await prisma.conversation.findUniqueOrThrow({
        where: { id: convPending.id },
      });
      expect(row.status).toBe(ConversationStatus.OPEN);
    });

    it('rejects a send into a closed conversation without persisting', async () => {
      const visitorSocket = await openSocket(visitorAuth(siteA, visitorA));
      await join(visitorSocket, convClosedSend.id);

      const before = await prisma.message.count({ where: { conversationId: convClosedSend.id } });
      const code = expectFailed(
        await send(visitorSocket, { conversationId: convClosedSend.id, content: 'too late' }),
      );
      expect(code).toBe('CONVERSATION_CLOSED');

      const after = await prisma.message.count({ where: { conversationId: convClosedSend.id } });
      expect(after).toBe(before);
    });

    it('publishes conversation:closed to a joined socket when the visitor closes', async () => {
      const visitorSocket = await openSocket(visitorAuth(siteA, visitorA));
      await join(visitorSocket, convClosed.id);

      const closed = waitForEvent<{ conversationId: string; status: string }>(
        visitorSocket,
        'conversation:closed',
        (payload) => payload.conversationId === convClosed.id,
      );

      const res = await request(app.getHttpServer())
        .post(
          `/api/public/websites/${siteA.publicKey}/visitor/${visitorA.visitorKey}/conversations/${convClosed.id}/close`,
        )
        .send({});
      expect(res.status).toBe(200);

      const event = await closed;
      expect(event.status).toBe('CLOSED');
    });

    it('publishes conversation:closed to joined sockets when a staff user closes via REST', async () => {
      const createdConv = await request(app.getHttpServer())
        .post(`/api/public/websites/${siteA.publicKey}/conversations`)
        .send({ visitorKey: visitorA.visitorKey });
      expect(createdConv.status).toBe(201);
      const target = createdConv.body as TestConversation;

      const staffSocket = await openSocket(staffAuth(agentAToken));
      const closedAck = await join(staffSocket, target.id);
      expect(closedAck.ok).toBe(true);

      const closed = waitForEvent<{ conversationId: string; status: string }>(
        staffSocket,
        'conversation:closed',
        (payload) => payload.conversationId === target.id,
      );

      const res = await request(app.getHttpServer())
        .post(`/api/websites/${siteA.id}/conversations/${target.id}/close`)
        .set('Authorization', `Bearer ${agentAToken}`)
        .send({});
      expect(res.status).toBe(200);

      const event = await closed;
      expect(event.status).toBe('CLOSED');

      // Other joined staff now see the thread as closed: a second close is 409.
      const again = await request(app.getHttpServer())
        .post(`/api/websites/${siteA.id}/conversations/${target.id}/close`)
        .set('Authorization', `Bearer ${agentAToken}`)
        .send({});
      expect(again.status).toBe(409);
    });

    it('serves history from REST after a disconnect (source of truth)', async () => {
      const staffSocket = await openSocket(staffAuth(agentAToken));
      await join(staffSocket, convA.id);
      staffSocket.disconnect();

      const ack = await send(await openSocket(visitorAuth(siteA, visitorA)), {
        conversationId: convA.id,
        content: 'Written while the agent was away',
      });
      const { message } = expectAcked<MessageSendResult>(ack);

      const page = await history(siteA.publicKey, visitorA.visitorKey, convA.id);
      expect(page.data.some((m) => m.id === message.id)).toBe(true);
    });

    it('stops realtime delivery after conversation:leave (history still on REST)', async () => {
      const staffSocket = await openSocket(staffAuth(agentAToken));
      const visitorSocket = await openSocket(visitorAuth(siteA, visitorA));
      await join(staffSocket, convA.id);
      await join(visitorSocket, convA.id);

      expect(expectFailed(await emitAck(staffSocket, 'conversation:leave', {}))).toBe('VALIDATION');
      const leaveAck = await emitAck(staffSocket, 'conversation:leave', {
        conversationId: convA.id,
      });
      expect(leaveAck.ok).toBe(true);

      const noDelivery = waitForEvent(staffSocket, 'message:new', undefined, 250).then(
        () => false,
        () => true,
      );

      const ack = await send(visitorSocket, {
        conversationId: convA.id,
        content: 'Nobody should see this live',
      });
      const { message } = expectAcked<MessageSendResult>(ack);
      expect(await noDelivery).toBe(true);

      const page = await history(siteA.publicKey, visitorA.visitorKey, convA.id);
      expect(page.data.some((m) => m.id === message.id)).toBe(true);
    });
  });

  // ----------------------------------------------------------- validation

  describe('payload validation parity with the REST pipe', () => {
    it('rejects malformed message payloads with VALIDATION acks', async () => {
      const socket = await openSocket(visitorAuth(siteA, visitorA));

      expect(expectFailed(await send(socket, { conversationId: convValidation.id }))).toBe(
        'VALIDATION',
      );
      expect(
        expectFailed(await send(socket, { conversationId: convValidation.id, content: '   ' })),
      ).toBe('VALIDATION');
      expect(
        expectFailed(await send(socket, { conversationId: convValidation.id, content: 12345 })),
      ).toBe('VALIDATION');
      expect(
        expectFailed(
          await send(socket, {
            conversationId: convValidation.id,
            content: 'forged identity',
            senderType: 'AGENT',
          }),
        ),
      ).toBe('VALIDATION');
      expect(expectFailed(await send(socket, { conversationId: 'nope', content: 'hi' }))).toBe(
        'VALIDATION',
      );
    });

    it('pushes an error event (not an ack) when the client sends without one', async () => {
      const socket = await openSocket(visitorAuth(siteA, visitorA));

      const failed = waitForEvent<{ error: { code: string } }>(socket, 'error');
      socket.emit('message:send', { conversationId: convValidation.id, content: 999 });

      const event = await failed;
      expect(event.error.code).toBe('VALIDATION');
    });
  });

  // ------------------------------------------- idempotency parity with REST

  describe('idempotency over the socket (same rules as REST)', () => {
    const countEventsFor = async (messageId: string): Promise<number> => {
      const events = await prisma.conversationEvent.findMany({
        where: { conversationId: convValidation.id, type: ConversationEventType.MESSAGE_SENT },
      });
      return events.filter((e) => (e.metadata as { messageId?: string })?.messageId === messageId)
        .length;
    };

    it('replays the original message for the same principal (replay: true)', async () => {
      const socket = await openSocket(visitorAuth(siteA, visitorA));
      const key = crypto.randomUUID();

      const first = await send(socket, {
        conversationId: convValidation.id,
        content: 'socket original',
        clientMessageId: key,
      });
      if (first.ok === false) throw new Error('first send failed');
      expect(first.replay).toBe(false);

      const retry = await send(socket, {
        conversationId: convValidation.id,
        content: 'socket original (retry with different text)',
        clientMessageId: key,
      });
      if (retry.ok === false) throw new Error('retry failed');
      expect(retry.replay).toBe(true);
      expect(retry.message.id).toBe(first.message.id);
      expect(retry.message.content).toBe('socket original');

      // Same-parity guarantee as REST: the replay emits no second event.
      expect(await countEventsFor(first.message.id)).toBe(1);
    });

    it('refuses an agent adopting a visitor message (CONFLICT ack)', async () => {
      const visitorSocket = await openSocket(visitorAuth(siteA, visitorA));
      const staffSocket = await openSocket(staffAuth(agentAToken));
      const key = crypto.randomUUID();

      const created = await send(visitorSocket, {
        conversationId: convValidation.id,
        content: 'visitor socket message',
        clientMessageId: key,
      });
      if (created.ok === false) throw new Error('visitor send failed');
      const createdId = created.message.id;

      const attempt = await send(staffSocket, {
        conversationId: convValidation.id,
        content: 'agent replacement',
        clientMessageId: key,
      });
      if (attempt.ok === false) {
        expect(attempt.error.code).toBe('CONFLICT');
      } else {
        throw new Error('expected a CONFLICT ack, got a replay');
      }

      const rows = await prisma.message.count({
        where: { conversationId: convValidation.id, clientMessageId: key },
      });
      expect(rows).toBe(1);
      expect(await countEventsFor(createdId)).toBe(1);
    });

    it('refuses a visitor adopting an agent message (CONFLICT ack)', async () => {
      const visitorSocket = await openSocket(visitorAuth(siteA, visitorA));
      const staffSocket = await openSocket(staffAuth(agentAToken));
      const key = crypto.randomUUID();

      const created = await send(staffSocket, {
        conversationId: convValidation.id,
        content: 'agent socket message',
        clientMessageId: key,
      });
      if (created.ok === false) throw new Error('agent send failed');
      const createdId = created.message.id;

      const attempt = await send(visitorSocket, {
        conversationId: convValidation.id,
        content: 'visitor replacement',
        clientMessageId: key,
      });
      if (attempt.ok === false) {
        expect(attempt.error.code).toBe('CONFLICT');
      } else {
        throw new Error('expected a CONFLICT ack, got a replay');
      }

      const rows = await prisma.message.count({
        where: { conversationId: convValidation.id, clientMessageId: key },
      });
      expect(rows).toBe(1);
      expect(await countEventsFor(createdId)).toBe(1);
    });
  });

  // ------------------------------------------------------------ rate limits

  describe('per-socket message rate limit', () => {
    it('rejects with RATE_LIMITED once the window is exhausted', async () => {
      const socket = await openSocket(visitorAuth(siteA, visitorA));
      // Suite env: WS_RATE_LIMIT_MESSAGE_MAX = 8.
      for (let i = 0; i < 8; i += 1) {
        const ack = await send(socket, {
          conversationId: convFlood.id,
          content: `flood ${i}`,
        });
        expect(expectAcked<MessageSendResult>(ack).message.content).toBe(`flood ${i}`);
      }
      const code = expectFailed(
        await send(socket, { conversationId: convFlood.id, content: 'one too many' }),
      );
      expect(code).toBe('RATE_LIMITED');

      const rows = await prisma.message.count({ where: { conversationId: convFlood.id } });
      expect(rows).toBe(8);
    }, 20_000);
  });
});
