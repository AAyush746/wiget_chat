import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Role } from '@prisma/client';
import type {
  ConversationAssignedEvent,
  ConversationAssignmentEntry,
  PublicUser,
  StaffConversation,
} from '@chatflow/types';
import request from 'supertest';
import { io, type Socket } from 'socket.io-client';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { PasswordService } from '../src/security/password.service';

const TAG = 'phase8-asg';
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

interface TestConversation {
  id: string;
}

type RawSocket = Socket;

describe('Phase 8: conversation assignment workflow (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let baseUrl: string;

  let adminToken: string;
  let agentAToken: string;
  let agentBToken: string;
  let agentCToken: string;

  let adminId: string;
  let agentAId: string;
  let agentBId: string;
  let agentCId: string;
  let agentOffId: string;

  let siteA: TestWebsite;
  let siteB: TestWebsite;
  let siteC: TestWebsite;

  let visitorA: TestVisitor;
  let visitorB: TestVisitor;
  let visitorC: TestVisitor;

  let convClaim: TestConversation;
  let convAssign: TestConversation;
  let convClosed: TestConversation;
  let convRace: TestConversation;
  let convRealtime: TestConversation;
  let convVisitor: TestConversation;
  let convForeign: TestConversation;
  let convDeact: TestConversation;

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

  const staff = (token: string) => ({
    Authorization: `Bearer ${token}`,
  });

  const get = (token: string, path: string) =>
    request(app.getHttpServer()).get(path).set(staff(token));

  const claim = (siteId: string, conversationId: string, token: string) =>
    request(app.getHttpServer())
      .post(`/api/websites/${siteId}/conversations/${conversationId}/claim`)
      .set(staff(token))
      .send({});

  const assign = (siteId: string, conversationId: string, userId: string, token: string) =>
    request(app.getHttpServer())
      .post(`/api/websites/${siteId}/conversations/${conversationId}/assign`)
      .set(staff(token))
      .send({ userId });

  const history = (siteId: string, conversationId: string, token: string) =>
    get(token, `/api/websites/${siteId}/conversations/${conversationId}/assignments`);

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
    return socket;
  };

  const emitAck = <T>(socket: RawSocket, event: string, payload: unknown): Promise<any> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ack for ${event}`)), 4000);
      socket.emit(event, payload, (result: T) => {
        clearTimeout(timer);
        resolve(result);
      });
    });

  const join = (socket: RawSocket, conversationId: string) =>
    emitAck(socket, 'conversation:join', { conversationId });

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

  const activeAssignments = (conversationId: string) =>
    prisma.conversationAssignment.count({ where: { conversationId, unassignedAt: null } });

  const eventCounts = async (conversationId: string) => {
    const events = await prisma.conversationEvent.findMany({
      where: { conversationId },
      orderBy: { id: 'asc' },
    });
    return {
      assigned: events.filter((e) => e.type === 'CONVERSATION_ASSIGNED').length,
      reassigned: events.filter((e) => e.type === 'CONVERSATION_REASSIGNED').length,
    };
  };

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
      data: { email: email('admin'), role: Role.ADMIN, passwordHash: hash, name: 'ASG Admin' },
    });
    for (const [name, label] of [
      ['agent-a', 'ASG Alice'],
      ['agent-b', 'ASG Bob'],
      ['agent-c', 'ASG Carol'],
      ['agent-off', 'ASG Offline'],
    ] as const) {
      await prisma.user.create({
        data: { email: email(name), role: Role.AGENT, passwordHash: hash, name: label },
      });
    }
    await prisma.user.update({
      where: { email: email('agent-off') },
      data: { isActive: false },
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
    agentCToken = await login('agent-c');

    adminId = (await prisma.user.findUniqueOrThrow({ where: { email: email('admin') } })).id;
    agentAId = (await prisma.user.findUniqueOrThrow({ where: { email: email('agent-a') } })).id;
    agentBId = (await prisma.user.findUniqueOrThrow({ where: { email: email('agent-b') } })).id;
    agentCId = (await prisma.user.findUniqueOrThrow({ where: { email: email('agent-c') } })).id;
    agentOffId = (await prisma.user.findUniqueOrThrow({ where: { email: email('agent-off') } })).id;

    const createSite = async (name: string, siteName?: string): Promise<TestWebsite> => {
      const res = await request(app.getHttpServer())
        .post('/api/websites')
        .set(staff(adminToken))
        .send({ name, domain: domain(siteName ?? name.toLowerCase().replace(/\s+/g, '-')) });
      expect(res.status).toBe(201);
      return res.body as TestWebsite;
    };
    siteA = await createSite('ASG Site A');
    siteB = await createSite('ASG Site B');
    siteC = await createSite('ASG Site C');

    const addMembership = async (userId: string, siteId: string): Promise<void> => {
      const res = await request(app.getHttpServer())
        .post(`/api/websites/${siteId}/memberships`)
        .set(staff(adminToken))
        .send({ userId });
      expect(res.status).toBe(201);
    };
    await addMembership(agentAId, siteA.id);
    await addMembership(agentBId, siteA.id);
    await addMembership(agentOffId, siteA.id);

    const init = async (site: TestWebsite, name: string): Promise<TestVisitor> => {
      const res = await request(app.getHttpServer())
        .post(`/api/public/websites/${site.publicKey}/visitor`)
        .send({ name });
      expect(res.status).toBe(201);
      return res.body as TestVisitor;
    };
    visitorA = await init(siteA, 'ASG Visitor A');
    visitorB = await init(siteB, 'ASG Visitor B');
    visitorC = await init(siteC, 'ASG Visitor C');

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
    convClaim = await createConversation(siteA, visitorA);
    convAssign = await createConversation(siteA, visitorA);
    convClosed = await createConversation(siteA, visitorA);
    convRace = await createConversation(siteA, visitorA);
    convRealtime = await createConversation(siteA, visitorA);
    convVisitor = await createConversation(siteA, visitorA);
    convForeign = await createConversation(siteB, visitorB);
    convDeact = await createConversation(siteC, visitorC);

    // Sites that need to degrade later in the suite.
    const deact = await request(app.getHttpServer())
      .patch(`/api/websites/${siteC.id}/deactivate`)
      .set(staff(adminToken))
      .send({});
    expect(deact.status).toBe(200);

    const close = await request(app.getHttpServer())
      .post(
        `/api/public/websites/${siteA.publicKey}/visitor/${visitorA.visitorKey}/conversations/${convClosed.id}/close`,
      )
      .send({});
    expect(close.status).toBe(200);
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

  // ------------------------------------------------------------- claim

  describe('claim', () => {
    it('assigns to the caller and records history plus the audit event', async () => {
      const res = await claim(siteA.id, convClaim.id, agentAToken);
      expect(res.status).toBe(200);

      const body = res.body as StaffConversation;
      expect(body.id).toBe(convClaim.id);
      expect(body.status).toBe('OPEN');
      expect(body.assignedAgent).toEqual({ id: agentAId, name: 'ASG Alice' });

      const rows = await prisma.conversationAssignment.findMany({
        where: { conversationId: convClaim.id },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.userId).toBe(agentAId);
      expect(rows[0]?.assignedById).toBe(agentAId);
      expect(rows[0]?.unassignedAt).toBeNull();

      const row = rows[0]!;
      const event = await prisma.conversationEvent.findFirst({
        where: { conversationId: convClaim.id, type: 'CONVERSATION_ASSIGNED' },
      });
      expect(event).toBeTruthy();
      expect(event?.actorUserId).toBe(agentAId);
      expect((event?.metadata as Record<string, unknown>).assignmentId).toBe(row.id);
      expect((event?.metadata as Record<string, unknown>).userId).toBe(agentAId);
      expect((event?.metadata as Record<string, unknown>).previousUserId).toBeNull();

      // Claiming never auto-PENDINGs an OPEN conversation; the widget's
      // conversation forgets nothing about assignment.
      const stored = await prisma.conversation.findUniqueOrThrow({
        where: { id: convClaim.id },
      });
      expect(stored.assignedAgentId).toBe(agentAId);
      expect(stored.status).toBe('OPEN');
    });

    it('surfaces the conversation in the staff list with its assignee', async () => {
      const res = await get(agentAToken, `/api/websites/${siteA.id}/conversations?limit=50`);
      expect(res.status).toBe(200);
      const row = (res.body as { data: StaffConversation[] }).data.find(
        (c) => c.id === convClaim.id,
      );
      expect(row?.assignedAgent).toEqual({ id: agentAId, name: 'ASG Alice' });
    });

    it('rejects a second claim while a conversation is already held', async () => {
      const res = await claim(siteA.id, convClaim.id, agentBToken);
      expect(res.status).toBe(409);
      expect(res.body.message).toBe('Conversation is already assigned');
      expect(await activeAssignments(convClaim.id)).toBe(1);
    });

    it('rejects assigning to the already-assigned agent (no-op reassign)', async () => {
      const res = await assign(siteA.id, convClaim.id, agentAId, agentBToken);
      expect(res.status).toBe(409);
      expect(res.body.message).toBe('Conversation is already assigned to this agent');
    });
  });

  describe('assign / reassign', () => {
    it('reassigns to another member and writes REASSIGNED with the previous assignee', async () => {
      const first = await claim(siteA.id, convAssign.id, agentAToken);
      expect(first.status).toBe(200);

      const res = await assign(siteA.id, convAssign.id, agentBId, agentAToken);
      expect(res.status).toBe(200);
      const body = res.body as StaffConversation;
      expect(body.assignedAgent).toEqual({ id: agentBId, name: 'ASG Bob' });

      const rows = await prisma.conversationAssignment.findMany({
        where: { conversationId: convAssign.id },
        orderBy: { assignedAt: 'asc' },
      });
      expect(rows).toHaveLength(2);
      expect(rows[0]?.userId).toBe(agentAId);
      expect(rows[0]?.unassignedAt).not.toBeNull();
      expect(rows[1]?.userId).toBe(agentBId);
      expect(rows[1]?.unassignedAt).toBeNull();

      const reassigned = await prisma.conversationEvent.findFirst({
        where: { conversationId: convAssign.id, type: 'CONVERSATION_REASSIGNED' },
      });
      expect(reassigned).toBeTruthy();
      expect((reassigned?.metadata as Record<string, unknown>).previousUserId).toBe(agentAId);
      expect((reassigned?.metadata as Record<string, unknown>).userId).toBe(agentBId);
    });

    it('serves the append-only history with active flags', async () => {
      const res = await history(siteA.id, convAssign.id, agentAToken);
      expect(res.status).toBe(200);
      const entries = res.body as ConversationAssignmentEntry[];
      expect(entries).toHaveLength(2);
      expect(entries[0]?.active).toBe(true);
      expect(entries[0]?.userId).toBe(agentBId);
      expect(entries[1]?.active).toBe(false);
      expect(entries[1]?.user).toEqual({
        id: agentAId,
        name: 'ASG Alice',
        email: email('agent-a'),
      });
    });
  });

  // -------------------------------------------------- assignee validation

  describe('assignee eligibility', () => {
    it('rejects an assignee who does not exist', async () => {
      const res = await assign(siteA.id, convAssign.id, crypto.randomUUID(), adminToken);
      expect(res.status).toBe(404);
      expect(res.body.message).toBe('Assignee not found');
    });

    it('rejects a deactivated assignee even with an active membership', async () => {
      const res = await assign(siteA.id, convAssign.id, agentOffId, adminToken);
      expect(res.status).toBe(400);
      expect(res.body.message).toBe('Assignee is deactivated');
    });

    it('rejects an active agent without a membership for this website', async () => {
      const res = await assign(siteA.id, convAssign.id, agentCId, adminToken);
      expect(res.status).toBe(400);
      expect(res.body.message).toBe('Assignee is not a member of this website');
    });

    it('allows a platform ADMIN without a membership', async () => {
      const res = await assign(siteA.id, convAssign.id, adminId, agentAToken);
      expect(res.status).toBe(200);
      expect((res.body as StaffConversation).assignedAgent).toEqual({
        id: adminId,
        name: 'ASG Admin',
      });
      const rows = await prisma.conversationAssignment.findMany({
        where: { conversationId: convAssign.id },
        orderBy: { assignedAt: 'desc' },
        take: 1,
      });
      expect(rows[0]?.userId).toBe(adminId);
    });

    it('lists only active, reachable staff for the agent picker', async () => {
      const res = await get(agentAToken, `/api/websites/${siteA.id}/assignable`);
      expect(res.status).toBe(200);
      const agents = res.body as PublicUser[];
      const ids = agents.map((a) => a.id);
      // Site members plus every active ADMIN (bootstrap + this suite's admin).
      expect(ids).toEqual(expect.arrayContaining([adminId, agentAId, agentBId]));
      expect(ids).not.toContain(agentCId);
      expect(ids).not.toContain(agentOffId);
    });
  });

  // ----------------------------------------------- closed / deactivated

  describe('closed and deactivated edge cases', () => {
    it('rejects claims on a closed conversation and persists nothing', async () => {
      const res = await claim(siteA.id, convClosed.id, agentAToken);
      expect(res.status).toBe(409);
      expect(res.body.message).toBe('Conversation is closed');
      expect(await activeAssignments(convClosed.id)).toBe(0);
      const events = await prisma.conversationEvent.count({
        where: { conversationId: convClosed.id, type: 'CONVERSATION_ASSIGNED' },
      });
      expect(events).toBe(0);
    });

    it('rejects assignments on a closed conversation', async () => {
      const res = await assign(siteA.id, convClosed.id, agentBId, agentAToken);
      expect(res.status).toBe(409);
      expect(res.body.message).toBe('Conversation is closed');
    });

    it('rejects claims on a deactivated website', async () => {
      const res = await claim(siteC.id, convDeact.id, adminToken);
      expect(res.status).toBe(403);
      expect(res.body.message).toBe('Website is deactivated');
    });

    it('hides foreign tenants behind FORBIDDEN for non-members', async () => {
      const res = await claim(siteB.id, convForeign.id, agentAToken);
      expect(res.status).toBe(403);
    });

    it('hides entire websites from non-member agents', async () => {
      const res = await claim(siteA.id, convClaim.id, agentCToken);
      expect(res.status).toBe(403);
    });
  });

  describe('concurrency and realtime', () => {
    it('serializes concurrent claims so only one succeeds', async () => {
      const [a, b] = await Promise.all([
        claim(siteA.id, convRace.id, agentAToken),
        claim(siteA.id, convRace.id, agentBToken),
      ]);

      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([200, 409]);

      expect(await activeAssignments(convRace.id)).toBe(1);
      const counts = await eventCounts(convRace.id);
      expect(counts.assigned).toBe(1);

      const winner = await prisma.conversationAssignment.findFirst({
        where: { conversationId: convRace.id },
      });
      expect(winner?.unassignedAt).toBeNull();
    });

    it('fans the assignment out to joined staff and the website inbox but never to the visitor', async () => {
      const staffSocket = await openSocket({ token: agentBToken });
      const visitorSocket = await openSocket({
        publicKey: siteA.publicKey,
        visitorKey: visitorA.visitorKey,
      });
      expect((await join(staffSocket, convRealtime.id)).ok).toBe(true);
      expect((await join(visitorSocket, convRealtime.id)).ok).toBe(true);

      // A same-website agent who never joined this conversation still hears
      // via the website staff inbox room (auto-joined at connection).
      const inboxSocket = await openSocket({ token: agentBToken });
      const delivered = waitForEvent<ConversationAssignedEvent>(
        staffSocket,
        'conversation:assigned',
        (payload) => payload.conversationId === convRealtime.id,
      );
      const inboxDelivered = waitForEvent<ConversationAssignedEvent>(
        inboxSocket,
        'conversation:assigned',
        (payload) => payload.conversationId === convRealtime.id,
      );

      const res = await claim(siteA.id, convRealtime.id, agentAToken);
      expect(res.status).toBe(200);

      const event = await delivered;
      expect(event.assignedAgent).toEqual({ id: agentAId, name: 'ASG Alice' });
      expect((await inboxDelivered).assignedAgent).toEqual(event.assignedAgent);

      // The visitor shares the conversation room yet never hears about the agent.
      expect(await expectNoEvent(visitorSocket, 'conversation:assigned')).toBe(true);

      // Staff of a *different* website are not in this website's staff room.
      const bystander = await openSocket({ token: agentCToken });
      expect(await expectNoEvent(bystander, 'conversation:assigned')).toBe(true);
    });

    it('leaves visitor messaging intact after an assignment', async () => {
      await claim(siteA.id, convVisitor.id, agentAToken);

      const staffSocket = await openSocket({ token: agentAToken });
      const visitorSocket = await openSocket({
        publicKey: siteA.publicKey,
        visitorKey: visitorA.visitorKey,
      });
      expect((await join(staffSocket, convVisitor.id)).ok).toBe(true);
      expect((await join(visitorSocket, convVisitor.id)).ok).toBe(true);

      const delivered = waitForEvent<any>(
        staffSocket,
        'message:new',
        (payload) => payload.conversationId === convVisitor.id,
      );

      const ackDone = new Promise<{ ok: boolean; message: { id: string; content: string } }>(
        (resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('no ack for message:send')), 4000);
          visitorSocket.emit(
            'message:send',
            { conversationId: convVisitor.id, content: 'Visitor after assignment' },
            (result: any) => {
              clearTimeout(timer);
              resolve(result as { ok: boolean; message: { id: string; content: string } });
            },
          );
        },
      );

      const acked = await ackDone;
      expect(acked.ok).toBe(true);
      const event = await delivered;
      expect(event.message.content).toBe('Visitor after assignment');
    });
  });
});
