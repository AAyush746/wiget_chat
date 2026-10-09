import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { Role } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { PasswordService } from '../src/security/password.service';

const TAG = 'phase3-e2e';
const TEST_DOMAIN = 'chatflow.test';
const PASSWORD = 'Passw0rd123';

const email = (name: string): string => `${name}-${TAG}@${TEST_DOMAIN}`;

describe('Phase 3: authentication & authorization (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let password: PasswordService;
  let signer: JwtService;
  let wrongSigner: JwtService;

  let adminToken: string;
  let adminId: string;
  let agentToken: string;
  let agentId: string;
  let secondAdminId: string;

  const server = () => app.getHttpServer();

  const login = (mail: string, pass: string = PASSWORD) =>
    request(server()).post('/api/auth/login').send({ email: mail, password: pass });

  const cleanup = async (): Promise<void> => {
    await prisma.user.deleteMany({ where: { email: { endsWith: `@${TEST_DOMAIN}` } } });
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    prisma = app.get(PrismaService);
    password = app.get(PasswordService);
    const secret = app.get(ConfigService).getOrThrow<string>('JWT_SECRET');
    signer = new JwtService({ secret });
    wrongSigner = new JwtService({ secret: `${secret}-different` });

    await cleanup();
    const hash = await password.hash(PASSWORD);

    const admin = await prisma.user.create({
      data: { email: email('admin'), name: 'Admin', role: Role.ADMIN, passwordHash: hash },
    });
    const agent = await prisma.user.create({
      data: { email: email('agent'), name: 'Agent', role: Role.AGENT, passwordHash: hash },
    });
    await prisma.user.create({
      data: { email: email('inactive'), role: Role.AGENT, passwordHash: hash, isActive: false },
    });
    const secondAdmin = await prisma.user.create({
      data: { email: email('admin2'), role: Role.ADMIN, passwordHash: hash },
    });

    adminId = admin.id;
    agentId = agent.id;
    secondAdminId = secondAdmin.id;

    adminToken = (await login(email('admin'))).body.accessToken;
    agentToken = (await login(email('agent'))).body.accessToken;
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  describe('POST /api/auth/register', () => {
    it('registers an AGENT, normalizes the email and never returns passwordHash', async () => {
      const mail = email('newbie');
      const res = await request(server())
        .post('/api/auth/register')
        .send({ email: mail.toUpperCase(), password: PASSWORD, name: 'New Bie' });

      expect(res.status).toBe(201);
      expect(typeof res.body.accessToken).toBe('string');
      expect(res.body.user.role).toBe('AGENT');
      expect(res.body.user.email).toBe(mail);
      expect(res.body.user.passwordHash).toBeUndefined();
      expect(res.text).not.toContain('passwordHash');

      const stored = await prisma.user.findUnique({ where: { email: mail } });
      expect(stored?.passwordHash).toBeTruthy();
      expect(stored?.passwordHash).not.toBe(PASSWORD);
      expect(stored?.passwordHash?.startsWith('$2')).toBe(true);
    });

    it('refuses a public registration that requests ADMIN (403)', async () => {
      const res = await request(server())
        .post('/api/auth/register')
        .send({ email: email('wannabeadmin'), password: PASSWORD, role: 'ADMIN' });

      expect(res.status).toBe(403);
    });

    it('rejects a duplicate email with 409', async () => {
      const res = await request(server())
        .post('/api/auth/register')
        .send({ email: email('agent'), password: PASSWORD });

      expect(res.status).toBe(409);
    });

    it('rejects an invalid email with 400', async () => {
      const res = await request(server())
        .post('/api/auth/register')
        .send({ email: 'not-an-email', password: PASSWORD });

      expect(res.status).toBe(400);
    });

    it('rejects a weak password with 400', async () => {
      const res = await request(server())
        .post('/api/auth/register')
        .send({ email: email('weak'), password: 'short' });

      expect(res.status).toBe(400);
    });

    it('rejects unexpected fields with 400 (mass-assignment guard)', async () => {
      const res = await request(server())
        .post('/api/auth/register')
        .send({ email: email('mass'), password: PASSWORD, isAdmin: true });

      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/auth/login', () => {
    it('returns a token and safe identity for valid credentials', async () => {
      const res = await login(email('admin'));

      expect(res.status).toBe(200);
      expect(typeof res.body.accessToken).toBe('string');
      expect(res.body.user.id).toBe(adminId);
      expect(res.body.user.role).toBe('ADMIN');
      expect(res.text).not.toContain('passwordHash');
    });

    it('rejects a wrong password with a generic 401', async () => {
      const res = await login(email('agent'), 'WrongPass123');

      expect(res.status).toBe(401);
      expect(res.body.message).toBe('Invalid email or password');
    });

    it('rejects an unknown email with the same generic 401', async () => {
      const res = await login(email('ghost'), PASSWORD);

      expect(res.status).toBe(401);
      expect(res.body.message).toBe('Invalid email or password');
    });

    it('rejects an inactive account with 401', async () => {
      const res = await login(email('inactive'));

      expect(res.status).toBe(401);
    });

    it('rejects a malformed body with 400', async () => {
      const res = await request(server())
        .post('/api/auth/login')
        .send({ email: email('admin') });

      expect(res.status).toBe(400);
    });
  });

  describe('JWT validation', () => {
    it('rejects a protected request without a token (401)', async () => {
      const res = await request(server()).get('/api/auth/me');
      expect(res.status).toBe(401);
    });

    it('accepts a valid token', async () => {
      const res = await request(server())
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(adminId);
      expect(res.body.passwordHash).toBeUndefined();
    });

    it('rejects an expired token (401)', async () => {
      const expired = signer.sign(
        { sub: adminId, email: email('admin'), role: Role.ADMIN },
        { expiresIn: '-1s' },
      );
      const res = await request(server())
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${expired}`);

      expect(res.status).toBe(401);
    });

    it('rejects a token signed with the wrong secret (401)', async () => {
      const forged = wrongSigner.sign({ sub: adminId, email: email('admin'), role: Role.ADMIN });
      const res = await request(server())
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${forged}`);

      expect(res.status).toBe(401);
    });

    it('rejects a previously valid token once the user is deactivated (401)', async () => {
      await prisma.user.update({ where: { id: agentId }, data: { isActive: false } });

      const res = await request(server())
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${agentToken}`);

      expect(res.status).toBe(401);

      await prisma.user.update({ where: { id: agentId }, data: { isActive: true } });
    });
  });

  describe('authorization (roles)', () => {
    it('rejects unauthenticated admin access (401)', async () => {
      const res = await request(server()).get('/api/users');
      expect(res.status).toBe(401);
    });

    it('rejects AGENT access to an ADMIN endpoint (403)', async () => {
      const res = await request(server())
        .get('/api/users')
        .set('Authorization', `Bearer ${agentToken}`);

      expect(res.status).toBe(403);
    });

    it('allows ADMIN to list users without exposing passwordHash', async () => {
      const res = await request(server())
        .get('/api/users')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.total).toBeGreaterThan(0);
      expect(res.text).not.toContain('passwordHash');
    });

    it('lets ADMIN create an AGENT that can log in', async () => {
      const mail = email('managed');
      const res = await request(server())
        .post('/api/users')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ email: mail, password: PASSWORD, name: 'Managed Agent' });

      expect(res.status).toBe(201);
      expect(res.body.role).toBe('AGENT');
      expect(res.body.passwordHash).toBeUndefined();

      const loginRes = await login(mail);
      expect(loginRes.status).toBe(200);
    });

    it('prevents ADMIN from creating another ADMIN (403)', async () => {
      const res = await request(server())
        .post('/api/users')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ email: email('eviladmin'), password: PASSWORD, role: 'ADMIN' });

      expect(res.status).toBe(403);
    });

    it('filters and paginates the user list', async () => {
      const res = await request(server())
        .get('/api/users?role=AGENT&limit=1&page=1')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.limit).toBe(1);
      expect(res.body.data.length).toBeLessThanOrEqual(1);
    });

    it('rejects an invalid UUID path parameter (400)', async () => {
      const res = await request(server())
        .patch('/api/users/not-a-uuid/deactivate')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(400);
    });

    it('returns 404 for a valid but unknown UUID', async () => {
      const res = await request(server())
        .patch('/api/users/00000000-0000-4000-8000-000000000000/deactivate')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(404);
    });

    it('deactivates and reactivates an AGENT', async () => {
      const deactivate = await request(server())
        .patch(`/api/users/${agentId}/deactivate`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(deactivate.status).toBe(200);
      expect(deactivate.body.isActive).toBe(false);

      const blocked = await login(email('agent'));
      expect(blocked.status).toBe(401);

      const again = await request(server())
        .patch(`/api/users/${agentId}/deactivate`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(again.status).toBe(409);

      const reactivate = await request(server())
        .patch(`/api/users/${agentId}/reactivate`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(reactivate.status).toBe(200);
      expect(reactivate.body.isActive).toBe(true);

      const ok = await login(email('agent'));
      expect(ok.status).toBe(200);
    });

    it('prevents an ADMIN from deactivating themselves (400)', async () => {
      const res = await request(server())
        .patch(`/api/users/${adminId}/deactivate`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(400);
    });

    it('prevents deactivating another ADMIN (403)', async () => {
      const res = await request(server())
        .patch(`/api/users/${secondAdminId}/deactivate`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(403);
    });
  });

  describe('query validation', () => {
    it('rejects an invalid role filter (400)', async () => {
      const res = await request(server())
        .get('/api/users?role=SUPERADMIN')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(400);
    });

    it('rejects a non-numeric page (400)', async () => {
      const res = await request(server())
        .get('/api/users?page=abc')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(400);
    });
  });

  describe('brute-force throttle', () => {
    it('locks the login key after repeated failures (429)', async () => {
      const mail = email('brute');

      let lastStatus = 0;
      for (let i = 0; i < 5; i += 1) {
        lastStatus = (await login(mail, 'WrongPass123')).status;
      }
      expect(lastStatus).toBe(401);

      const blocked = await login(mail, 'WrongPass123');
      expect(blocked.status).toBe(429);
    });
  });
});
