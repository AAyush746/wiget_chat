import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Role } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { PasswordService } from '../src/security/password.service';

/**
 * The visitor must never be left in silence. Historically the agent went quiet
 * for the rest of a conversation after its first escalation: once a thread
 * flipped to HANDOFF_PENDING no further AI job was enqueued, so every later
 * visitor message went unanswered forever. These tests pin the fixed contract.
 */

const TAG = 'ai-ack';
const TEST_DOMAIN = 'chatflow.test';
const PASSWORD = 'Passw0rd123';
const ACKNOWLEDGEMENT = 'Thanks for your message! A member of our team will be with you shortly.';

const email = (name: string): string => `${name}-${TAG}@${TEST_DOMAIN}`;
const domain = (name: string): string => `${name}-${TAG}.${TEST_DOMAIN}`;

/** Polls the thread until `count` messages have landed (or we give up). */
async function waitForMessages(
  fetch: () => Promise<request.Response>,
  count: number,
  timeoutMs = 15_000,
): Promise<Array<{ senderType: string; content: string; createdAt: string }>> {
  const deadline = Date.now() + timeoutMs;
  let data: Array<{ senderType: string; content: string; createdAt: string }> = [];
  while (Date.now() < deadline) {
    const latest = await fetch();
    data = latest.body?.data ?? [];
    if (data.length >= count) return data;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return data;
}

describe('AI agent acknowledgement (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let adminToken: string;
  let siteId: string;
  let publicKey: string;

  const server = () => app.getHttpServer();
  const websiteFilter = { domain: { endsWith: `-${TAG}.${TEST_DOMAIN}` } };

  const newVisitor = async (name: string) => {
    const res = await request(server())
      .post(`/api/public/websites/${publicKey}/visitor`)
      .send({ name })
      .expect(201);
    return res.body.visitorKey as string;
  };

  const newConversation = async (visitorKey: string) => {
    const res = await request(server())
      .post(`/api/public/websites/${publicKey}/conversations`)
      .send({ visitorKey })
      .expect(201);
    return res.body.id as string;
  };

  const sendAsVisitor = (visitorKey: string, conversationId: string, content: string) =>
    request(server())
      .post(
        `/api/public/websites/${publicKey}/visitor/${visitorKey}/conversations/${conversationId}/messages`,
      )
      .send({ content });

  const thread = (visitorKey: string, conversationId: string) =>
    request(server()).get(
      `/api/public/websites/${publicKey}/visitor/${visitorKey}/conversations/${conversationId}/messages`,
    );

  const staffThread = (conversationId: string) =>
    request(server())
      .get(`/api/websites/${siteId}/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${adminToken}`);

  const staffSend = (conversationId: string, content: string) =>
    request(server())
      .post(`/api/websites/${siteId}/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ content });

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
      data: { email: email('admin'), role: Role.ADMIN, passwordHash: hash, name: 'AI Admin' },
    });

    const login = await request(server())
      .post('/api/auth/login')
      .send({ email: email('admin'), password: PASSWORD })
      .expect(200);
    adminToken = login.body.accessToken;

    const website = await request(server())
      .post('/api/websites')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'AI Ack Site', domain: domain('site') })
      .expect(201);

    siteId = website.body.id;
    publicKey = website.body.publicKey;

    await request(server())
      .patch(`/api/websites/${siteId}/ai`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ aiEnabled: true, aiFallbackMessage: ACKNOWLEDGEMENT })
      .expect(200);
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

  it('acknowledges every visitor message after the thread has been escalated', async () => {
    const visitorKey = await newVisitor('Escalated Visitor');
    const conversationId = await newConversation(visitorKey);

    // 1. An explicit human request escalates immediately (no model call).
    await sendAsVisitor(visitorKey, conversationId, 'please let me talk to a human').expect(201);

    const escalated = await waitForMessages(() => thread(visitorKey, conversationId), 2);
    expect(escalated.map((m) => m.senderType)).toEqual(['VISITOR', 'AI']);
    expect(escalated[1]?.content).toBe(ACKNOWLEDGEMENT);

    const conversation = await prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
    });
    expect(conversation.handling).toBe('HANDOFF_PENDING');

    // 2. Every later visitor message must still get the acknowledgement — this
    //    is the regression: previously these produced permanent silence.
    for (const followUp of ['hi', 'hello', 'are you there?']) {
      const before = (await waitForMessages(() => thread(visitorKey, conversationId), 0)).length;
      await sendAsVisitor(visitorKey, conversationId, followUp).expect(201);

      const msgs = await waitForMessages(() => thread(visitorKey, conversationId), before + 2);
      const last = msgs[msgs.length - 1];
      expect(last).toBeDefined();
      expect(last?.senderType).toBe('AI');
      expect(last?.content).toBe(ACKNOWLEDGEMENT);
    }

    // 3. The thread is still queued for a human — acknowledging must not steal it.
    const after = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    expect(after.handling).toBe('HANDOFF_PENDING');
  });

  it('goes silent once a staff member actually replies', async () => {
    const visitorKey = await newVisitor('Human Took Over');
    const conversationId = await newConversation(visitorKey);

    await sendAsVisitor(visitorKey, conversationId, 'please let me talk to a human').expect(201);
    await waitForMessages(() => thread(visitorKey, conversationId), 2);

    await staffSend(conversationId, 'Hi, a human is on the way.').expect(201);
    const claimed = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    expect(claimed.handling).toBe('HUMAN');

    await sendAsVisitor(visitorKey, conversationId, 'any update?').expect(201);

    // Give the worker a chance to (wrongly) reply.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const msgs = await staffThread(conversationId);
    const agentReplies = msgs.body.data.filter(
      (m: { senderType: string }) => m.senderType === 'AI',
    );
    const lastAgentReplyAt = agentReplies[agentReplies.length - 1]?.createdAt;
    const visitorUpdateAt = msgs.body.data.find(
      (m: { content: string }) => m.content === 'any update?',
    )?.createdAt;

    // No AI message may be posted after the visitor's last message.
    expect(lastAgentReplyAt === undefined || visitorUpdateAt > lastAgentReplyAt).toBe(true);
  });
});
