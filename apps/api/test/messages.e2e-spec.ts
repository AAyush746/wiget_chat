import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConversationEventType, ConversationStatus, MessageSender, Role } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { MAX_MESSAGE_LENGTH } from '../src/conversations/dto/create-message.dto';
import { PrismaService } from '../src/prisma/prisma.service';
import { PasswordService } from '../src/security/password.service';

const TAG = 'phase5-messages';
const TEST_DOMAIN = 'chatflow.test';
const PASSWORD = 'Passw0rd123';

const email = (name: string): string => `${name}-${TAG}@${TEST_DOMAIN}`;
const domain = (name: string): string => `${name}-${TAG}.${TEST_DOMAIN}`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

interface SendResult {
  message: {
    id: string;
    conversationId: string;
    senderType: string;
    senderName: string | null;
    content: string;
    clientMessageId: string | null;
    createdAt: string;
  };
  replay: boolean;
}

interface MessagePage {
  data: SendResult['message'][];
  nextCursor: string | null;
  limit: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('Phase 5a: message persistence REST API (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let adminToken: string;
  let agentAToken: string;
  let agentBToken: string;

  let siteA: TestWebsite;
  let siteB: TestWebsite;
  let visitorA: TestVisitor;
  let visitorA2: TestVisitor;
  let visitorB: TestVisitor;

  let convA: TestConversation; // siteA + visitorA (agentA has membership)
  let convB: TestConversation; // siteB + visitorB (agentA has none)
  let convClosed: TestConversation;
  let convPendingVisitor: TestConversation;
  let convPendingAgent: TestConversation;
  let convPaging: TestConversation;
  let convInactive: TestConversation;

  const server = () => app.getHttpServer();

  const websiteFilter = { domain: { endsWith: `-${TAG}.${TEST_DOMAIN}` } };

  const cleanup = async (): Promise<void> => {
    const siteIds = (
      await prisma.website.findMany({ where: websiteFilter, select: { id: true } })
    ).map((w) => w.id);

    // Messages and events cascade with their conversations.
    await prisma.conversation.deleteMany({ where: { websiteId: { in: siteIds } } });
    await prisma.visitor.deleteMany({ where: { websiteId: { in: siteIds } } });
    await prisma.websiteMembership.deleteMany({ where: { websiteId: { in: siteIds } } });
    await prisma.website.deleteMany({ where: { id: { in: siteIds } } });
    await prisma.user.deleteMany({ where: { email: { endsWith: `@${TEST_DOMAIN}` } } });
  };

  const publicHeaders = (publicKey: string, visitorKey: string) =>
    `/api/public/websites/${publicKey}/visitor/${visitorKey}/conversations`;

  const visitorSend = (
    publicKey: string,
    visitorKey: string,
    conversationId: string,
    body: Record<string, unknown>,
  ) =>
    request(server())
      .post(`${publicHeaders(publicKey, visitorKey)}/${conversationId}/messages`)
      .send(body);

  const visitorHistory = (
    publicKey: string,
    visitorKey: string,
    conversationId: string,
    query = '',
  ) =>
    request(server()).get(
      `${publicHeaders(publicKey, visitorKey)}/${conversationId}/messages${query}`,
    );

  const staffHistory = (websiteId: string, conversationId: string, token: string, query = '') =>
    request(server())
      .get(`/api/websites/${websiteId}/conversations/${conversationId}/messages${query}`)
      .set('Authorization', `Bearer ${token}`);

  const staffSend = (
    websiteId: string,
    conversationId: string,
    token: string,
    body: Record<string, unknown>,
  ) =>
    request(server())
      .post(`/api/websites/${websiteId}/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    prisma = app.get(PrismaService);
    const password = app.get(PasswordService);
    await cleanup();

    const hash = await password.hash(PASSWORD);
    await prisma.user.create({
      data: { email: email('admin'), role: Role.ADMIN, passwordHash: hash, name: 'P5 Admin' },
    });
    await prisma.user.create({
      data: { email: email('agent-a'), role: Role.AGENT, passwordHash: hash, name: 'P5 Alice' },
    });
    await prisma.user.create({
      data: { email: email('agent-b'), role: Role.AGENT, passwordHash: hash, name: 'P5 Bob' },
    });

    const login = async (name: string): Promise<string> => {
      const res = await request(server())
        .post('/api/auth/login')
        .send({ email: email(name), password: PASSWORD });
      expect(res.status).toBe(200);
      return res.body.accessToken as string;
    };
    adminToken = await login('admin');
    agentAToken = await login('agent-a');
    agentBToken = await login('agent-b');

    const createSite = async (name: string): Promise<TestWebsite> => {
      const res = await request(server())
        .post('/api/websites')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name, domain: domain(name.toLowerCase().replace(/\s+/g, '-')) });
      expect(res.status).toBe(201);
      return res.body as TestWebsite;
    };
    siteA = await createSite('P5 Site A');
    siteB = await createSite('P5 Site B');

    const membership = await request(server())
      .post(`/api/websites/${siteA.id}/memberships`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        userId: (await prisma.user.findUniqueOrThrow({ where: { email: email('agent-a') } })).id,
      });
    expect(membership.status).toBe(201);

    const init = async (site: TestWebsite, name?: string): Promise<TestVisitor> => {
      const res = await request(server())
        .post(`/api/public/websites/${site.publicKey}/visitor`)
        .send(name ? { name } : {});
      expect(res.status).toBe(201);
      return res.body as TestVisitor;
    };
    visitorA = await init(siteA, 'Visitor A');
    visitorA2 = await init(siteA, 'Visitor A2');
    visitorB = await init(siteB, 'Visitor B');

    const createConversation = async (
      site: TestWebsite,
      visitor: TestVisitor,
    ): Promise<TestConversation> => {
      const res = await request(server())
        .post(`/api/public/websites/${site.publicKey}/conversations`)
        .send({ visitorKey: visitor.visitorKey });
      expect(res.status).toBe(201);
      return res.body as TestConversation;
    };
    convA = await createConversation(siteA, visitorA);
    convB = await createConversation(siteB, visitorB);
    convClosed = await createConversation(siteA, visitorA);
    convPendingVisitor = await createConversation(siteA, visitorA);
    convPendingAgent = await createConversation(siteA, visitorA);
    convPaging = await createConversation(siteA, visitorA);
    convInactive = await createConversation(siteA, visitorA);
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  // ----------------------------------------------------------------- create

  describe('message creation', () => {
    it('persists a visitor message with actor, event and lastMessageAt', async () => {
      const res = await visitorSend(siteA.publicKey, visitorA.visitorKey, convA.id, {
        content: 'Hello, I need help with my order',
      });

      expect(res.status).toBe(201);
      const body = res.body as SendResult;
      expect(body.replay).toBe(false);
      expect(body.message.id).toMatch(UUID_RE);
      expect(body.message.senderType).toBe(MessageSender.VISITOR);
      expect(body.message.senderName).toBe('Visitor A');
      expect(body.message.clientMessageId).toBeNull();

      const row = await prisma.message.findUniqueOrThrow({
        where: { id: body.message.id },
      });
      expect(row.conversationId).toBe(convA.id);
      expect(row.visitorId).toBeTruthy();
      expect(row.userId).toBeNull();
      expect(row.content).toBe('Hello, I need help with my order');

      const event = await prisma.conversationEvent.findFirst({
        where: { conversationId: convA.id, type: ConversationEventType.MESSAGE_SENT },
      });
      expect(event).not.toBeNull();
      expect(event?.websiteId).toBe(siteA.id);
      expect(event?.actorVisitorId).toBe(row.visitorId);
      expect((event?.metadata as { messageId?: string })?.messageId).toBe(body.message.id);

      const conversation = await prisma.conversation.findUniqueOrThrow({
        where: { id: convA.id },
      });
      expect(conversation.lastMessageAt?.toISOString()).toBe(row.createdAt.toISOString());
      expect(conversation.status).toBe(ConversationStatus.OPEN);
    });

    it('persists an agent reply with the JWT identity as sender', async () => {
      await sleep(3);
      const res = await staffSend(siteA.id, convA.id, agentAToken, {
        content: 'Hi! Looking into it now.',
      });

      expect(res.status).toBe(201);
      const body = res.body as SendResult;
      expect(body.message.senderType).toBe(MessageSender.AGENT);
      expect(body.message.senderName).toBe('P5 Alice');

      const row = await prisma.message.findUniqueOrThrow({ where: { id: body.message.id } });
      expect(row.userId).toBeTruthy();
      expect(row.visitorId).toBeNull();
    });

    it('derives sender server-side and rejects client-supplied identity fields', async () => {
      const res = await visitorSend(siteA.publicKey, visitorA.visitorKey, convA.id, {
        content: 'I am definitely an agent',
        senderType: 'AGENT',
        userId: 'someone-else',
        websiteId: siteB.id,
      });

      expect(res.status).toBe(400);
      const rows = await prisma.message.count({
        where: { conversationId: convA.id, content: 'I am definitely an agent' },
      });
      expect(rows).toBe(0);
    });

    it('rejects empty, whitespace-only, oversized and wrong-typed content', async () => {
      const cases: Record<string, unknown>[] = [{ content: '' }, { content: '   \n\t  ' }];
      for (const body of cases) {
        const res = await visitorSend(siteA.publicKey, visitorA.visitorKey, convA.id, body);
        expect(res.status).toBe(400);
      }

      const oversized = await visitorSend(siteA.publicKey, visitorA.visitorKey, convA.id, {
        content: 'x'.repeat(MAX_MESSAGE_LENGTH + 1),
      });
      expect(oversized.status).toBe(400);

      const wrongType = await visitorSend(siteA.publicKey, visitorA.visitorKey, convA.id, {
        content: 12345,
      });
      expect(wrongType.status).toBe(400);

      const badId = await visitorSend(siteA.publicKey, visitorA.visitorKey, 'not-a-uuid', {
        content: 'hi',
      });
      expect(badId.status).toBe(400);
    });

    it('accepts the exact maximum content length without truncating', async () => {
      const content = 'y'.repeat(MAX_MESSAGE_LENGTH);
      const res = await visitorSend(siteA.publicKey, visitorA.visitorKey, convA.id, { content });
      expect(res.status).toBe(201);
      expect((res.body as SendResult).message.content).toBe(content);
      expect((res.body as SendResult).message.content.length).toBe(MAX_MESSAGE_LENGTH);
    });

    it('rejects messages on a closed conversation (visitor and staff)', async () => {
      const close = await request(server())
        .post(`${publicHeaders(siteA.publicKey, visitorA.visitorKey)}/${convClosed.id}/close`)
        .send({});
      expect(close.status).toBe(200);

      const visitorAttempt = await visitorSend(
        siteA.publicKey,
        visitorA.visitorKey,
        convClosed.id,
        {
          content: 'one more thing',
        },
      );
      expect(visitorAttempt.status).toBe(409);

      const staffAttempt = await staffSend(siteA.id, convClosed.id, agentAToken, {
        content: 'closing remarks',
      });
      expect(staffAttempt.status).toBe(409);

      // History stays readable after close.
      const history = await visitorHistory(siteA.publicKey, visitorA.visitorKey, convClosed.id);
      expect(history.status).toBe(200);
      expect((history.body as MessagePage).data).toHaveLength(0);
    });

    it('reopens PENDING on a visitor message but leaves it PENDING for an agent', async () => {
      await prisma.conversation.update({
        where: { id: convPendingVisitor.id },
        data: { status: ConversationStatus.PENDING },
      });
      await prisma.conversation.update({
        where: { id: convPendingAgent.id },
        data: { status: ConversationStatus.PENDING },
      });

      const visitorReply = await visitorSend(
        siteA.publicKey,
        visitorA.visitorKey,
        convPendingVisitor.id,
        { content: 'I am back' },
      );
      expect(visitorReply.status).toBe(201);
      const reopened = await prisma.conversation.findUniqueOrThrow({
        where: { id: convPendingVisitor.id },
      });
      expect(reopened.status).toBe(ConversationStatus.OPEN);

      const agentReply = await staffSend(siteA.id, convPendingAgent.id, agentAToken, {
        content: 'Still waiting on your screenshot',
      });
      expect(agentReply.status).toBe(201);
      const stillPending = await prisma.conversation.findUniqueOrThrow({
        where: { id: convPendingAgent.id },
      });
      expect(stillPending.status).toBe(ConversationStatus.PENDING);
    });
  });

  // ----------------------------------------------------------- authorization

  describe('authorization and tenant isolation', () => {
    it('visitor can only touch conversations they own', async () => {
      // visitorA2 owns nothing on convA.
      const send = await visitorSend(siteA.publicKey, visitorA2.visitorKey, convA.id, {
        content: 'not mine',
      });
      expect(send.status).toBe(404);

      const read = await visitorHistory(siteA.publicKey, visitorA2.visitorKey, convA.id);
      expect(read.status).toBe(404);

      // visitorB on site B probing convA.
      const crossSend = await visitorSend(siteB.publicKey, visitorB.visitorKey, convA.id, {
        content: 'other tenant',
      });
      expect(crossSend.status).toBe(404);
    });

    it('a member agent reads and writes their own website only', async () => {
      const allowed = await staffHistory(siteA.id, convA.id, agentAToken);
      expect(allowed.status).toBe(200);

      // convB lives on siteB: foreign conversation inside the caller's
      // website path is an indistinguishable 404.
      const crossRead = await staffHistory(siteA.id, convB.id, agentAToken);
      expect(crossRead.status).toBe(404);
      const crossWrite = await staffSend(siteA.id, convB.id, agentAToken, { content: 'peek' });
      expect(crossWrite.status).toBe(404);
    });

    it('an agent without membership is rejected (403) on read and write', async () => {
      const read = await staffHistory(siteA.id, convA.id, agentBToken);
      expect(read.status).toBe(403);
      const write = await staffSend(siteA.id, convA.id, agentBToken, { content: 'hello?' });
      expect(write.status).toBe(403);
    });

    it('unauthenticated staff requests are rejected (401)', async () => {
      const read = await request(server()).get(
        `/api/websites/${siteA.id}/conversations/${convA.id}/messages`,
      );
      expect(read.status).toBe(401);
      const write = await request(server())
        .post(`/api/websites/${siteA.id}/conversations/${convA.id}/messages`)
        .send({ content: 'anon' });
      expect(write.status).toBe(401);
    });

    it('rejects messaging on a deactivated website (staff 403, visitor 404)', async () => {
      const deactivate = await request(server())
        .patch(`/api/websites/${siteB.id}/deactivate`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(deactivate.status).toBe(200);

      // ADMIN passes the membership guard implicitly, then the write is
      // rejected by the messaging layer itself.
      const staffAttempt = await staffSend(siteB.id, convB.id, adminToken, { content: 'nope' });
      expect(staffAttempt.status).toBe(403);
      expect(staffAttempt.body.message).toBe('Website is deactivated');

      // Reads stay open for staff (Phase 4 policy)...
      const staffRead = await staffHistory(siteB.id, convB.id, adminToken);
      expect(staffRead.status).toBe(200);

      // ...while the public side is an indistinguishable 404.
      const visitorAttempt = await visitorSend(siteB.publicKey, visitorB.visitorKey, convB.id, {
        content: 'nope',
      });
      expect(visitorAttempt.status).toBe(404);

      const reactivate = await request(server())
        .patch(`/api/websites/${siteB.id}/reactivate`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(reactivate.status).toBe(200);
    });
  });

  // --------------------------------------------------------------- history

  describe('history, ordering and cursor pagination', () => {
    const contents = ['m1', 'm2', 'm3', 'm4', 'm5'];

    it('returns messages in ascending chronological order with cursor paging', async () => {
      for (const content of contents) {
        const res = await visitorSend(siteA.publicKey, visitorA.visitorKey, convPaging.id, {
          content,
        });
        expect(res.status).toBe(201);
        await sleep(3); // keep millisecond timestamps distinct so insertion order == time order
      }

      const page1 = await visitorHistory(
        siteA.publicKey,
        visitorA.visitorKey,
        convPaging.id,
        '?limit=2',
      );
      expect(page1.status).toBe(200);
      const p1 = page1.body as MessagePage;
      expect(p1.data.map((m) => m.content)).toEqual(['m4', 'm5']);
      expect(p1.nextCursor).toBeTruthy();
      expect(p1.limit).toBe(2);

      const page2 = await visitorHistory(
        siteA.publicKey,
        visitorA.visitorKey,
        convPaging.id,
        `?limit=2&before=${encodeURIComponent(p1.nextCursor as string)}`,
      );
      expect(page2.status).toBe(200);
      const p2 = page2.body as MessagePage;
      expect(p2.data.map((m) => m.content)).toEqual(['m2', 'm3']);
      expect(p2.nextCursor).toBeTruthy();

      const page3 = await visitorHistory(
        siteA.publicKey,
        visitorA.visitorKey,
        convPaging.id,
        `?limit=2&before=${encodeURIComponent(p2.nextCursor as string)}`,
      );
      expect(page3.status).toBe(200);
      const p3 = page3.body as MessagePage;
      expect(p3.data.map((m) => m.content)).toEqual(['m1']);
      expect(p3.nextCursor).toBeNull();
    });

    it('staff history matches the visitor view for the same conversation', async () => {
      const res = await staffHistory(siteA.id, convPaging.id, agentAToken, '?limit=100');
      expect(res.status).toBe(200);
      const page = res.body as MessagePage;
      expect(page.data.map((m) => m.content)).toEqual(contents);
      expect(page.data.every((m) => m.senderName !== undefined)).toBe(true);
    });

    it('validates pagination parameters', async () => {
      const badCursor = await visitorHistory(
        siteA.publicKey,
        visitorA.visitorKey,
        convPaging.id,
        '?before=@@not-a-cursor@@',
      );
      expect(badCursor.status).toBe(400);

      const garbageCursor = await visitorHistory(
        siteA.publicKey,
        visitorA.visitorKey,
        convPaging.id,
        `?before=${Buffer.from('definitely|not-a-uuid').toString('base64url')}`,
      );
      expect(garbageCursor.status).toBe(400);

      const zeroLimit = await visitorHistory(
        siteA.publicKey,
        visitorA.visitorKey,
        convPaging.id,
        '?limit=0',
      );
      expect(zeroLimit.status).toBe(400);

      const hugeLimit = await visitorHistory(
        siteA.publicKey,
        visitorA.visitorKey,
        convPaging.id,
        '?limit=101',
      );
      expect(hugeLimit.status).toBe(400);
    });
  });

  // ------------------------------------------------------------- idempotency

  describe('idempotent retries', () => {
    it('returns the original message for a duplicated clientMessageId', async () => {
      const clientMessageId = crypto.randomUUID();
      const first = await visitorSend(siteA.publicKey, visitorA.visitorKey, convA.id, {
        content: 'sent once',
        clientMessageId,
      });
      expect(first.status).toBe(201);
      expect((first.body as SendResult).replay).toBe(false);

      const retry = await visitorSend(siteA.publicKey, visitorA.visitorKey, convA.id, {
        content: 'sent once (retry with different text)',
        clientMessageId,
      });
      expect(retry.status).toBe(201);
      const retryBody = retry.body as SendResult;
      expect(retryBody.replay).toBe(true);
      expect(retryBody.message.id).toBe((first.body as SendResult).message.id);
      expect(retryBody.message.content).toBe('sent once');

      const rows = await prisma.message.count({
        where: { conversationId: convA.id, clientMessageId },
      });
      expect(rows).toBe(1);

      // The retry resolved to the original row: exactly one audit event for it,
      // no duplicate MESSAGE_SENT emitted for the replay.
      const events = await prisma.conversationEvent.findMany({
        where: { conversationId: convA.id, type: ConversationEventType.MESSAGE_SENT },
      });
      const forThisMessage = events.filter(
        (e) => (e.metadata as { messageId?: string })?.messageId === retryBody.message.id,
      );
      expect(forThisMessage).toHaveLength(1);
    });

    it('collapses concurrent retries carrying the same key into one row', async () => {
      const clientMessageId = crypto.randomUUID();
      const bodies = { content: 'concurrent send', clientMessageId };

      const [a, b] = await Promise.all([
        visitorSend(siteA.publicKey, visitorA.visitorKey, convA.id, bodies),
        visitorSend(siteA.publicKey, visitorA.visitorKey, convA.id, bodies),
      ]);

      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
      expect((a.body as SendResult).message.id).toBe((b.body as SendResult).message.id);

      const rows = await prisma.message.count({
        where: { conversationId: convA.id, clientMessageId },
      });
      expect(rows).toBe(1);
    });

    it('rejects a malformed clientMessageId', async () => {
      const res = await visitorSend(siteA.publicKey, visitorA.visitorKey, convA.id, {
        content: 'hi',
        clientMessageId: 'not-a-uuid',
      });
      expect(res.status).toBe(400);
    });

    it('refuses an agent adopting a visitor message under the same clientMessageId (409)', async () => {
      const clientMessageId = crypto.randomUUID();
      const original = await visitorSend(siteA.publicKey, visitorA.visitorKey, convA.id, {
        content: 'visitor original',
        clientMessageId,
      });
      expect(original.status).toBe(201);

      const attempt = await staffSend(siteA.id, convA.id, agentAToken, {
        content: 'agent replacement',
        clientMessageId,
      });
      expect(attempt.status).toBe(409);
      expect(attempt.body.message).toBe('clientMessageId is already in use');

      // The visitor's message is untouched and not adopted: one row, original
      // content, still a visitor message.
      const rows = await prisma.message.count({
        where: { conversationId: convA.id, clientMessageId },
      });
      expect(rows).toBe(1);
      const row = await prisma.message.findFirstOrThrow({
        where: { conversationId: convA.id, clientMessageId },
      });
      expect(row.content).toBe('visitor original');
      expect(row.senderType).toBe(MessageSender.VISITOR);
      expect(row.userId).toBeNull();
    });

    it('refuses a visitor adopting an agent message under the same clientMessageId (409)', async () => {
      const clientMessageId = crypto.randomUUID();
      const original = await staffSend(siteA.id, convA.id, agentAToken, {
        content: 'agent original',
        clientMessageId,
      });
      expect(original.status).toBe(201);

      const attempt = await visitorSend(siteA.publicKey, visitorA.visitorKey, convA.id, {
        content: 'visitor replacement',
        clientMessageId,
      });
      expect(attempt.status).toBe(409);
      expect(attempt.body.message).toBe('clientMessageId is already in use');

      const rows = await prisma.message.count({
        where: { conversationId: convA.id, clientMessageId },
      });
      expect(rows).toBe(1);
      const row = await prisma.message.findFirstOrThrow({
        where: { conversationId: convA.id, clientMessageId },
      });
      expect(row.content).toBe('agent original');
      expect(row.senderType).toBe(MessageSender.AGENT);
      expect(row.visitorId).toBeNull();
    });

    it('resolves a concurrent same-key race between different principals to one message + one conflict', async () => {
      const clientMessageId = crypto.randomUUID();
      const [visitor, agent] = await Promise.all([
        visitorSend(siteA.publicKey, visitorA.visitorKey, convA.id, {
          content: 'visitor in the race',
          clientMessageId,
        }),
        staffSend(siteA.id, convA.id, agentAToken, {
          content: 'agent in the race',
          clientMessageId,
        }),
      ]);

      const loser = [visitor, agent].filter((r) => r.status === 409);
      const winner = [visitor, agent].filter((r) => r.status === 201);
      expect(loser).toHaveLength(1);
      expect(winner).toHaveLength(1);
      expect(loser[0]?.body.message).toBe('clientMessageId is already in use');

      // Exactly one message ever wins the key.
      const rows = await prisma.message.count({
        where: { conversationId: convA.id, clientMessageId },
      });
      expect(rows).toBe(1);

      const row = await prisma.message.findFirstOrThrow({
        where: { conversationId: convA.id, clientMessageId },
      });
      expect(['visitor in the race', 'agent in the race']).toContain(row.content);

      // One winner => one audit event, attributed to the actual winner.
      const events = await prisma.conversationEvent.findMany({
        where: { conversationId: convA.id, type: ConversationEventType.MESSAGE_SENT },
      });
      expect(
        events.filter((e) => (e.metadata as { messageId?: string })?.messageId === row.id),
      ).toHaveLength(1);
    });
  });

  // ------------------------------------------------------------ rate limits

  describe('rate limiting', () => {
    it('limits public message sends per IP + website (429)', async () => {
      // A fresh website gets its own bucket (key: ip + publicKey), so the
      // sends from earlier tests never count against this flood.
      const siteRes = await request(server())
        .post('/api/websites')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'P5 Flood Site', domain: domain('p5-flood') });
      expect(siteRes.status).toBe(201);
      const floodSite = siteRes.body as TestWebsite;

      const visitorRes = await request(server())
        .post(`/api/public/websites/${floodSite.publicKey}/visitor`)
        .send({});
      expect(visitorRes.status).toBe(201);
      const floodVisitor = visitorRes.body as TestVisitor;

      const convRes = await request(server())
        .post(`/api/public/websites/${floodSite.publicKey}/conversations`)
        .send({ visitorKey: floodVisitor.visitorKey });
      expect(convRes.status).toBe(201);
      const floodConv = convRes.body as TestConversation;

      let sawLimit = false;
      // Default bucket: 60 sends / 60s — the 61st must be rejected.
      for (let i = 0; i < 70 && !sawLimit; i += 1) {
        const res = await visitorSend(floodSite.publicKey, floodVisitor.visitorKey, floodConv.id, {
          content: `flood ${i}`,
        });
        if (res.status === 429) {
          sawLimit = true;
          break;
        }
        expect(res.status).toBe(201);
      }
      expect(sawLimit).toBe(true);
    }, 30_000);
  });
});
