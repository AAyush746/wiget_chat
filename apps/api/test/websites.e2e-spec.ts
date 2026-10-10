import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Role } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { PasswordService } from '../src/security/password.service';

const TAG = 'phase4-websites';
const TEST_DOMAIN = 'chatflow.test';
const PASSWORD = 'Passw0rd123';

const email = (name: string): string => `${name}-${TAG}@${TEST_DOMAIN}`;
const domain = (name: string): string => `${name}-${TAG}.${TEST_DOMAIN}`;

interface TestWebsite {
  id: string;
  name: string;
  domain: string;
  publicKey: string;
  isActive: boolean;
}

describe('Phase 4a: websites, membership & tenant authorization (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let adminToken: string;
  let agentToken: string;
  let adminId: string;
  let agentId: string;
  let agent2Id: string;

  let siteA: TestWebsite;
  let siteB: TestWebsite;

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
    const admin = await prisma.user.create({
      data: { email: email('admin'), name: 'P4 Admin', role: Role.ADMIN, passwordHash: hash },
    });
    const agent = await prisma.user.create({
      data: { email: email('agent'), name: 'P4 Agent', role: Role.AGENT, passwordHash: hash },
    });
    const agent2 = await prisma.user.create({
      data: { email: email('agent2'), name: 'P4 Agent 2', role: Role.AGENT, passwordHash: hash },
    });

    adminId = admin.id;
    agentId = agent.id;
    agent2Id = agent2.id;

    adminToken = (
      await request(server())
        .post('/api/auth/login')
        .send({ email: email('admin'), password: PASSWORD })
    ).body.accessToken;
    agentToken = (
      await request(server())
        .post('/api/auth/login')
        .send({ email: email('agent'), password: PASSWORD })
    ).body.accessToken;

    siteA = (await createWebsite({ name: 'Site A', domain: domain('site-a') })).body as TestWebsite;
    siteB = (await createWebsite({ name: 'Site B', domain: domain('site-b') })).body as TestWebsite;
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  describe('website management (ADMIN only)', () => {
    it('rejects unauthenticated access (401)', async () => {
      const res = await request(server())
        .post('/api/websites')
        .send({ name: 'x', domain: 'x.com' });
      expect(res.status).toBe(401);
    });

    it('rejects AGENT on every website management endpoint (403)', async () => {
      const auth = { Authorization: `Bearer ${agentToken}` };

      const create = await request(server())
        .post('/api/websites')
        .set(auth)
        .send({ name: 'x', domain: domain('x') });
      expect(create.status).toBe(403);

      const list = await request(server()).get('/api/websites').set(auth);
      expect(list.status).toBe(403);

      const get = await request(server()).get(`/api/websites/${siteA.id}`).set(auth);
      expect(get.status).toBe(403);

      const update = await request(server())
        .patch(`/api/websites/${siteA.id}`)
        .set(auth)
        .send({ name: 'renamed' });
      expect(update.status).toBe(403);

      const deactivate = await request(server())
        .patch(`/api/websites/${siteA.id}/deactivate`)
        .set(auth);
      expect(deactivate.status).toBe(403);

      const reactivate = await request(server())
        .patch(`/api/websites/${siteA.id}/reactivate`)
        .set(auth);
      expect(reactivate.status).toBe(403);
    });

    it('ADMIN creates a website with a high-entropy public key', async () => {
      const res = await createWebsite({
        name: '  Created Site  ',
        domain: domain('created').toUpperCase(),
      });

      expect(res.status).toBe(201);
      expect(res.body.name).toBe('Created Site');
      expect(res.body.domain).toBe(domain('created'));
      expect(res.body.isActive).toBe(true);
      expect(res.body.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      // 32 random bytes, base64url -> 43 URL-safe characters (256 bits).
      expect(res.body.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(res.text).not.toContain('passwordHash');
    });

    it('generates a distinct public key per website', async () => {
      expect(siteA.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(siteA.publicKey).not.toBe(siteB.publicKey);
    });

    it('rejects a duplicate domain with 409', async () => {
      const res = await createWebsite({ name: 'Copy', domain: domain('site-a') });
      expect(res.status).toBe(409);
    });

    it('rejects malformed input with 400', async () => {
      expect((await createWebsite({ name: 'No Domain' })).status).toBe(400);
      expect((await createWebsite({ name: 'Bad', domain: 'not-a-domain' })).status).toBe(400);
      expect((await createWebsite({ name: 'Bad', domain: 'has space.com' })).status).toBe(400);
      expect((await createWebsite({ name: '', domain: domain('x') })).status).toBe(400);
      expect((await createWebsite({ name: 'x', domain: domain('x'), isAdmin: true })).status).toBe(
        400,
      );
    });

    it('ADMIN lists websites with pagination and filters', async () => {
      const res = await request(server())
        .get('/api/websites')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.total).toBeGreaterThanOrEqual(2);
      expect(res.body.data.some((w: TestWebsite) => w.id === siteA.id)).toBe(true);

      const page = await request(server())
        .get('/api/websites?limit=1&page=1')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(page.status).toBe(200);
      expect(page.body.limit).toBe(1);
      expect(page.body.data).toHaveLength(1);

      const filtered = await request(server())
        .get('/api/websites?isActive=false')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(filtered.status).toBe(200);
      expect(filtered.body.data.every((w: TestWebsite) => w.isActive === false)).toBe(true);
    });

    it('ADMIN gets, updates and validates website parameters', async () => {
      const found = await request(server())
        .get(`/api/websites/${siteA.id}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(found.status).toBe(200);
      expect(found.body.publicKey).toBe(siteA.publicKey);

      const badId = await request(server())
        .get('/api/websites/not-a-uuid')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(badId.status).toBe(400);

      const unknown = await request(server())
        .get('/api/websites/00000000-0000-4000-8000-000000000000')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(unknown.status).toBe(404);

      const updated = await request(server())
        .patch(`/api/websites/${siteA.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Site A Renamed' });
      expect(updated.status).toBe(200);
      expect(updated.body.name).toBe('Site A Renamed');
      siteA.name = 'Site A Renamed';

      const empty = await request(server())
        .patch(`/api/websites/${siteA.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({});
      expect(empty.status).toBe(400);

      const conflict = await request(server())
        .patch(`/api/websites/${siteA.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ domain: domain('site-b') });
      expect(conflict.status).toBe(409);
    });

    it('deactivates and reactivates a website with state guards', async () => {
      const down = await request(server())
        .patch(`/api/websites/${siteB.id}/deactivate`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(down.status).toBe(200);
      expect(down.body.isActive).toBe(false);

      const again = await request(server())
        .patch(`/api/websites/${siteB.id}/deactivate`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(again.status).toBe(409);

      const up = await request(server())
        .patch(`/api/websites/${siteB.id}/reactivate`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(up.status).toBe(200);
      expect(up.body.isActive).toBe(true);

      const already = await request(server())
        .patch(`/api/websites/${siteB.id}/reactivate`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(already.status).toBe(409);

      const unknown = await request(server())
        .patch('/api/websites/00000000-0000-4000-8000-000000000000/deactivate')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(unknown.status).toBe(404);
    });
  });

  describe('website membership (ADMIN only)', () => {
    let membershipId: string;
    let crossMembershipId: string;

    it('ADMIN grants an AGENT membership', async () => {
      const res = await request(server())
        .post(`/api/websites/${siteA.id}/memberships`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ userId: agentId });

      expect(res.status).toBe(201);
      expect(res.body.isActive).toBe(true);
      expect(res.body.userId).toBe(agentId);
      expect(res.body.websiteId).toBe(siteA.id);
      expect(res.body.user.email).toBe(email('agent'));
      expect(res.body.user.role).toBe('AGENT');
      expect(res.text).not.toContain('passwordHash');
      membershipId = res.body.id;
    });

    it('rejects a duplicate membership with 409', async () => {
      const res = await request(server())
        .post(`/api/websites/${siteA.id}/memberships`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ userId: agentId });
      expect(res.status).toBe(409);
    });

    it('validates membership input', async () => {
      const badUuid = await request(server())
        .post(`/api/websites/${siteA.id}/memberships`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ userId: 'not-a-uuid' });
      expect(badUuid.status).toBe(400);

      const unknownUser = await request(server())
        .post(`/api/websites/${siteA.id}/memberships`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ userId: '00000000-0000-4000-8000-000000000000' });
      expect(unknownUser.status).toBe(404);

      const adminMember = await request(server())
        .post(`/api/websites/${siteA.id}/memberships`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ userId: adminId });
      expect(adminMember.status).toBe(400);

      const unknownWebsite = await request(server())
        .post('/api/websites/00000000-0000-4000-8000-000000000000/memberships')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ userId: agentId });
      expect(unknownWebsite.status).toBe(404);

      const badWebsiteId = await request(server())
        .post('/api/websites/not-a-uuid/memberships')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ userId: agentId });
      expect(badWebsiteId.status).toBe(400);
    });

    it('rejects AGENT access to membership management (403)', async () => {
      const create = await request(server())
        .post(`/api/websites/${siteA.id}/memberships`)
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ userId: agent2Id });
      expect(create.status).toBe(403);

      const list = await request(server())
        .get(`/api/websites/${siteA.id}/memberships`)
        .set('Authorization', `Bearer ${agentToken}`);
      expect(list.status).toBe(403);

      const patch = await request(server())
        .patch(`/api/websites/${siteA.id}/memberships/${membershipId}`)
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ isActive: false });
      expect(patch.status).toBe(403);
    });

    it('ADMIN lists memberships of a website', async () => {
      const res = await request(server())
        .get(`/api/websites/${siteA.id}/memberships`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].id).toBe(membershipId);
      expect(res.body[0].user.email).toBe(email('agent'));
    });

    it('deactivates and reactivates a membership with state guards', async () => {
      const down = await request(server())
        .patch(`/api/websites/${siteA.id}/memberships/${membershipId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ isActive: false });
      expect(down.status).toBe(200);
      expect(down.body.isActive).toBe(false);

      const again = await request(server())
        .patch(`/api/websites/${siteA.id}/memberships/${membershipId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ isActive: false });
      expect(again.status).toBe(409);

      const up = await request(server())
        .patch(`/api/websites/${siteA.id}/memberships/${membershipId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ isActive: true });
      expect(up.status).toBe(200);
      expect(up.body.isActive).toBe(true);
    });

    it('scopes membership ids to their website (cross-tenant id is 404)', async () => {
      const created = await request(server())
        .post(`/api/websites/${siteB.id}/memberships`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ userId: agent2Id });
      expect(created.status).toBe(201);
      crossMembershipId = created.body.id;

      // siteB's membership id presented under siteA must not resolve.
      const cross = await request(server())
        .patch(`/api/websites/${siteA.id}/memberships/${crossMembershipId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ isActive: false });
      expect(cross.status).toBe(404);

      const unknown = await request(server())
        .patch(`/api/websites/${siteA.id}/memberships/00000000-0000-4000-8000-000000000000`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ isActive: false });
      expect(unknown.status).toBe(404);

      const badUuid = await request(server())
        .patch(`/api/websites/${siteA.id}/memberships/not-a-uuid`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ isActive: false });
      expect(badUuid.status).toBe(400);

      const missingField = await request(server())
        .patch(`/api/websites/${siteA.id}/memberships/${crossMembershipId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({});
      expect(missingField.status).toBe(400);
    });
  });

  describe('tenant authorization (WebsiteAccessGuard)', () => {
    const listConversations = (websiteId: string, token: string) =>
      request(server())
        .get(`/api/websites/${websiteId}/conversations`)
        .set('Authorization', `Bearer ${token}`);

    it('rejects unauthenticated access (401)', async () => {
      const res = await request(server()).get(`/api/websites/${siteA.id}/conversations`);
      expect(res.status).toBe(401);
    });

    it('allows an AGENT with active membership on their website', async () => {
      const res = await listConversations(siteA.id, agentToken);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.total).toBe(0);
    });

    it('rejects an AGENT without membership (403)', async () => {
      // agent2 is only a member of siteB, so siteA must be off-limits.
      const agent2Token = (
        await request(server())
          .post('/api/auth/login')
          .send({ email: email('agent2'), password: PASSWORD })
      ).body.accessToken;

      const forbidden = await listConversations(siteA.id, agent2Token);
      expect(forbidden.status).toBe(403);
      expect(forbidden.body.message).toBe('You do not have access to this website');
    });

    it('allows an AGENT on a second website they belong to', async () => {
      const agent2Token = (
        await request(server())
          .post('/api/auth/login')
          .send({ email: email('agent2'), password: PASSWORD })
      ).body.accessToken;

      const allowed = await listConversations(siteB.id, agent2Token);
      expect(allowed.status).toBe(200);

      // ...but not on a website they do not belong to (siteA).
      const forbidden = await listConversations(siteA.id, agent2Token);
      expect(forbidden.status).toBe(403);
    });

    it('revokes access while membership is inactive and restores it after', async () => {
      const memberships = await request(server())
        .get(`/api/websites/${siteA.id}/memberships`)
        .set('Authorization', `Bearer ${adminToken}`);
      const target = memberships.body.find((m: { userId: string }) => m.userId === agentId);

      await request(server())
        .patch(`/api/websites/${siteA.id}/memberships/${target.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ isActive: false });

      const blocked = await listConversations(siteA.id, agentToken);
      expect(blocked.status).toBe(403);

      await request(server())
        .patch(`/api/websites/${siteA.id}/memberships/${target.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ isActive: true });

      const allowed = await listConversations(siteA.id, agentToken);
      expect(allowed.status).toBe(200);
    });

    it('grants ADMIN implicit access without a membership', async () => {
      const adminOnlySite = await createWebsite({ name: 'Admin Only', domain: domain('admin-o') });
      expect(adminOnlySite.status).toBe(201);

      const res = await listConversations(adminOnlySite.body.id, adminToken);
      expect(res.status).toBe(200);

      const detail = await request(server())
        .get(`/api/websites/${adminOnlySite.body.id}/conversations`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(detail.status).toBe(200);
    });

    it('validates the website identifier in the guard (400/404)', async () => {
      const bad = await listConversations('not-a-uuid', adminToken);
      expect(bad.status).toBe(400);

      const unknown = await listConversations('00000000-0000-4000-8000-000000000000', adminToken);
      expect(unknown.status).toBe(404);
    });
  });

  describe('AI agent (Connect Agent)', () => {
    const auth = () => ({ Authorization: `Bearer ${adminToken}` });

    it('reports the connection state and provider without leaking secrets', async () => {
      const res = await request(server()).get(`/api/websites/${siteA.id}/ai`).set(auth());

      expect(res.status).toBe(200);
      expect(res.body.aiEnabled).toBe(false);
      expect(['mock', 'groq', 'openai']).toContain(res.body.provider);
      expect(typeof res.body.model).toBe('string');
      expect(typeof res.body.ready).toBe('boolean');
      expect(res.text).not.toMatch(/api[_-]?key/i);
    });

    it('connects the agent and seeds a default escalation reply', async () => {
      const res = await request(server())
        .patch(`/api/websites/${siteA.id}/ai`)
        .set(auth())
        .send({ aiEnabled: true });

      expect(res.status).toBe(200);
      expect(res.body.aiEnabled).toBe(true);
      expect(res.body.aiFallbackMessage).toBeTruthy();

      const status = await request(server()).get(`/api/websites/${siteA.id}/ai`).set(auth());
      expect(status.body.aiEnabled).toBe(true);
      expect(status.body.aiFallbackMessage).toBe(res.body.aiFallbackMessage);
    });

    it('sets a custom escalation reply (trimmed) and disconnects', async () => {
      const custom = await request(server())
        .patch(`/api/websites/${siteA.id}/ai`)
        .set(auth())
        .send({ aiFallbackMessage: '  We will reply by email.  ' });
      expect(custom.status).toBe(200);
      expect(custom.body.aiFallbackMessage).toBe('We will reply by email.');

      const off = await request(server())
        .patch(`/api/websites/${siteA.id}/ai`)
        .set(auth())
        .send({ aiEnabled: false });
      expect(off.status).toBe(200);
      expect(off.body.aiEnabled).toBe(false);
    });

    it('rejects AGENT on the agent endpoints (403)', async () => {
      const read = await request(server())
        .get(`/api/websites/${siteA.id}/ai`)
        .set('Authorization', `Bearer ${agentToken}`);
      expect(read.status).toBe(403);

      const write = await request(server())
        .patch(`/api/websites/${siteA.id}/ai`)
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ aiEnabled: true });
      expect(write.status).toBe(403);
    });

    it('validates input (400) and unknown website (404)', async () => {
      const empty = await request(server())
        .patch(`/api/websites/${siteA.id}/ai`)
        .set(auth())
        .send({});
      expect(empty.status).toBe(400);

      const unknown = await request(server())
        .get('/api/websites/00000000-0000-4000-8000-000000000000/ai')
        .set(auth());
      expect(unknown.status).toBe(404);

      const badId = await request(server()).get('/api/websites/not-a-uuid/ai').set(auth());
      expect(badId.status).toBe(400);
    });
  });
});
