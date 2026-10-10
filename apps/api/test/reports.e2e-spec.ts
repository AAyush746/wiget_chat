import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Role } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { PasswordService } from '../src/security/password.service';

const TAG = 'reports';
const TEST_DOMAIN = 'chatflow.test';
const PASSWORD = 'Passw0rd123';

const email = (name: string): string => `${name}-${TAG}@${TEST_DOMAIN}`;
const domain = (name: string): string => `${name}-${TAG}.${TEST_DOMAIN}`;

describe('Reporting API (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let adminToken: string;
  let outsiderToken: string;
  let siteId: string;

  const server = () => app.getHttpServer();
  const websiteFilter = { domain: { endsWith: `-${TAG}.${TEST_DOMAIN}` } };

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
      data: { email: email('admin'), role: Role.ADMIN, passwordHash: hash, name: 'Rep Admin' },
    });
    // Not a member of the reporting website: must not be able to read it.
    await prisma.user.create({
      data: {
        email: email('outsider'),
        role: Role.AGENT,
        passwordHash: hash,
        name: 'Rep Outsider',
      },
    });

    adminToken = (
      await request(server())
        .post('/api/auth/login')
        .send({ email: email('admin'), password: PASSWORD })
    ).body.accessToken;
    outsiderToken = (
      await request(server())
        .post('/api/auth/login')
        .send({ email: email('outsider'), password: PASSWORD })
    ).body.accessToken;

    const site = await request(server())
      .post('/api/websites')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Report Site', domain: domain('site') })
      .expect(201);
    siteId = site.body.id;

    await seed();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

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

  /** Two conversations: one AI-answered, one escalated then answered by staff. */
  const seed = async (): Promise<void> => {
    const agent = await prisma.user.findUniqueOrThrow({ where: { email: email('admin') } });
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3600 * 1000);

    for (const spec of [
      { ai: true, closed: false, offsetH: 5 },
      { ai: false, closed: true, offsetH: 2 },
    ]) {
      const visitor = await prisma.visitor.create({
        data: { websiteId: siteId, visitorKey: `rep-${spec.offsetH}-${Math.random()}`, name: 'V' },
      });
      const conversation = await prisma.conversation.create({
        data: {
          websiteId: siteId,
          visitorId: visitor.id,
          status: spec.closed ? 'CLOSED' : 'OPEN',
          handling: spec.ai ? 'AI' : 'HUMAN',
          createdAt: hoursAgo(spec.offsetH),
          closedAt: spec.closed ? hoursAgo(spec.offsetH - 1) : null,
          lastMessageAt: hoursAgo(spec.offsetH - 1),
        },
      });
      await prisma.message.create({
        data: {
          conversationId: conversation.id,
          senderType: 'VISITOR',
          visitorId: visitor.id,
          content: 'hello',
          createdAt: hoursAgo(spec.offsetH),
        },
      });
      if (spec.ai) {
        await prisma.message.create({
          data: {
            conversationId: conversation.id,
            senderType: 'AI',
            content: 'Here is your answer.',
            createdAt: hoursAgo(spec.offsetH - 0.5),
          },
        });
      } else {
        await prisma.conversationAssignment.create({
          data: {
            conversationId: conversation.id,
            userId: agent.id,
            assignedAt: hoursAgo(spec.offsetH),
          },
        });
        await prisma.message.create({
          data: {
            conversationId: conversation.id,
            senderType: 'AGENT',
            userId: agent.id,
            content: 'A human replied.',
            createdAt: hoursAgo(spec.offsetH - 0.5),
          },
        });
      }
    }
  };

  const get = (path: string, token = adminToken) =>
    request(server()).get(path).set('Authorization', `Bearer ${token}`);

  it('returns headline KPIs for the window', async () => {
    const res = await get(`/api/websites/${siteId}/reports/summary`).expect(200);

    expect(res.body.conversationsCreated).toBe(2);
    expect(res.body.conversationsClosed).toBe(1);
    expect(res.body.open).toBe(1);
    expect(res.body.closed).toBe(1);
    expect(res.body.aiHandled).toBe(1);
    expect(res.body.aiMessages).toBe(1);
    expect(res.body.agentMessages).toBe(1);
    expect(res.body.avgFirstResponseMs).toBeGreaterThan(0);
    expect(res.body.aiHandlingRate).toBeCloseTo(0.5, 3);
    expect(res.body.from).toEqual(expect.any(String));
    expect(res.body.to).toEqual(expect.any(String));
  });

  it('buckets the volume series and keeps every point on the axis', async () => {
    const res = await get(`/api/websites/${siteId}/reports/timeseries?bucket=day`).expect(200);

    expect(res.body.bucket).toBe('day');
    // A 30-day window is always 31 buckets, gaps included.
    expect(res.body.points).toHaveLength(31);
    expect(
      res.body.points.reduce(
        (n: number, p: { conversationsCreated: number }) => n + p.conversationsCreated,
        0,
      ),
    ).toBe(2);
  });

  it('auto-selects a bucket that keeps the series small', async () => {
    const res = await get(`/api/websites/${siteId}/reports/timeseries`).expect(200);
    expect(['hour', 'day', 'week']).toContain(res.body.bucket);
    expect(res.body.points.length).toBeLessThanOrEqual(400);
  });

  it('rejects a bucket that would explode the series', async () => {
    const res = await get(
      `/api/websites/${siteId}/reports/timeseries?bucket=hour&from=${new Date(
        Date.now() - 30 * 864e5,
      ).toISOString()}`,
    ).expect(400);
    expect(res.body.message).toMatch(/bucket=hour/);
  });

  it('reports per-agent workload from the assignment history', async () => {
    const res = await get(`/api/websites/${siteId}/reports/agents`).expect(200);

    expect(res.body.data).toHaveLength(1);
    const row = res.body.data[0];
    expect(row.email).toBe(email('admin'));
    expect(row.assigned).toBe(1);
    expect(row.resolved).toBe(1);
    expect(row.agentMessages).toBe(1);
    expect(row.avgFirstResponseMs).toBeGreaterThan(0);
  });

  it('lists conversations with response timings', async () => {
    const res = await get(`/api/websites/${siteId}/reports/conversations`).expect(200);

    expect(res.body.total).toBe(2);
    expect(res.body.data).toHaveLength(2);
    for (const row of res.body.data) {
      expect(row.messageCount).toBeGreaterThanOrEqual(2);
    }

    // A conversation only ever answered by the AI has no human first response,
    // which must surface as null rather than 0 (0 would read as "instant").
    const aiOnly = res.body.data.find((r: { handling: string }) => r.handling === 'AI');
    expect(aiOnly).toBeDefined();
    expect(aiOnly.firstResponseMs).toBeNull();

    const human = res.body.data.find((r: { handling: string }) => r.handling === 'HUMAN');
    expect(human.firstResponseMs).toBeGreaterThan(0);
    expect(human.resolutionMs).toBeGreaterThan(0);
  });

  it('exports CSV with headers and one row per conversation', async () => {
    const res = await get(`/api/websites/${siteId}/reports/export.csv`).expect(200);

    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('attachment; filename="chatflow-report-');

    const lines = res.text.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toContain('conversation_id');
    expect(lines[0]).toContain('first_response_seconds');
    expect(lines).toHaveLength(3); // header + 2 conversations
  });

  it('neutralizes spreadsheet formula injection in exported cells', async () => {
    await prisma.conversation.updateMany({
      where: { websiteId: siteId },
      data: { subject: '=cmd|calc' },
    });

    const res = await get(`/api/websites/${siteId}/reports/export.csv`).expect(200);
    const body = res.text.replace(/^﻿/, '');
    expect(body).toContain("'=cmd|calc");
    expect(body).not.toMatch(/,=cmd/);

    await prisma.conversation.updateMany({
      where: { websiteId: siteId },
      data: { subject: null },
    });
  });

  it('serves summary, timeseries, agents and conversations in one overview call', async () => {
    const res = await get(`/api/websites/${siteId}/reports/overview`).expect(200);

    expect(res.body.summary).toBeDefined();
    expect(res.body.timeseries.points.length).toBeGreaterThan(0);
    expect(Array.isArray(res.body.agents)).toBe(true);
  });

  it('rejects an inverted or oversized window', async () => {
    await get(
      `/api/websites/${siteId}/reports/summary?from=2026-10-10T00:00:00Z&to=2026-01-01T00:00:00Z`,
    ).expect(400);
    await get(`/api/websites/${siteId}/reports/summary?from=2000-01-01T00:00:00Z`).expect(400);
    await get(`/api/websites/${siteId}/reports/timeseries?bucket=fortnight`).expect(400);
  });

  it('is read-only: write methods are not routed', async () => {
    await request(server())
      .post(`/api/websites/${siteId}/reports/summary`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
      .expect(404);
    await request(server())
      .delete(`/api/websites/${siteId}/reports/summary`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(404);
  });

  it('enforces authentication and tenant scoping', async () => {
    await request(server()).get(`/api/websites/${siteId}/reports/summary`).expect(401);

    // An authenticated agent who is not a member is refused. This matches the
    // app-wide convention: 404 only when the website does not exist at all.
    await get(`/api/websites/${siteId}/reports/summary`, outsiderToken).expect(403);
    await get(`/api/websites/${siteId}/reports/export.csv`, outsiderToken).expect(403);

    await get('/api/websites/not-a-uuid/reports/summary').expect(400);
    await get('/api/websites/00000000-0000-4000-8000-000000000000/reports/summary').expect(404);
  });
});
