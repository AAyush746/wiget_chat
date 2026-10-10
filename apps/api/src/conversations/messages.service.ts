import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ConversationStatus,
  MessageSender,
  Prisma,
  type AiJob,
  type Conversation,
  type Visitor,
  type Website,
} from '@prisma/client';
import type {
  AuthUser,
  ChatMessage,
  CursorPage,
  HandoffReason,
  MessageSendResult,
} from '@chatflow/types';
import { isExplicitHumanRequest } from '../ai/human-request';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { VisitorsService } from '../visitors/visitors.service';
import { ConversationsService } from './conversations.service';
import { toPublicConversation } from './conversation.mapper';
import { decodeMessageCursor, encodeMessageCursor } from './message-cursor';
import { messageInclude, toChatMessage, type MessageWithSenders } from './message.mapper';
import type { CreateMessageDto } from './dto/create-message.dto';
import type { ListMessagesQueryDto } from './dto/list-messages-query.dto';

/** Who is writing: derived from the authenticated principal, never the body. */
type MessageAuthor = { kind: 'visitor'; visitor: Visitor } | { kind: 'staff'; user: AuthUser };

interface SendOutcome {
  message: MessageWithSenders;
  conversation: Conversation | null;
  replay: boolean;
  /** The conversation's handling state changed as a side effect of the write. */
  handlingChanged: boolean;
}

/** Guards the "finalize this job" compare-and-swap inside AI writes. */
class AiJobAlreadyFinalizedError extends Error {}

/** Recorded escalation codes for conversation handling transitions. */
const HANDOFF_REASONS = {
  VISITOR_REQUESTED: 'VISITOR_REQUESTED',
  UNSUPPORTED: 'UNSUPPORTED',
  LOW_CONFIDENCE: 'LOW_CONFIDENCE',
  AI_FAILURE: 'AI_FAILURE',
  LIMIT_REACHED: 'LIMIT_REACHED',
} as const satisfies Record<string, HandoffReason>;

/**
 * The idempotency key is already taken, but by a *different* principal. The
 * colliding sender keeps their key semantics intact (their retry cannot adopt
 * someone else's message, which would both disclose it and silently drop
 * their own), so the write is rejected. REST reports 409; the gateway maps
 * this subtype to `CONFLICT` so it is not mistaken for a closed thread.
 */
export class ClientMessageIdConflictException extends ConflictException {
  constructor() {
    super('clientMessageId is already in use');
    this.name = 'ClientMessageIdConflictException';
  }
}

/**
 * Message persistence — the single write path for chat messages.
 *
 * Both REST controllers and the WebSocket gateway call this service, so a
 * message created over Socket.IO and one created over HTTP go through the
 * identical authorization chain and the identical transaction:
 *
 *   authorize sender → load conversation (tenant/ownership scoped)
 *   → reject CLOSED (409) → [tx: idempotency check, insert message,
 *   update lastMessageAt (+ PENDING→OPEN for visitor sends),
 *   insert MESSAGE_SENT event] → commit → publish `message:new`.
 *
 * The realtime notification is published strictly *after* commit; a rollback
 * emits nothing, and a lost realtime event is recoverable from REST history —
 * the database, not Socket.IO, is the source of truth.
 */
@Injectable()
export class MessagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly conversations: ConversationsService,
    private readonly visitors: VisitorsService,
    private readonly realtime: RealtimeService,
  ) {}

  // ------------------------------------------------- visitor (public API)

  async createForVisitor(
    publicKey: string,
    visitorKey: string,
    conversationId: string,
    dto: CreateMessageDto,
  ): Promise<MessageSendResult> {
    // Full re-validation on every send: active website, tenant binding,
    // then ownership of the conversation (indistinguishable 404 otherwise).
    const visitor = await this.visitors.resolveVisitor(publicKey, visitorKey);
    const conversation = await this.conversations.resolveVisitorConversation(
      visitor,
      conversationId,
    );
    return this.persist(conversation, { kind: 'visitor', visitor }, dto);
  }

  async listForVisitor(
    publicKey: string,
    visitorKey: string,
    conversationId: string,
    query: ListMessagesQueryDto,
  ): Promise<CursorPage<ChatMessage>> {
    const visitor = await this.visitors.resolveVisitor(publicKey, visitorKey);
    const conversation = await this.conversations.resolveVisitorConversation(
      visitor,
      conversationId,
    );
    return this.loadPage(conversation.id, query);
  }

  // ----------------------------------------------------- staff (dashboard)

  /**
   * @param authorizedWebsiteId set by REST (guard-authorized website from the
   * route); omitted by the WebSocket path, which only knows the conversation
   * id. A mismatch is an indistinguishable 404 so a foreign conversation id
   * can never be probed through a website the caller does own.
   */
  async createForStaff(
    user: AuthUser,
    conversationId: string,
    dto: CreateMessageDto,
    authorizedWebsiteId?: string,
  ): Promise<MessageSendResult> {
    const { conversation, website } = await this.conversations.resolveStaffConversation(
      user,
      conversationId,
      authorizedWebsiteId,
    );

    // Staff may *read* a deactivated website (Phase 4 policy) but writing
    // into one would produce messages the widget can never display.
    if (!website.isActive) {
      throw new ForbiddenException('Website is deactivated');
    }

    return this.persist(conversation, { kind: 'staff', user }, dto);
  }

  async listForStaff(
    website: Website,
    conversationId: string,
    query: ListMessagesQueryDto,
  ): Promise<CursorPage<ChatMessage>> {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
    });

    if (!conversation || conversation.websiteId !== website.id) {
      throw new NotFoundException('Conversation not found');
    }

    return this.loadPage(conversation.id, query);
  }

  // --------------------------------------------------------------- internals

  private async persist(
    conversation: Conversation,
    author: MessageAuthor,
    dto: CreateMessageDto,
  ): Promise<MessageSendResult> {
    if (conversation.status === ConversationStatus.CLOSED) {
      throw new ConflictException('Conversation is closed');
    }

    // MVP lifecycle rule: a visitor replying to a PENDING thread (waiting on
    // the visitor) brings it back to OPEN. An agent's message never changes
    // status — PENDING continues to mean "waiting for the visitor".
    const reopen = author.kind === 'visitor' && conversation.status === ConversationStatus.PENDING;

    const outcome = await this.sendInTransaction(conversation, author, dto, reopen);

    if (!outcome.replay) {
      this.realtime.publishMessageNew(
        {
          conversationId: conversation.id,
          message: toChatMessage(outcome.message),
        },
        conversation.websiteId,
      );
      if (outcome.conversation && (reopen || outcome.handlingChanged)) {
        this.realtime.publishConversationUpdated(
          toPublicConversation(outcome.conversation),
          conversation.websiteId,
        );
      }
    }

    return { message: toChatMessage(outcome.message), replay: outcome.replay };
  }

  /**
   * The atomic unit: message row, conversation timestamp/state and audit
   * event all land together or not at all.
   *
   * Idempotency is scoped to (conversation, clientMessageId, sender): a
   * retry only resolves to the original row when the *same principal* is
   * repeating their own send — a message found under the key but written by
   * another principal is never adopted or returned (409 `CONFLICT`), so a
   * retried send can neither disclose someone else's message nor silently
   * drop the sender's own. The unique constraint on clientMessageId is the
   * collision detector; the sender check is the authorization boundary.
   */
  private async sendInTransaction(
    conversation: Conversation,
    author: MessageAuthor,
    dto: CreateMessageDto,
    reopen: boolean,
  ): Promise<SendOutcome> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        if (dto.clientMessageId) {
          const existing = await tx.message.findFirst({
            where: { conversationId: conversation.id, clientMessageId: dto.clientMessageId },
            include: messageInclude,
          });
          if (existing) {
            return this.adoptOrReject(existing, author);
          }
        }

        const message = await tx.message.create({
          data: {
            conversationId: conversation.id,
            senderType: author.kind === 'visitor' ? MessageSender.VISITOR : MessageSender.AGENT,
            visitorId: author.kind === 'visitor' ? author.visitor.id : null,
            userId: author.kind === 'staff' ? author.user.id : null,
            content: dto.content,
            clientMessageId: dto.clientMessageId ?? null,
          },
          include: messageInclude,
        });

        const updated = await tx.conversation.update({
          where: { id: conversation.id },
          data: {
            lastMessageAt: message.createdAt,
            ...(reopen ? { status: ConversationStatus.OPEN } : {}),
          },
        });

        await tx.conversationEvent.create({
          data: {
            conversationId: conversation.id,
            websiteId: conversation.websiteId,
            type: 'MESSAGE_SENT',
            actorVisitorId: author.kind === 'visitor' ? author.visitor.id : null,
            actorUserId: author.kind === 'staff' ? author.user.id : null,
            metadata: { messageId: message.id },
          },
        });

        const handlingChanged = await this.applyHandlingSideEffects(
          tx,
          conversation,
          author,
          message,
        );

        // Re-read so the published conversation reflects handling changes made
        // above (staff takeover, visitor-requested handoff) in one consistent
        // snapshot alongside timestamps.
        const finalConversation = handlingChanged
          ? await tx.conversation.findUniqueOrThrow({ where: { id: conversation.id } })
          : updated;

        return { message, conversation: finalConversation, replay: false, handlingChanged };
      });
    } catch (error) {
      // Lost the race against a concurrent duplicate carrying the same key:
      // the winning attempt's row holds the unique constraint. Adopt it only
      // if it belongs to this sender; otherwise surface the conflict.
      if (dto.clientMessageId && isClientMessageIdConflict(error)) {
        const existing = await this.prisma.message.findFirst({
          where: { conversationId: conversation.id, clientMessageId: dto.clientMessageId },
          include: messageInclude,
        });
        if (existing) {
          return this.adoptOrReject(existing, author);
        }
      }
      throw error;
    }
  }

  /**
   * Shared by the happy-path pre-check and the post-race refetch so both
   * agree: adopt only this sender's own message, never another principal's.
   */
  private adoptOrReject(existing: MessageWithSenders, author: MessageAuthor): SendOutcome {
    if (
      author.kind === 'visitor'
        ? existing.senderType === MessageSender.VISITOR && existing.visitorId === author.visitor.id
        : existing.senderType === MessageSender.AGENT && existing.userId === author.user.id
    ) {
      return { message: existing, conversation: null, replay: true, handlingChanged: false };
    }
    throw new ClientMessageIdConflictException();
  }

  /**
   * Recomputes the conversation's handling state for a new message and applies
   * any change inside the same transaction as the message insert:
   *
   * - A visitor's routine message on an AI-handled thread enqueues an AI reply
   *   job (idempotently — one job per message, the unique messageId is the
   *   dedupe). This is done here so a crash between the insert and the enqueue
   *   can never lose the work.
   * - An explicit visitor "talk to a human" request hands the thread off from
   *   AI without ever billing an AI call.
   * - A staff message is an explicit human takeover: the thread is permanently
   *   in HUMAN handling (no auto-resume) and queued AI work is cancelled.
   *
   * Returns true when `conversation.handling` changed.
   */
  private async applyHandlingSideEffects(
    tx: Prisma.TransactionClient,
    conversation: Conversation,
    author: MessageAuthor,
    message: MessageWithSenders,
  ): Promise<boolean> {
    if (author.kind === 'staff') {
      if (conversation.handling === 'HUMAN') {
        return false;
      }
      await tx.conversation.update({
        where: { id: conversation.id },
        data: { handling: 'HUMAN', handoffRequestedAt: null, handoffReason: null },
      });
      await tx.aiJob.updateMany({
        where: { conversationId: conversation.id, status: 'PENDING' },
        data: { status: 'CANCELLED' },
      });
      return true;
    }

    // ---- visitor send
    const website = await tx.website.findUnique({
      where: { id: conversation.websiteId },
      select: { aiEnabled: true, isActive: true },
    });

    if (!website?.isActive) {
      return false;
    }

    // Honor a human request even when AI is disabled — handoff is a routing
    // decision, not a model capability, and it must never cost an API call.
    // It deliberately falls through to the enqueue below so the visitor still
    // receives the acknowledgement instead of silence.
    if (isExplicitHumanRequest(message.content) && conversation.handling !== 'HUMAN') {
      const now = new Date();
      await tx.conversation.update({
        where: { id: conversation.id },
        data: {
          handling: 'HANDOFF_PENDING',
          handoffRequestedAt: now,
          handoffReason: HANDOFF_REASONS.VISITOR_REQUESTED,
        },
      });
      conversation.handling = 'HANDOFF_PENDING';
      if (!website.aiEnabled) {
        return true;
      }
    }

    if (
      website.aiEnabled &&
      (conversation.handling === 'AI' || conversation.handling === 'HANDOFF_PENDING')
    ) {
      // The AiJob unique(messageId) constraint is the idempotency boundary:
      // a duplicate enqueue attempt collides and the job already exists.
      //
      // HANDOFF_PENDING still enqueues so the visitor is never left in silence:
      // the worker answers those with a short acknowledgement (see
      // `acknowledgeAiJob`) instead of calling the model, and leaves the thread
      // queued for a human. Only `HUMAN` — a staff member who has actually
      // taken the conversation — silences the agent.
      await tx.aiJob.create({
        data: {
          websiteId: conversation.websiteId,
          conversationId: conversation.id,
          messageId: message.id,
        },
      });
    }

    return false;
  }

  // --------------------------------------------------------- AI worker writes
  //
  // These are the ONLY two paths that write an AI/fallback message. The worker
  // never writes through the generic send* helpers, which would leak AI text
  // through visitor/staff identity checks and resurrect human-takeover rules.

  private throwIfJobFinalized(job: AiJob, status: AiJob['status']): void {
    if (job.status !== 'RUNNING' || job.leaseToken === null) {
      throw new AiJobAlreadyFinalizedError(
        `AiJob ${job.id} is not leased (status=${job.status}, leaseToken=${job.leaseToken})`,
      );
    }
  }

  /**
   * Persists an AI reply for a leased job and marks the job DONE — atomically:
   * the {status: 'RUNNING', leaseToken} predicate is a compare-and-swap, so two
   * workers can never finalize the same job twice, and the reply cannot land
   * without the job being consumed exactly once. Publishes `message:new` only
   * after commit. Returns null when the conversation is no longer replyable
   * (closed, human-taken, or the site was deactivated between claim and now).
   */
  async createAiReply(job: AiJob, content: string): Promise<ChatMessage | null> {
    const trimmed = content?.trim() ?? '';
    if (!trimmed) {
      return null;
    }

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        this.throwIfJobFinalized(job, 'RUNNING');
        const conversation = await tx.conversation.findUnique({
          where: { id: job.conversationId },
        });
        const website = await tx.website.findUnique({
          where: { id: job.websiteId },
          select: { isActive: true },
        });
        if (
          !conversation ||
          conversation.status === ConversationStatus.CLOSED ||
          conversation.handling !== 'AI' ||
          !website?.isActive
        ) {
          // Nothing replyable to: consume the lease so the job is not stuck.
          await tx.aiJob.update({
            where: { id: job.id },
            data: { status: 'DONE' },
          });
          return null;
        }

        const message = await tx.message.create({
          data: {
            conversationId: conversation.id,
            senderType: MessageSender.AI,
            visitorId: null,
            userId: null,
            content: trimmed,
            clientMessageId: null,
          },
          include: messageInclude,
        });
        await tx.conversation.update({
          where: { id: conversation.id },
          data: { lastMessageAt: message.createdAt },
        });
        await tx.conversationEvent.create({
          data: {
            conversationId: conversation.id,
            websiteId: conversation.websiteId,
            type: 'MESSAGE_SENT',
            actorVisitorId: null,
            actorUserId: null,
            metadata: { messageId: message.id, aiReply: true },
          },
        });
        await tx.aiJob.update({
          where: { id: job.id },
          data: { status: 'DONE', replyMessageId: message.id },
        });
        return message;
      });

      if (result) {
        this.realtime.publishMessageNew(
          { conversationId: job.conversationId, message: toChatMessage(result) },
          job.websiteId,
        );
      }
      return result ? toChatMessage(result) : null;
    } catch (error) {
      if (error instanceof AiJobAlreadyFinalizedError) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Ends a job by handing the conversation to a human instead of replying.
   * Records the escalation reason (+ optional fallback message) atomically with
   * marking the job DONE. Returns the fallback ChatMessage when one was
   * written, else null (e.g. the thread is already closed or human-held — the
   * escalating job is simply consumed without side effects).
   */
  async escalateAiJob(
    job: AiJob,
    options: { reason: HandoffReason; fallback?: string | null },
  ): Promise<ChatMessage | null> {
    try {
      const result = await this.prisma.$transaction(async (tx) => {
        this.throwIfJobFinalized(job, 'RUNNING');
        const conversation = await tx.conversation.findUnique({
          where: { id: job.conversationId },
        });
        const website = await tx.website.findUnique({
          where: { id: job.websiteId },
          select: { isActive: true },
        });

        if (
          !conversation ||
          !website?.isActive ||
          conversation.status === ConversationStatus.CLOSED
        ) {
          await tx.aiJob.update({
            where: { id: job.id },
            data: { status: 'DONE' },
          });
          return { message: null, handlingChanged: false };
        }

        const fallback = options.fallback?.trim() ?? '';
        if (conversation.handling === 'HUMAN') {
          // A human already owns the thread: never override their takeover.
          await tx.aiJob.update({
            where: { id: job.id },
            data: { status: 'DONE' },
          });
          if (fallback) {
            this.realtime.publishConversationUpdated(
              toPublicConversation(conversation),
              conversation.websiteId,
            );
          }
          return { message: null, handlingChanged: false };
        }

        const handlingChanged = conversation.handling !== 'HANDOFF_PENDING';
        const now = new Date();
        await tx.conversation.update({
          where: { id: conversation.id },
          data: {
            handling: 'HANDOFF_PENDING',
            handoffRequestedAt: now,
            handoffReason: options.reason,
          },
        });

        let message: MessageWithSenders | null = null;
        if (fallback) {
          message = await tx.message.create({
            data: {
              conversationId: conversation.id,
              senderType: MessageSender.AI,
              visitorId: null,
              userId: null,
              content: fallback,
              clientMessageId: null,
            },
            include: messageInclude,
          });
          await tx.conversation.update({
            where: { id: conversation.id },
            data: { lastMessageAt: message.createdAt },
          });
          await tx.conversationEvent.create({
            data: {
              conversationId: conversation.id,
              websiteId: conversation.websiteId,
              type: 'MESSAGE_SENT',
              actorVisitorId: null,
              actorUserId: null,
              metadata: { messageId: message.id, aiFallback: true, reason: options.reason },
            },
          });
        }

        await tx.aiJob.update({
          where: { id: job.id },
          data: { status: 'DONE', replyMessageId: message?.id ?? null },
        });

        return { message, handlingChanged };
      });

      if (result.message) {
        this.realtime.publishMessageNew(
          { conversationId: job.conversationId, message: toChatMessage(result.message) },
          job.websiteId,
        );
      }
      if (result.handlingChanged) {
        await this.publishCurrentConversation(job.conversationId, job.websiteId);
      }
      return result.message ? toChatMessage(result.message) : null;
    } catch (error) {
      if (error instanceof AiJobAlreadyFinalizedError) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Acknowledges a visitor message on a conversation that is already queued for
   * a human (`HANDOFF_PENDING`), and marks the job DONE — atomically.
   *
   * This is what stops a visitor going silent after an escalation: the thread
   * stays in the human queue (handling is deliberately NOT changed back to AI,
   * so the agent never steals a thread a human is about to pick up), but every
   * new visitor message still gets the website's acknowledgement reply.
   *
   * A conversation taken over by staff (`HUMAN`) is never written to, and a
   * closed thread simply consumes the lease.
   */
  async acknowledgeAiJob(job: AiJob, content: string): Promise<ChatMessage | null> {
    const trimmed = content?.trim() ?? '';
    if (!trimmed) {
      await this.consumeAiJob(job.id);
      return null;
    }

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        this.throwIfJobFinalized(job, 'RUNNING');
        const conversation = await tx.conversation.findUnique({
          where: { id: job.conversationId },
        });
        const website = await tx.website.findUnique({
          where: { id: job.websiteId },
          select: { isActive: true },
        });

        if (
          !conversation ||
          !website?.isActive ||
          conversation.status === ConversationStatus.CLOSED ||
          conversation.handling === 'HUMAN'
        ) {
          await tx.aiJob.update({ where: { id: job.id }, data: { status: 'DONE' } });
          return null;
        }

        const message = await tx.message.create({
          data: {
            conversationId: conversation.id,
            senderType: MessageSender.AI,
            visitorId: null,
            userId: null,
            content: trimmed,
            clientMessageId: null,
          },
          include: messageInclude,
        });
        await tx.conversation.update({
          where: { id: conversation.id },
          data: { lastMessageAt: message.createdAt },
        });
        await tx.conversationEvent.create({
          data: {
            conversationId: conversation.id,
            websiteId: conversation.websiteId,
            type: 'MESSAGE_SENT',
            actorVisitorId: null,
            actorUserId: null,
            metadata: { messageId: message.id, aiAcknowledgement: true },
          },
        });
        await tx.aiJob.update({
          where: { id: job.id },
          data: { status: 'DONE', replyMessageId: message.id },
        });
        return message;
      });

      if (result) {
        this.realtime.publishMessageNew(
          { conversationId: job.conversationId, message: toChatMessage(result) },
          job.websiteId,
        );
      }
      return result ? toChatMessage(result) : null;
    } catch (error) {
      if (error instanceof AiJobAlreadyFinalizedError) {
        return null;
      }
      throw error;
    }
  }

  private async consumeAiJob(jobId: string): Promise<void> {
    await this.prisma.aiJob.update({ where: { id: jobId }, data: { status: 'DONE' } });
  }

  private async publishCurrentConversation(
    conversationId: string,
    websiteId: string,
  ): Promise<void> {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
    });
    if (conversation) {
      this.realtime.publishConversationUpdated(toPublicConversation(conversation), websiteId);
    }
  }

  /**
   * History page: newest `limit` messages first, returned in chronological
   * ascending order, with a `before` cursor into older history. Ordering is
   * `(createdAt, id)` — explicitly ordered in SQL, never by array order.
   */
  private async loadPage(
    conversationId: string,
    query: ListMessagesQueryDto,
  ): Promise<CursorPage<ChatMessage>> {
    const limit = query.limit ?? 50;
    const cursor = query.before ? decodeMessageCursor(query.before) : null;

    const rows = await this.prisma.message.findMany({
      where: {
        conversationId,
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: messageInclude,
    });

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).reverse();
    const oldest = page[0];

    return {
      data: page.map(toChatMessage),
      nextCursor: hasMore && oldest ? encodeMessageCursor(oldest.createdAt, oldest.id) : null,
      limit,
    };
  }
}

function isClientMessageIdConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }
  const target = error.meta?.target;
  if (Array.isArray(target)) {
    return target.includes('client_message_id');
  }
  return typeof target === 'string' && target.includes('client_message_id');
}
