import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConversationEventType, Role } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { PasswordService } from '../src/security/password.service';

const TAG = 'phase4-public';
const TEST_DOMAIN = 'chatflow.test';
const PASSWORD = 'Passw0rd123';

const email = (name: string): string => `${name}-${TAG}@${TEST_DOMAIN}`;
const domain = (name: string): string => `${name}-${TAG}.${TEST_DOMAIN}`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PUBLIC_KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const VISITOR_KEY_RE = /^[A-Za-z0-9_-]{32}$/;

interface TestWebsite {
  id: string;
  publicKey: string;
  isActive: boolean;
}

interface TestVisitor {
  visitorKey: string;
  name: string | null;
  email: string | null;
}

interface TestConversation {
  id: string;
  status: string;
  subject: string | null;
  closedAt: string | null;
}

describe('Phase 4b: visitors, conversations, IDOR & tenant isolation (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let adminToken: string;
  let agentAToken: string;
  let agentBToken: string;

  let siteA: TestWebsite;
  let siteB: TestWebsite;
  let siteC: TestWebsite;
  let siteD: TestWebsite;

  let visitorA: TestVisitor;
  let visitorA2: TestVisitor;
  let visitorB: TestVisitor;
  let convA: TestConversation;

  const server = () => app.getHttpServer();

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

  // ---- public helpers -------------------------------------------------
  const initVisitor = (publicKey: string, body: Record<string, unknown> = {}) =>
    request(server()).post(`/api/public/websites/${publicKey}/visitor`).send(body);

  const getVisitor = (publicKey: string, visitorKey: string) =>
    request(server()).get(`/api/public/websites/${publicKey}/visitor/${visitorKey}`);

  const createConversation = (publicKey: string, body: Record<string, unknown>) =>
    request(server()).post(`/api/public/websites/${publicKey}/conversations`).send(body);

  const listOwnConversations = (publicKey: string, visitorKey: string, query = '') =>
    request(server()).get(
      `/api/public/websites/${publicKey}/visitor/${visitorKey}/conversations${query}`,
    );

  const getOwnConversation = (publicKey: string, visitorKey: string, conversationId: string) =>
    request(server()).get(
      `/api/public/websites/${publicKey}/visitor/${visitorKey}/conversations/${conversationId}`,
    );

  const closeConversation = (publicKey: string, visitorKey: string, conversationId: string) =>
    request(server()).post(
      `/api/public/websites/${publicKey}/visitor/${visitorKey}/conversations/${conversationId}/close`,
    );

  const staffConversations = (websiteId: string, token: string) =>
    request(server())
      .get(`/api/websites/${websiteId}/conversations`)
      .set('Authorization', `Bearer ${token}`);

  const staffConversation = (websiteId: string, conversationId: string, token: string) =>
    request(server())
      .get(`/api/websites/${websiteId}/conversations/${conversationId}`)
      .set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    prisma = app.get(PrismaService);
    const password = app.get(PasswordService);
    await cleanup();

    const hash = await password.hash(PASSWORD);
    const admin = await prisma.user.create({
      data: { email: email('admin'), role: Role.ADMIN, passwordHash: hash },
    });
    const agentA = await prisma.user.create({
      data: { email: email('agent-a'), role: Role.AGENT, passwordHash: hash },
    });
    const agentB = await prisma.user.create({
      data: { email: email('agent-b'), role: Role.AGENT, passwordHash: hash },
    });
    void admin;

    adminToken = (
      await request(server())
        .post('/api/auth/login')
        .send({ email: email('admin'), password: PASSWORD })
    ).body.accessToken;
    agentAToken = (
      await request(server())
        .post('/api/auth/login')
        .send({ email: email('agent-a'), password: PASSWORD })
    ).body.accessToken;
    agentBToken = (
      await request(server())
        .post('/api/auth/login')
        .send({ email: email('agent-b'), password: PASSWORD })
    ).body.accessToken;

    const createSite = async (name: string): Promise<TestWebsite> => {
      const res = await request(server())
        .post('/api/websites')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name, domain: domain(name.toLowerCase().replace(/\s+/g, '-')) });
      expect(res.status).toBe(201);
      return res.body as TestWebsite;
    };

    siteA = await createSite('P4 Site A');
    siteB = await createSite('P4 Site B');
    siteC = await createSite('P4 Site C');
    siteD = await createSite('P4 Site D');

    // agent-a may work on site A only; agent-b has no membership at all.
    const membership = await request(server())
      .post(`/api/websites/${siteA.id}/memberships`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ userId: agentA.id });
    expect(membership.status).toBe(201);

    const initA = await initVisitor(siteA.publicKey, {
      name: 'Visitor A',
      email: 'Visitor+A@Example.COM',
    });
    expect(initA.status).toBe(201);
    visitorA = initA.body as TestVisitor;

    const initA2 = await initVisitor(siteA.publicKey);
    expect(initA2.status).toBe(201);
    visitorA2 = initA2.body as TestVisitor;

    const initB = await initVisitor(siteB.publicKey);
    expect(initB.status).toBe(201);
    visitorB = initB.body as TestVisitor;

    const createdA = await createConversation(siteA.publicKey, {
      visitorKey: visitorA.visitorKey,
      subject: 'Need help with my order',
    });
    expect(createdA.status).toBe(201);
    convA = createdA.body as TestConversation;

    const createdB = await createConversation(siteB.publicKey, {
      visitorKey: visitorB.visitorKey,
    });
    expect(createdB.status).toBe(201);
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  describe('visitor initialization & identity', () => {
    it('initializes an anonymous visitor with an opaque, unguessable key', async () => {
      const res = await initVisitor(siteA.publicKey);

      expect(res.status).toBe(201);
      expect(res.body.visitorKey).toMatch(VISITOR_KEY_RE);
      expect(res.body.visitorKey).not.toMatch(UUID_RE);
      expect(res.body.name).toBeNull();
      expect(res.body.email).toBeNull();
      // The widget never learns internal database ids.
      expect(res.body.id).toBeUndefined();
      expect(res.body.websiteId).toBeUndefined();
      expect(Object.keys(res.body).sort()).toEqual(
        ['createdAt', 'email', 'lastSeenAt', 'name', 'visitorKey'].sort(),
      );
    });

    it('issues a distinct key for every visitor', async () => {
      const second = await initVisitor(siteA.publicKey);
      expect(second.status).toBe(201);
      expect(second.body.visitorKey).not.toBe(visitorA.visitorKey);
      expect(second.body.visitorKey).not.toBe(visitorA2.visitorKey);
    });

    it('accepts optional name and email and normalizes them', async () => {
      const res = await initVisitor(siteA.publicKey, {
        name: '  Trimmed Name  ',
        email: 'Visitor+B@Example.COM',
      });

      expect(res.status).toBe(201);
      expect(res.body.name).toBe('Trimmed Name');
      expect(res.body.email).toBe('visitor+b@example.com');
    });

    it('validates visitor input', async () => {
      expect((await initVisitor(siteA.publicKey, { email: 'nope' })).status).toBe(400);
      expect((await initVisitor(siteA.publicKey, { name: 'x'.repeat(121) })).status).toBe(400);
      expect((await initVisitor(siteA.publicKey, { visitorKey: 'abc' })).status).toBe(400);
      expect((await initVisitor('short', {})).status).toBe(400);
    });

    it('rejects malformed and unknown public keys', async () => {
      const malformed = await initVisitor('short-key');
      expect(malformed.status).toBe(400);

      const unknown = await initVisitor('Z'.repeat(43));
      expect(unknown.status).toBe(404);
      expect(unknown.body.message).toBe('Website not found');
    });

    it('reconnects a visitor after a page refresh using its key', async () => {
      const res = await getVisitor(siteA.publicKey, visitorA.visitorKey);

      expect(res.status).toBe(200);
      expect(res.body.visitorKey).toBe(visitorA.visitorKey);
      expect(res.body.name).toBe('Visitor A');
      expect(res.body.email).toBe('visitor+a@example.com');
      expect(res.body.id).toBeUndefined();
    });

    it('rejects unknown and malformed visitor keys', async () => {
      const unknown = await getVisitor(siteA.publicKey, 'Z'.repeat(32));
      expect(unknown.status).toBe(404);

      const malformed = await getVisitor(siteA.publicKey, 'nope');
      expect(malformed.status).toBe(400);
    });

    it('lets a visitor update only its own optional profile', async () => {
      const res = await request(server())
        .patch(`/api/public/websites/${siteA.publicKey}/visitor/${visitorA2.visitorKey}`)
        .send({ name: 'Now Identified', email: 'now@example.com' });

      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Now Identified');
      expect(res.body.email).toBe('now@example.com');

      const empty = await request(server())
        .patch(`/api/public/websites/${siteA.publicKey}/visitor/${visitorA2.visitorKey}`)
        .send({});
      expect(empty.status).toBe(400);

      const badEmail = await request(server())
        .patch(`/api/public/websites/${siteA.publicKey}/visitor/${visitorA2.visitorKey}`)
        .send({ email: 'nope' });
      expect(badEmail.status).toBe(400);

      const extra = await request(server())
        .patch(`/api/public/websites/${siteA.publicKey}/visitor/${visitorA2.visitorKey}`)
        .send({ isAdmin: true });
      expect(extra.status).toBe(400);
    });
  });

  describe('inactive website rejects the widget', () => {
    let siteDVisitor: TestVisitor;

    it('initializes while active, then rejects everything once deactivated', async () => {
      const before = await initVisitor(siteD.publicKey);
      expect(before.status).toBe(201);
      siteDVisitor = before.body as TestVisitor;

      const down = await request(server())
        .patch(`/api/websites/${siteD.id}/deactivate`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(down.status).toBe(200);

      const blockedInit = await initVisitor(siteD.publicKey);
      expect(blockedInit.status).toBe(404);
      expect(blockedInit.body.message).toBe('Website not found');

      // Even a previously issued visitor key goes dark while the site is down.
      const blockedState = await getVisitor(siteD.publicKey, siteDVisitor.visitorKey);
      expect(blockedState.status).toBe(404);

      const blockedConversation = await createConversation(siteD.publicKey, {
        visitorKey: siteDVisitor.visitorKey,
      });
      expect(blockedConversation.status).toBe(404);

      const up = await request(server())
        .patch(`/api/websites/${siteD.id}/reactivate`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(up.status).toBe(200);

      const restored = await getVisitor(siteD.publicKey, siteDVisitor.visitorKey);
      expect(restored.status).toBe(200);
    });
  });

  describe('visitor IDOR protection', () => {
    it('Website A + Visitor B: a key from another website does not resolve (404)', async () => {
      const state = await getVisitor(siteA.publicKey, visitorB.visitorKey);
      expect(state.status).toBe(404);

      const patch = await request(server())
        .patch(`/api/public/websites/${siteA.publicKey}/visitor/${visitorB.visitorKey}`)
        .send({ name: 'Hijacked' });
      expect(patch.status).toBe(404);

      // The real visitor B is untouched.
      const real = await getVisitor(siteB.publicKey, visitorB.visitorKey);
      expect(real.status).toBe(200);
      expect(real.body.name).toBeNull();
    });

    it('Website B + Visitor A: the same key does not resolve on another tenant (404)', async () => {
      const state = await getVisitor(siteB.publicKey, visitorA.visitorKey);
      expect(state.status).toBe(404);

      const conversations = await listOwnConversations(siteB.publicKey, visitorA.visitorKey);
      expect(conversations.status).toBe(404);
    });

    it('Visitor B + Conversation A: another visitor cannot read my conversation (404)', async () => {
      const res = await getOwnConversation(siteA.publicKey, visitorA2.visitorKey, convA.id);
      expect(res.status).toBe(404);

      const list = await listOwnConversations(siteA.publicKey, visitorA2.visitorKey);
      expect(list.status).toBe(200);
      expect(list.body.data.map((c: TestConversation) => c.id)).not.toContain(convA.id);
    });

    it('Website B + Conversation A: a conversation id from another tenant is 404', async () => {
      const res = await getOwnConversation(siteB.publicKey, visitorB.visitorKey, convA.id);
      expect(res.status).toBe(404);
    });
  });

  describe('conversation creation', () => {
    it('creates an OPEN conversation owned by the calling visitor', async () => {
      const res = await createConversation(siteA.publicKey, {
        visitorKey: visitorA.visitorKey,
        subject: '  Second thread  ',
      });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('OPEN');
      expect(res.body.subject).toBe('Second thread');
      expect(res.body.closedAt).toBeNull();
      expect(res.body.lastMessageAt).toBeNull();
      expect(res.body.id).toMatch(UUID_RE);
      // Tenant and owner ids are derived server-side, never echoed from input.
      expect(res.body.websiteId).toBeUndefined();
      expect(res.body.visitorId).toBeUndefined();
    });

    it('rejects client-supplied tenant or owner fields (400)', async () => {
      const res = await createConversation(siteA.publicKey, {
        visitorKey: visitorA.visitorKey,
        websiteId: siteB.id,
        visitorId: visitorB.visitorKey,
        status: 'CLOSED',
      });
      expect(res.status).toBe(400);
    });

    it('validates conversation input', async () => {
      const missingKey = await createConversation(siteA.publicKey, { subject: 'x' });
      expect(missingKey.status).toBe(400);

      const badKey = await createConversation(siteA.publicKey, { visitorKey: 'nope' });
      expect(badKey.status).toBe(400);

      const unknownKey = await createConversation(siteA.publicKey, {
        visitorKey: 'Z'.repeat(32),
      });
      expect(unknownKey.status).toBe(404);

      const badPublic = await createConversation('short', {
        visitorKey: visitorA.visitorKey,
      });
      expect(badPublic.status).toBe(400);

      const longSubject = await createConversation(siteA.publicKey, {
        visitorKey: visitorA.visitorKey,
        subject: 'x'.repeat(201),
      });
      expect(longSubject.status).toBe(400);
    });
  });

  describe('conversation listing & detail', () => {
    it('a visitor only ever lists and reads its own conversations', async () => {
      const mine = await listOwnConversations(siteA.publicKey, visitorA.visitorKey);
      expect(mine.status).toBe(200);
      const ids = mine.body.data.map((c: TestConversation) => c.id);
      expect(ids).toContain(convA.id);
      expect(mine.body.total).toBe(ids.length);
      expect(mine.body.page).toBe(1);

      const others = await listOwnConversations(siteA.publicKey, visitorA2.visitorKey);
      expect(others.status).toBe(200);
      expect(others.body.data.map((c: TestConversation) => c.id)).not.toContain(convA.id);

      const detail = await getOwnConversation(siteA.publicKey, visitorA.visitorKey, convA.id);
      expect(detail.status).toBe(200);
      expect(detail.body.id).toBe(convA.id);
      expect(detail.body.subject).toBe('Need help with my order');
      expect(detail.body.visitor).toBeUndefined();
    });

    it('returns 404 for unknown conversation ids and 400 for malformed ones', async () => {
      const unknown = await getOwnConversation(
        siteA.publicKey,
        visitorA.visitorKey,
        '00000000-0000-4000-8000-000000000000',
      );
      expect(unknown.status).toBe(404);

      const malformed = await getOwnConversation(
        siteA.publicKey,
        visitorA.visitorKey,
        'not-a-uuid',
      );
      expect(malformed.status).toBe(400);
    });

    it('filters by status and validates query parameters', async () => {
      const open = await listOwnConversations(siteA.publicKey, visitorA.visitorKey, '?status=OPEN');
      expect(open.status).toBe(200);
      expect(open.body.data.every((c: TestConversation) => c.status === 'OPEN')).toBe(true);

      const bad = await listOwnConversations(
        siteA.publicKey,
        visitorA.visitorKey,
        '?status=ARCHIVED',
      );
      expect(bad.status).toBe(400);

      const badPage = await listOwnConversations(siteA.publicKey, visitorA.visitorKey, '?page=abc');
      expect(badPage.status).toBe(400);
    });
  });

  describe('conversation lifecycle', () => {
    it('visitor closes its own conversation, which cannot be closed twice', async () => {
      const closed = await closeConversation(siteA.publicKey, visitorA.visitorKey, convA.id);
      expect(closed.status).toBe(200);
      expect(closed.body.status).toBe('CLOSED');
      expect(closed.body.closedAt).not.toBeNull();

      const again = await closeConversation(siteA.publicKey, visitorA.visitorKey, convA.id);
      expect(again.status).toBe(409);
    });

    it("another visitor cannot close someone else's conversation", async () => {
      const res = await closeConversation(siteA.publicKey, visitorA2.visitorKey, convA.id);
      expect(res.status).toBe(404);
    });

    it('a closed conversation remains readable and filterable', async () => {
      const closedList = await listOwnConversations(
        siteA.publicKey,
        visitorA.visitorKey,
        '?status=CLOSED',
      );
      expect(closedList.status).toBe(200);
      expect(closedList.body.data.map((c: TestConversation) => c.id)).toContain(convA.id);
    });

    it('records CONVERSATION_CREATED and CONVERSATION_CLOSED events', async () => {
      const events = await prisma.conversationEvent.findMany({
        where: { conversationId: convA.id },
        orderBy: { createdAt: 'asc' },
      });

      expect(events.map((e) => e.type)).toEqual([
        ConversationEventType.CONVERSATION_CREATED,
        ConversationEventType.CONVERSATION_CLOSED,
      ]);
      expect(events.every((e) => e.websiteId === siteA.id)).toBe(true);
    });
  });

  describe('staff tenant isolation', () => {
    it('agent A reads conversations of their own website', async () => {
      const list = await staffConversations(siteA.id, agentAToken);
      expect(list.status).toBe(200);
      expect(list.body.data.length).toBeGreaterThan(0);
      const entry = list.body.data.find((c: { id: string }) => c.id === convA.id);
      expect(entry).toBeDefined();
      expect(entry.visitor.name).toBe('Visitor A');
      expect(entry.visitor.email).toBe('visitor+a@example.com');

      const detail = await staffConversation(siteA.id, convA.id, agentAToken);
      expect(detail.status).toBe(200);
      expect(detail.body.status).toBe('CLOSED');
      expect(detail.body.visitor.id).toMatch(UUID_RE);
      // Staff never see the widget credential.
      expect(detail.body.visitor.visitorKey).toBeUndefined();
    });

    it('Agent A + Website B: cross-website access fails (403)', async () => {
      const list = await staffConversations(siteB.id, agentAToken);
      expect(list.status).toBe(403);

      // Even with conversation A's id swapped into another tenant's path.
      const detail = await staffConversation(siteB.id, convA.id, agentAToken);
      expect(detail.status).toBe(403);
    });

    it('agent without any membership is rejected everywhere (403)', async () => {
      expect((await staffConversations(siteA.id, agentBToken)).status).toBe(403);
      expect((await staffConversations(siteB.id, agentBToken)).status).toBe(403);
    });

    it('ADMIN can read any website; foreign conversation ids are 404', async () => {
      expect((await staffConversations(siteB.id, adminToken)).status).toBe(200);

      const foreign = await staffConversation(
        siteA.id,
        '00000000-0000-4000-8000-000000000000',
        adminToken,
      );
      expect(foreign.status).toBe(404);

      // Conversation B presented under website A must not resolve.
      const mismatched = await prisma.conversation.findFirst({
        where: { websiteId: siteB.id },
      });
      const crossTenant = await staffConversation(siteA.id, mismatched!.id, adminToken);
      expect(crossTenant.status).toBe(404);
    });

    it('inactive membership blocks staff access without destroying history', async () => {
      const memberships = await request(server())
        .get(`/api/websites/${siteA.id}/memberships`)
        .set('Authorization', `Bearer ${adminToken}`);
      const membership = memberships.body[0];

      const before = await prisma.conversation.count({ where: { websiteId: siteA.id } });

      await request(server())
        .patch(`/api/websites/${siteA.id}/memberships/${membership.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ isActive: false });

      expect((await staffConversations(siteA.id, agentAToken)).status).toBe(403);

      // Historical conversations survive the membership change untouched.
      const after = await prisma.conversation.count({ where: { websiteId: siteA.id } });
      expect(after).toBe(before);
      const adminStillReads = await staffConversations(siteA.id, adminToken);
      expect(adminStillReads.status).toBe(200);

      await request(server())
        .patch(`/api/websites/${siteA.id}/memberships/${membership.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ isActive: true });

      expect((await staffConversations(siteA.id, agentAToken)).status).toBe(200);
    });
  });

  describe('database integrity', () => {
    it('rejects a conversation whose website does not match its visitor', async () => {
      // The public API never exposes visitor ids, so resolve one internally
      // and try to pair it with the wrong tenant directly.
      const internal = await prisma.visitor.findUniqueOrThrow({
        where: { websiteId_visitorKey: { websiteId: siteA.id, visitorKey: visitorA.visitorKey } },
      });

      await expect(
        prisma.conversation.create({
          data: { websiteId: siteB.id, visitorId: internal.id, status: 'OPEN' },
        }),
      ).rejects.toThrow();
    });

    it('rejects an event whose website does not match its conversation', async () => {
      await expect(
        prisma.conversationEvent.create({
          data: {
            conversationId: convA.id,
            websiteId: siteB.id,
            type: ConversationEventType.CONVERSATION_CREATED,
          },
        }),
      ).rejects.toThrow();
    });
  });

  describe('public rate limiting (in-memory, single instance)', () => {
    it('rate limits visitor initialization per IP + website (429)', async () => {
      for (let i = 0; i < 20; i += 1) {
        const res = await initVisitor(siteC.publicKey);
        expect(res.status).toBe(201);
      }

      const blocked = await initVisitor(siteC.publicKey);
      expect(blocked.status).toBe(429);
      expect(blocked.body.message).toContain('Too many requests');

      // Other tenants are unaffected (keys are per publicKey).
      const other = await initVisitor(siteA.publicKey);
      expect(other.status).toBe(201);
    });
  });
});
