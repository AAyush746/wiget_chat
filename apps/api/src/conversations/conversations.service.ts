import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConversationStatus, type Conversation, type Website } from '@prisma/client';
import type { AuthUser, Paginated, PublicConversation, StaffConversation } from '@chatflow/types';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { VisitorsService } from '../visitors/visitors.service';
import { WebsiteAccessService } from '../websites/website-access.service';
import {
  staffConversationInclude,
  toPublicConversation,
  toStaffConversation,
} from './conversation.mapper';
import type { CreateConversationDto } from './dto/create-conversation.dto';
import type { ListConversationsQueryDto } from './dto/list-conversations-query.dto';

/**
 * Conversation foundation.
 *
 * Public methods authenticate the caller purely by (publicKey, visitorKey)
 * and derive `websiteId` / `visitorId` server-side — client-supplied tenant or
 * owner ids are never accepted. Staff methods receive the website already
 * authorized by WebsiteAccessGuard and additionally verify that the requested
 * conversation row belongs to it (website -> conversation -> visitor chain).
 */
@Injectable()
export class ConversationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly visitors: VisitorsService,
    private readonly access: WebsiteAccessService,
    private readonly realtime: RealtimeService,
  ) {}

  // ---------------------------------------------------------------- public

  async createFromVisitor(
    publicKey: string,
    dto: CreateConversationDto,
  ): Promise<PublicConversation> {
    const visitor = await this.visitors.resolveVisitor(publicKey, dto.visitorKey);

    const conversation = await this.prisma.$transaction(async (tx) => {
      const created = await tx.conversation.create({
        data: {
          websiteId: visitor.websiteId,
          visitorId: visitor.id,
          status: ConversationStatus.OPEN,
          subject: normalizeSubject(dto.subject),
        },
      });

      await tx.conversationEvent.create({
        data: {
          conversationId: created.id,
          websiteId: created.websiteId,
          type: 'CONVERSATION_CREATED',
          actorVisitorId: visitor.id,
        },
      });

      return created;
    });

    return toPublicConversation(conversation);
  }

  async listFromVisitor(
    publicKey: string,
    visitorKey: string,
    query: ListConversationsQueryDto,
  ): Promise<Paginated<PublicConversation>> {
    const visitor = await this.visitors.resolveVisitor(publicKey, visitorKey);

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where = {
      websiteId: visitor.websiteId,
      visitorId: visitor.id,
      ...(query.status !== undefined ? { status: query.status } : {}),
    };

    const [total, conversations] = await this.prisma.$transaction([
      this.prisma.conversation.count({ where }),
      this.prisma.conversation.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return { data: conversations.map(toPublicConversation), total, page, limit };
  }

  async getFromVisitor(
    publicKey: string,
    visitorKey: string,
    conversationId: string,
  ): Promise<PublicConversation> {
    const visitor = await this.visitors.resolveVisitor(publicKey, visitorKey);
    const conversation = await this.resolveVisitorConversation(visitor, conversationId);
    return toPublicConversation(conversation);
  }

  async closeFromVisitor(
    publicKey: string,
    visitorKey: string,
    conversationId: string,
  ): Promise<PublicConversation> {
    const visitor = await this.visitors.resolveVisitor(publicKey, visitorKey);
    const conversation = await this.resolveVisitorConversation(visitor, conversationId);

    if (conversation.status === ConversationStatus.CLOSED) {
      throw new ConflictException('Conversation is already closed');
    }

    const updated = await this.persistClose(conversation, { actorVisitorId: visitor.id });
    this.notifyClosed(updated);

    return toPublicConversation(updated);
  }

  // ----------------------------------------------------------------- staff

  async listForStaff(
    website: Website,
    query: ListConversationsQueryDto,
  ): Promise<Paginated<StaffConversation>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where = {
      websiteId: website.id,
      ...(query.status !== undefined ? { status: query.status } : {}),
    };

    const [total, conversations] = await this.prisma.$transaction([
      this.prisma.conversation.count({ where }),
      this.prisma.conversation.findMany({
        where,
        include: staffConversationInclude,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return { data: conversations.map(toStaffConversation), total, page, limit };
  }

  async getForStaff(website: Website, conversationId: string): Promise<StaffConversation> {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: staffConversationInclude,
    });

    if (!conversation || conversation.websiteId !== website.id) {
      throw new NotFoundException('Conversation not found');
    }

    return toStaffConversation(conversation);
  }

  /**
   * Closes a conversation as a staff member. Shares the exact same
   * optimistic-concurrency transaction, audit trail and realtime fan-out as
   * the visitor close; the only differences are who may call it (website
   * guard + the staff authorization chain) and the stricter write policy for
   * deactivated websites (matches MessagesService: read-only, no writes).
   */
  async closeForStaff(
    user: AuthUser,
    conversationId: string,
    authorizedWebsiteId?: string,
  ): Promise<StaffConversation> {
    const { conversation, website } = await this.resolveStaffConversation(
      user,
      conversationId,
      authorizedWebsiteId,
    );

    if (!website.isActive) {
      throw new ForbiddenException('Website is deactivated');
    }

    if (conversation.status === ConversationStatus.CLOSED) {
      throw new ConflictException('Conversation is already closed');
    }

    const updated = await this.persistClose(conversation, { actorUserId: user.id });
    this.notifyClosed(updated);

    return this.getForStaff(website, updated.id);
  }

  // -------------------------------------------------------------- internal

  /**
   * Loads a conversation only if it belongs to the given visitor *and* that
   * visitor's website. Any other tenant's id, or another visitor's id, is an
   * indistinguishable 404 (IDOR). Both checks are made even though the
   * composite FK already ties conversation.websiteId to visitor.websiteId.
   *
   * Shared by the REST controllers and the WebSocket join handler so the
   * ownership rule exists exactly once.
   */
  async resolveVisitorConversation(
    visitor: { id: string; websiteId: string },
    conversationId: string,
  ): Promise<Conversation> {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
    });

    if (
      !conversation ||
      conversation.visitorId !== visitor.id ||
      conversation.websiteId !== visitor.websiteId
    ) {
      throw new NotFoundException('Conversation not found');
    }

    return conversation;
  }

  /**
   * Staff-side thread resolution for paths that are not website-scoped in the
   * route (the WebSocket join/send events carry only a conversation id): the
   * conversation is loaded first, then the caller is authorized against its
   * website (ADMIN implicit, AGENT via active membership). When
   * `expectedWebsiteId` is supplied (REST), a conversation outside that
   * website is an indistinguishable 404 instead.
   */
  async resolveStaffConversation(
    user: AuthUser,
    conversationId: string,
    expectedWebsiteId?: string,
  ): Promise<{ conversation: Conversation; website: Website }> {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
    });

    if (
      !conversation ||
      (expectedWebsiteId !== undefined && conversation.websiteId !== expectedWebsiteId)
    ) {
      throw new NotFoundException('Conversation not found');
    }

    const website = await this.access.getAccessibleWebsite(user, conversation.websiteId);
    return { conversation, website };
  }

  /**
   * The atomic close: status + `closedAt` land together with the audit event
   * or not at all. The `updateMany` guards on status so two concurrent closes
   * cannot both report success or overwrite `closedAt`.
   */
  private async persistClose(
    conversation: Conversation,
    actor: { actorVisitorId?: string; actorUserId?: string },
  ): Promise<Conversation> {
    const now = new Date();

    return this.prisma.$transaction(async (tx) => {
      const result = await tx.conversation.updateMany({
        where: { id: conversation.id, status: { not: ConversationStatus.CLOSED } },
        data: { status: ConversationStatus.CLOSED, closedAt: now },
      });

      if (result.count === 0) {
        throw new ConflictException('Conversation is already closed');
      }

      await tx.conversationEvent.create({
        data: {
          conversationId: conversation.id,
          websiteId: conversation.websiteId,
          type: 'CONVERSATION_CLOSED',
          actorVisitorId: actor.actorVisitorId ?? null,
          actorUserId: actor.actorUserId ?? null,
        },
      });

      return tx.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
    });
  }

  // Published strictly after the close commits so sockets hear about a REST-
  // or WebSocket-initiated close through the same bus as message traffic.
  private notifyClosed(conversation: Conversation): void {
    this.realtime.publishConversationClosed({
      conversationId: conversation.id,
      status: conversation.status,
      closedAt: (conversation.closedAt ?? new Date()).toISOString(),
    });
  }
}

function normalizeSubject(subject: string | undefined): string | null {
  const trimmed = subject?.trim();
  return trimmed ? trimmed : null;
}
