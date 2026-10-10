import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { AiJob } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { MessagesService } from '../conversations/messages.service';
import { AiService } from './ai.service';
import {
  AI_DEFAULT_FALLBACK_MESSAGE,
  AI_JOB_LEASE_MS,
  AI_JOB_MAX_ATTEMPTS,
  AI_WORKER_INTERVAL_MS,
} from './ai.constants';

import type { HandoffReason } from '@chatflow/types';

@Injectable()
export class AiWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AiWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
    private readonly messages: MessagesService,
  ) {}

  onModuleInit() {
    this.start();
  }

  onModuleDestroy() {
    this.stop();
  }

  start() {
    if (this.timer) return;
    const interval = AI_WORKER_INTERVAL_MS;
    this.timer = setInterval(() => this.tick().catch((e) => this.logger.error(e)), interval);
    void this.tick().catch((e) => this.logger.error(e));
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const now = new Date();
      const leaseUntil = new Date(now.getTime() - AI_JOB_LEASE_MS);
      const jobs = await this.prisma.aiJob.findMany({
        where: {
          status: { in: ['PENDING', 'RUNNING'] },
          OR: [
            { status: 'PENDING', availableAt: { lte: now } },
            { status: 'RUNNING', leasedAt: { lte: leaseUntil } },
          ],
        },
        take: 5,
        orderBy: { createdAt: 'asc' },
      });

      for (const job of jobs) {
        await this.processJob(job).catch((e) => this.logger.error(`job ${job.id}`, e as any));
      }
    } finally {
      this.running = false;
    }
  }

  private async processJob(job: AiJob) {
    const leaseToken = randomUUID();
    const now = new Date();

    const claimed = await this.prisma.aiJob.updateMany({
      where: {
        id: job.id,
        status: job.status,
        ...(job.status === 'RUNNING' && job.leaseToken ? { leaseToken: job.leaseToken } : {}),
      },
      data: {
        status: 'RUNNING',
        leaseToken,
        leasedAt: now,
        attempts: { increment: 1 },
      },
    });

    if (claimed.count === 0) return;

    const leased = await this.prisma.aiJob.findUnique({ where: { id: job.id } });
    if (!leased || leased.leaseToken !== leaseToken || leased.status !== 'RUNNING') return;

    const conversation = await this.prisma.conversation.findUnique({
      where: { id: job.conversationId },
    });
    if (!conversation) {
      await this.finalizeFailed(leased, 'Conversation not found');
      return;
    }

    if (conversation.handling === 'HUMAN') {
      // A staff member owns the thread: never speak over them.
      await this.prisma.aiJob.update({
        where: { id: leased.id },
        data: { status: 'CANCELLED' },
      });
      return;
    }

    if (conversation.handling === 'HANDOFF_PENDING') {
      // Already escalated and waiting for a human. Do not call the model and do
      // not re-open the thread — just acknowledge so the visitor is never left
      // in silence after their first escalation.
      await this.messages.acknowledgeAiJob(leased, await this.fallbackFor(conversation.websiteId));
      return;
    }

    if (conversation.handling !== 'AI') {
      await this.prisma.aiJob.update({
        where: { id: leased.id },
        data: { status: 'CANCELLED' },
      });
      return;
    }

    const msg = await this.prisma.message.findUnique({
      where: { id: job.messageId },
    });
    if (!msg) {
      await this.finalizeFailed(leased, 'Message not found');
      return;
    }

    const history = await this.getHistory(conversation.id);
    const res = await this.ai.generate({
      websiteId: conversation.websiteId,
      conversationId: conversation.id,
      messageContent: msg.content,
      conversationHistory: history,
    });

    if (!res.grounded || !res.content) {
      const reason: HandoffReason =
        res.reason === 'AI_FAILURE'
          ? 'AI_FAILURE'
          : res.reason === 'LIMIT_REACHED'
            ? 'LIMIT_REACHED'
            : 'UNSUPPORTED';
      await this.messages.escalateAiJob(leased, {
        reason,
        fallback: await this.fallbackFor(conversation.websiteId),
      });
      return;
    }

    const posted = await this.messages.createAiReply(leased, res.content);
    if (!posted) {
      if (leased.attempts >= AI_JOB_MAX_ATTEMPTS) {
        await this.messages.escalateAiJob(leased, {
          reason: 'AI_FAILURE',
          fallback: await this.fallbackFor(conversation.websiteId),
        });
      } else {
        await this.retryLater(leased);
      }
    }
  }

  /**
   * The website's configured escalation reply, falling back to the shared
   * default so a visitor is never left without an acknowledgement.
   */
  private async fallbackFor(websiteId: string): Promise<string> {
    const website = await this.prisma.website.findUnique({
      where: { id: websiteId },
      select: { aiFallbackMessage: true },
    });
    return website?.aiFallbackMessage?.trim() || AI_DEFAULT_FALLBACK_MESSAGE;
  }

  private async getHistory(conversationId: string) {
    const msgs = await this.prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });
    return msgs.reverse().map((m) => ({
      role: m.senderType === 'VISITOR' ? ('user' as const) : ('assistant' as const),
      content: m.content,
    }));
  }

  private async finalizeFailed(job: AiJob, error: string) {
    await this.prisma.aiJob.update({
      where: { id: job.id },
      data: { status: 'FAILED', lastError: error.substring(0, 500) },
    });
  }

  private async retryLater(job: AiJob) {
    const delay = Math.min(60000, 2000 * Math.pow(2, Math.max(0, job.attempts - 1)));
    await this.prisma.aiJob.update({
      where: { id: job.id },
      data: {
        status: 'PENDING',
        availableAt: new Date(Date.now() + delay),
        leaseToken: null,
        leasedAt: null,
      },
    });
  }
}
