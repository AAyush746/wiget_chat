import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConversationStatus, Role } from '@prisma/client';
import type { AuthUser, StaffConversation } from '@chatflow/types';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { PasswordService } from '../src/security/password.service';

const TAG = 'phase6-dash';
const TEST_DOMAIN = 'chatflow.test';
const PASSWORD = 'Passw0rd123';

const email = (name: string): string => `${name}-${TAG}@${TEST_DOMAIN}`;
const domain = (name: string): string => `${name}-${TAG}.${TEST_DOMAIN}`;

interface TestWebsite {
  id: string;
  publicKey: string;
  name: string;
  isActive: boolean;
}
interface TestVisitor {
  visitorKey: string;
}

describe('Phase 6: dashboard backend contracts (accessible websites, inbox preview, staff close)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let adminToken: string;
  let agentToken: string;

  let siteA: TestWebsite;
  let siteB: TestWebsite;
  let siteC: TestWebsite;
  let visitorA: TestVisitor;

  const server = () => app.getHttpServer();

  const cleanup = async (): Promise<void> => {
    const siteIds = (
      await prisma.website.findMany({
        where: { domain: { endsWith: `-${TAG}.${TEST_DOMAIN}` } },
        select: { id: true },
      })
    ).map((w) => w.id);

    await prisma.conversation.deleteMany({ where: { websiteId: { in: siteIds } } });
    await prisma.visitor.deleteMany({ where: { websiteId: { in: siteIds } } });
    await prisma.websiteMembership.deleteMany({ where: { websiteId: { in: siteIds } } });
    await prisma.website.deleteMany({ where: { id: { in: siteIds } } });
    await prisma.user.deleteMany({ where: { email: { endsWith: `@${TEST_DOMAIN}` } } });
  };

  const createWebsite = (body: Record<string, unknown>, token: string = adminToken) =>
    request(server()).post('/api/websites').set('Authorization', `Bearer ${token}`).send(body);

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
      data: { email: email('admin'), name: 'P6 Admin', role: Role.ADMIN, passwordHash: hash },
    });
    await prisma.user.create({
      data: { email: email('agent'), name: 'P6 Agent', role: Role.AGENT, passwordHash: hash },
    });

    const login = async (name: string): Promise<string> => {
      const res = await request(server())
        .post('/api/auth/login')
        .send({ email: email(name), password: PASSWORD });
      expect(res.status).toBe(200);
      return res.body.accessToken as string;
    };
    adminToken = await login('admin');
    agentToken = await login('agent');

    siteA = (await createWebsite({ name: 'Site A', domain: domain('site-a') })).body as TestWebsite;
    siteB = (await createWebsite({ name: 'Site B', domain: domain('site-b') })).body as TestWebsite;
    siteC = (await createWebsite({ name: 'Site C', domain: domain('site-c') })).body as TestWebsite;

    // agent is a member of siteA only.
    const agentId = (await prisma.user.findUniqueOrThrow({ where: { email: email('agent') } })).id;
    const membership = await request(server())
      .post(`/api/websites/${siteA.id}/memberships`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ userId: agentId });
    expect(membership.status).toBe(201);

    // A second, deactivated membership must not leak siteC to the agent.
    const second = await request(server())
      .post(`/api/websites/${siteC.id}/memberships`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ userId: agentId });
    expect(second.status).toBe(201);
    const ma = await prisma.websiteMembership.findFirstOrThrow({
      where: { userId: agentId, websiteId: siteC.id },
    });
    await request(server())
      .patch(`/api/websites/${siteC.id}/memberships/${ma.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ isActive: false });

    // A visitor on siteA with a conversation, later given one message.
    const init = await request(server())
      .post(`/api/public/websites/${siteA.publicKey}/visitor`)
      .send({ name: 'P6 Visitor' });
    expect(init.status).toBe(201);
    visitorA = init.body as TestVisitor;
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  // -------------------------------------------------- my accessible websites

  describe('GET /api/me/websites', () => {
    it('rejects unauthenticated callers (401)', async () => {
      const res = await request(server()).get('/api/me/websites');
      expect(res.status).toBe(401);
    });

    it('lists only websites where an AGENT has an active membership', async () => {
      const res = await request(server())
        .get('/api/me/websites')
        .set('Authorization', `Bearer ${agentToken}`);
      expect(res.status).toBe(200);

      const body = res.body as TestWebsite[];
      const names = body.map((w) => w.name).sort();
      expect(names).toEqual(['Site A']);
    });

    it('lists every website for an ADMIN', async () => {
      const res = await request(server())
        .get('/api/me/websites')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);

      const names = (res.body as TestWebsite[]).map((w) => w.name).sort();
      expect(names).toEqual(['Site A', 'Site B', 'Site C']);
    });
  });

  // ----------------------------------------------- inbox preview (lastMessage)

  describe('staff conversation inbox preview', () => {
    const createConversation = async (): Promise<StaffConversation> => {
      const res = await request(server())
        .post(`/api/public/websites/${siteA.publicKey}/conversations`)
        .send({ visitorKey: visitorA.visitorKey });
      expect(res.status).toBe(201);
      return res.body as StaffConversation;
    };

    it('shows lastMessage:null before any message exists', async () => {
      const conv = await createConversation();

      const list = await request(server())
        .get(`/api/websites/${siteA.id}/conversations`)
        .set('Authorization', `Bearer ${agentToken}`);
      expect(list.status).toBe(200);
      const row = (list.body.data as StaffConversation[]).find((c) => c.id === conv.id);
      expect(row).toBeDefined();
      expect(row?.lastMessage).toBeNull();

      const detail = await request(server())
        .get(`/api/websites/${siteA.id}/conversations/${conv.id}`)
        .set('Authorization', `Bearer ${agentToken}`);
      expect((detail.body as StaffConversation).lastMessage).toBeNull();
    });

    it('surfaces the newest message as lastMessage in list and detail', async () => {
      const conv = await createConversation();

      const send = (content: string) =>
        request(server())
          .post(
            `/api/public/websites/${siteA.publicKey}/visitor/${visitorA.visitorKey}/conversations/${conv.id}/messages`,
          )
          .send({ content });
      expect((await send('first')).status).toBe(201);
      expect((await send('second')).status).toBe(201);

      const list = await request(server())
        .get(`/api/websites/${siteA.id}/conversations`)
        .set('Authorization', `Bearer ${agentToken}`);
      const row = (list.body.data as StaffConversation[]).find((c) => c.id === conv.id);
      expect(row?.lastMessage?.content).toBe('second');
      expect(row?.lastMessage?.senderType).toBe('VISITOR');
      expect(row?.lastMessageAt).toBe(row?.lastMessage?.createdAt);

      const detail = await request(server())
        .get(`/api/websites/${siteA.id}/conversations/${conv.id}`)
        .set('Authorization', `Bearer ${agentToken}`);
      expect((detail.body as StaffConversation).lastMessage?.content).toBe('second');
    });
  });

  // ------------------------------------------------------------- staff close

  describe('staff conversation close', () => {
    let conv: StaffConversation;

    beforeEach(async () => {
      const created = await request(server())
        .post(`/api/public/websites/${siteA.publicKey}/conversations`)
        .send({ visitorKey: visitorA.visitorKey });
      expect(created.status).toBe(201);
      conv = created.body as StaffConversation;
    });

    it('closes an OPEN conversation for an authorized agent', async () => {
      const res = await request(server())
        .post(`/api/websites/${siteA.id}/conversations/${conv.id}/close`)
        .set('Authorization', `Bearer ${agentToken}`)
        .send({});
      expect(res.status).toBe(200);

      const body = res.body as StaffConversation;
      expect(body.status).toBe(ConversationStatus.CLOSED);
      expect(body.closedAt).not.toBeNull();

      const event = await prisma.conversationEvent.findFirst({
        where: { conversationId: conv.id, type: 'CONVERSATION_CLOSED' },
      });
      expect(event).not.toBeNull();
    });

    it('rejects closing an already-closed conversation (409)', async () => {
      const close = () =>
        request(server())
          .post(`/api/websites/${siteA.id}/conversations/${conv.id}/close`)
          .set('Authorization', `Bearer ${agentToken}`)
          .send({});

      expect((await close()).status).toBe(200);
      expect((await close()).status).toBe(409);
    });

    it('hides a foreign conversation as 404', async () => {
      const foreignVisitor = await request(server())
        .post(`/api/public/websites/${siteB.publicKey}/visitor`)
        .send({});
      expect(foreignVisitor.status).toBe(201);

      const foreign = await request(server())
        .post(`/api/public/websites/${siteB.publicKey}/conversations`)
        .send({ visitorKey: (foreignVisitor.body as TestVisitor).visitorKey });
      expect(foreign.status).toBe(201);

      const res = await request(server())
        .post(
          `/api/websites/${siteA.id}/conversations/${(foreign.body as StaffConversation).id}/close`,
        )
        .set('Authorization', `Bearer ${agentToken}`)
        .send({});
      expect(res.status).toBe(404);
    });

    it('forbids closing a deactivated website conversation (403)', async () => {
      // siteC is deactivated; even an ADMIN may not write into it.
      const siteCVVisitor = await request(server())
        .post(`/api/public/websites/${siteC.publicKey}/visitor`)
        .send({});
      expect(siteCVVisitor.status).toBe(201);

      const other = await request(server())
        .post(`/api/public/websites/${siteC.publicKey}/conversations`)
        .send({ visitorKey: (siteCVVisitor.body as TestVisitor).visitorKey });
      expect(other.status).toBe(201);
      const otherConv = other.body as StaffConversation;
      await request(server())
        .patch(`/api/websites/${siteC.id}/deactivate`)
        .set('Authorization', `Bearer ${adminToken}`);

      const res = await request(server())
        .post(`/api/websites/${siteC.id}/conversations/${otherConv.id}/close`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({});
      expect(res.status).toBe(403);
    });

    it('keeps a closed conversation read-only for agent sends (409)', async () => {
      await request(server())
        .post(`/api/websites/${siteA.id}/conversations/${conv.id}/close`)
        .set('Authorization', `Bearer ${agentToken}`)
        .send({});

      const send = await request(server())
        .post(`/api/websites/${siteA.id}/conversations/${conv.id}/messages`)
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ content: 'into a closed thread' });
      expect(send.status).toBe(409);
    });
  });

  // ------------------------------------------------- staff identity / hygiene

  describe('staff identity payload (dashboard bootstrap)', () => {
    it('returns the authenticated principal from /api/auth/me', async () => {
      const res = await request(server())
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${agentToken}`);
      expect(res.status).toBe(200);
      const user = res.body as AuthUser;
      expect(user.email).toBe(email('agent'));
      expect(user.role).toBe(Role.AGENT);
      expect(user.id).toBeDefined();
    });
  });
});
