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
  type Conversation,
  type Visitor,
  type Website,
} from '@prisma/client';
import type { AuthUser, ChatMessage, CursorPage, MessageSendResult } from '@chatflow/types';
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
}

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
      this.realtime.publishMessageNew({
        conversationId: conversation.id,
        message: toChatMessage(outcome.message),
      });
      if (outcome.conversation && reopen) {
        this.realtime.publishConversationUpdated(toPublicConversation(outcome.conversation));
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

        return { message, conversation: updated, replay: false };
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
      return { message: existing, conversation: null, replay: true };
    }
    throw new ClientMessageIdConflictException();
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
