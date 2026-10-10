import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Role } from '@prisma/client';
import type {
  ConversationAssignedEvent,
  ConversationClosedEvent,
  ConversationNewEvent,
  MessageNewEvent,
  StaffConversation,
} from '@chatflow/types';
import request from 'supertest';
import { io, type Socket } from 'socket.io-client';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { PasswordService } from '../src/security/password.service';

const TAG = 'phase9-inbox';
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
}

type RawSocket = Socket;

/** Phase 9: staff inbox fan-out via website-scoped rooms. */
describe('Phase 9: live inbox fan-out (website staff rooms, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let baseUrl: string;

  let adminToken: string;
  let agentAToken: string;
  let agentCToken: string;
  let agentDToken: string;

  let agentAId: string;
  let agentCId: string;
  let agentDId: string;

  let siteA: TestWebsite;
  let siteB: TestWebsite;

  let visitorA: TestVisitor;
  let visitorB: TestVisitor;

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

  const staff = (token: string) => ({ Authorization: `Bearer ${token}` });

  const connect = (authPayload?: Record<string, unknown>): Promise<RawSocket> =>
    new Promise((resolve, reject) => {
      const socket = io(baseUrl, {
        ...(authPayload ? { auth: authPayload } : {}),
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

  const openSocket = async (authPayload?: Record<string, unknown>): Promise<RawSocket> => {
    const socket = await connect(authPayload);
    openSockets.add(socket);
    // The website staff rooms are joined asynchronously after the handshake;
    // give the join a beat so the first event of a test is never raced.
    await new Promise((resolve) => setTimeout(resolve, 50));
    return socket;
  };

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

  const expectNoEvent = async <T>(
    socket: RawSocket,
    event: string,
    timeoutMs = 400,
  ): Promise<boolean> =>
    waitForEvent<T>(socket, event, undefined, timeoutMs).then(
      () => false,
      () => true,
    );

  const createConversation = (site: TestWebsite, visitor: TestVisitor): Promise<{ id: string }> =>
    request(app.getHttpServer())
      .post(`/api/public/websites/${site.publicKey}/conversations`)
      .send({ visitorKey: visitor.visitorKey })
      .then((res) => {
        expect(res.status).toBe(201);
        return res.body as { id: string };
      });

  const visitorSend = (site: TestWebsite, visitor: TestVisitor, conversationId: string) =>
    request(app.getHttpServer())
      .post(
        `/api/public/websites/${site.publicKey}/visitor/${visitor.visitorKey}/conversations/${conversationId}/messages`,
      )
      .send({ content: 'preview me' })
      .then((res) => {
        expect(res.status).toBe(201);
      });

  const closeConversation = (site: TestWebsite, visitor: TestVisitor, conversationId: string) =>
    request(app.getHttpServer())
      .post(
        `/api/public/websites/${site.publicKey}/visitor/${visitor.visitorKey}/conversations/${conversationId}/close`,
      )
      .send({})
      .then((res) => {
        expect(res.status).toBe(200);
      });

  const claim = (siteId: string, conversationId: string, token: string) =>
    request(app.getHttpServer())
      .post(`/api/websites/${siteId}/conversations/${conversationId}/claim`)
      .set(staff(token))
      .send({})
      .then((res) => {
        expect(res.status).toBe(200);
      });

  const inboxList = (siteId: string, token: string): Promise<{ data: StaffConversation[] }> =>
    request(app.getHttpServer())
      .get(`/api/websites/${siteId}/conversations`)
      .set(staff(token))
      .then((res) => {
        expect(res.status).toBe(200);
        return res.body as { data: StaffConversation[] };
      });

  beforeAll(async () => {
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
      data: { email: email('admin'), role: Role.ADMIN, passwordHash: hash, name: 'INB Admin' },
    });
    for (const [name, label] of [
      ['agent-a', 'INB Alice'],
      ['agent-c', 'INB Carol'],
      ['agent-d', 'INB Daria'],
    ] as const) {
      await prisma.user.create({
        data: { email: email(name), role: Role.AGENT, passwordHash: hash, name: label },
      });
    }

    const login = async (name: string): Promise<string> => {
      const res = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: email(name), password: PASSWORD });
      expect(res.status).toBe(200);
      return res.body.accessToken as string;
    };
    adminToken = await login('admin');
    agentAToken = await login('agent-a');
    agentCToken = await login('agent-c');
    agentDToken = await login('agent-d');

    agentAId = (await prisma.user.findUniqueOrThrow({ where: { email: email('agent-a') } })).id;
    agentCId = (await prisma.user.findUniqueOrThrow({ where: { email: email('agent-c') } })).id;
    agentDId = (await prisma.user.findUniqueOrThrow({ where: { email: email('agent-d') } })).id;

    const createSite = async (name: string, siteName: string): Promise<TestWebsite> => {
      const res = await request(app.getHttpServer())
        .post('/api/websites')
        .set(staff(adminToken))
        .send({ name, domain: domain(siteName) });
      expect(res.status).toBe(201);
      return res.body as TestWebsite;
    };
    siteA = await createSite('INB Site A', 'inb-a');
    siteB = await createSite('INB Site B', 'inb-b');

    const addMembership = async (userId: string, siteId: string, active = true): Promise<void> => {
      const res = await request(app.getHttpServer())
        .post(`/api/websites/${siteId}/memberships`)
        .set(staff(adminToken))
        .send({ userId });
      expect(res.status).toBe(201);
      if (!active) {
        const row = await prisma.websiteMembership.findFirstOrThrow({
          where: { userId, websiteId: siteId },
        });
        const patch = await request(app.getHttpServer())
          .patch(`/api/websites/${siteId}/memberships/${row.id}`)
          .set(staff(adminToken))
          .send({ isActive: false });
        expect(patch.status).toBe(200);
      }
    };

    // agent-a: active member of siteA.
    await addMembership(agentAId, siteA.id);
    // agent-c: active member of siteB only (cross-tenant control).
    await addMembership(agentCId, siteB.id);
    // agent-d: membership on siteA, but deactivated → no inbox fan-out.
    await addMembership(agentDId, siteA.id, false);

    const init = async (site: TestWebsite, name: string): Promise<TestVisitor> => {
      const res = await request(app.getHttpServer())
        .post(`/api/public/websites/${site.publicKey}/visitor`)
        .send({ name });
      expect(res.status).toBe(201);
      return res.body as TestVisitor;
    };
    visitorA = await init(siteA, 'INB Visitor A');
    visitorB = await init(siteB, 'INB Visitor B');
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
  });

  it('hears conversation:new with the full inbox row without ever joining a room', async () => {
    const inbox = await openSocket({ token: agentAToken });

    const delivered = waitForEvent<ConversationNewEvent>(
      inbox,
      'conversation:new',
      (payload) => payload.websiteId === siteA.id,
    );

    const conversation = await createConversation(siteA, visitorA);

    const event = await delivered;
    expect(event.conversation.id).toBe(conversation.id);
    expect(event.conversation.status).toBe('OPEN');
    expect(event.conversation.assignedAgent).toBeNull();
    expect(event.conversation.lastMessage).toBeNull();
    expect(event.conversation.visitor.name).toBe('INB Visitor A');

    // The pushed row matches the REST inbox exactly (ordering + preview).
    const list = await inboxList(siteA.id, agentAToken);
    expect(list.data[0]?.id).toBe(conversation.id);
  });

  it('delivers message previews for conversations nobody has opened', async () => {
    const inbox = await openSocket({ token: agentAToken });
    const existing = await createConversation(siteA, visitorA);

    const delivered = waitForEvent<MessageNewEvent>(
      inbox,
      'message:new',
      (payload) => payload.conversationId === existing.id,
    );

    await visitorSend(siteA, visitorA, existing.id);

    const event = await delivered;
    expect(event.message.content).toBe('preview me');
    expect(event.message.senderType).toBe('VISITOR');
  });

  it('pushes conversation:closed to the website staff inbox', async () => {
    const inbox = await openSocket({ token: agentAToken });
    const existing = await createConversation(siteA, visitorA);

    const delivered = waitForEvent<ConversationClosedEvent>(
      inbox,
      'conversation:closed',
      (payload) => payload.conversationId === existing.id,
    );

    await closeConversation(siteA, visitorA, existing.id);

    const event = await delivered;
    expect(event.status).toBe('CLOSED');
  });

  it('fans assignment changes into the inbox, never to the visitor', async () => {
    const inbox = await openSocket({ token: agentAToken });
    const visitorSocket = await openSocket({
      publicKey: siteA.publicKey,
      visitorKey: visitorA.visitorKey,
    });
    const existing = await createConversation(siteA, visitorA);

    const delivered = waitForEvent<ConversationAssignedEvent>(
      inbox,
      'conversation:assigned',
      (payload) => payload.conversationId === existing.id,
    );

    await claim(siteA.id, existing.id, agentAToken);

    const event = await delivered;
    expect(event.assignedAgent).toEqual({ id: agentAId, name: 'INB Alice' });
    expect(await expectNoEvent(visitorSocket, 'conversation:assigned')).toBe(true);
  });

  it('scopes inbox fan-out to the owning website only (cross-tenant + inactive membership)', async () => {
    const siteBInbox = await openSocket({ token: agentCToken });
    const inactiveInbox = await openSocket({ token: agentDToken });

    const deliveredForB = waitForEvent<ConversationNewEvent>(
      siteBInbox,
      'conversation:new',
      (payload) => payload.websiteId === siteB.id,
    );

    await createConversation(siteA, visitorA);
    const b = await createConversation(siteB, visitorB);

    expect((await deliveredForB).conversation.id).toBe(b.id);

    // The siteA event never reached Carol (not a member) or Daria (inactive).
    expect(await expectNoEvent(siteBInbox, 'conversation:new')).toBe(true);
    expect(await expectNoEvent(inactiveInbox, 'conversation:new')).toBe(true);
  });

  it('joins every website an ADMIN may read and none a visitor may', async () => {
    const adminInbox = await openSocket({ token: adminToken });
    const visitorSocket = await openSocket({
      publicKey: siteA.publicKey,
      visitorKey: visitorA.visitorKey,
    });

    const onB = waitForEvent<ConversationNewEvent>(
      adminInbox,
      'conversation:new',
      (payload) => payload.websiteId === siteB.id,
    );
    const onA = waitForEvent<ConversationNewEvent>(
      adminInbox,
      'conversation:new',
      (payload) => payload.websiteId === siteA.id,
    );

    const a = await createConversation(siteA, visitorA);
    const b = await createConversation(siteB, visitorB);

    expect((await onA).conversation.id).toBe(a.id);
    expect((await onB).conversation.id).toBe(b.id);

    // Visitors are inbox-less: no staff events, not ever.
    expect(await expectNoEvent(visitorSocket, 'conversation:new')).toBe(true);
  });

  it('delivers a duplicate inbox event to every staff socket of the website', async () => {
    const first = await openSocket({ token: agentAToken });
    const second = await openSocket({ token: agentAToken });

    const a = waitForEvent<ConversationNewEvent>(
      first,
      'conversation:new',
      (payload) => payload.websiteId === siteA.id,
    );
    const b = waitForEvent<ConversationNewEvent>(
      second,
      'conversation:new',
      (payload) => payload.websiteId === siteA.id,
    );

    const conversation = await createConversation(siteA, visitorA);

    // The dashboard consumes duplicate copies idempotently (upsert by id).
    expect((await a).conversation.id).toBe(conversation.id);
    expect((await b).conversation.id).toBe(conversation.id);
  });

  it('re-establishes inbox subscription on a fresh connection (reconnect path)', async () => {
    const first = await openSocket({ token: agentAToken });
    const firstEvent = waitForEvent<ConversationNewEvent>(
      first,
      'conversation:new',
      (payload) => payload.websiteId === siteA.id,
    );
    const conversation = await createConversation(siteA, visitorA);
    expect((await firstEvent).conversation.id).toBe(conversation.id);

    // Simulate a drop + reconnect: a brand-new connection carries the same
    // authority, and the website rooms are re-derived server-side with no
    // client rejoin message and no client restart protocol.
    first.disconnect();
    const afterReconnect = await openSocket({ token: agentAToken });

    const delivered = waitForEvent<ConversationNewEvent>(
      afterReconnect,
      'conversation:new',
      (payload) => payload.websiteId === siteA.id,
    );
    const second = await createConversation(siteA, visitorA);

    expect((await delivered).conversation.id).toBe(second.id);
  });
});
