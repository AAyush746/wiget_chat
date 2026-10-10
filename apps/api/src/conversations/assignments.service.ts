import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConversationStatus, Prisma, Role, type Website } from '@prisma/client';
import type {
  AuthUser,
  ConversationAssignmentEntry,
  PublicUser,
  StaffConversation,
} from '@chatflow/types';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { toPublicUser } from '../users/user.mapper';
import { ConversationsService } from './conversations.service';

/**
 * Conversation assignment workflow — claim, assign/reassign, history.
 *
 * Every operation is website-scoped: the `WebsiteAccessGuard` authorizes the
 * actor against the website before this service runs, and this service always
 * verifies the conversation row belongs to that website (an indistinguishable
 * 404 otherwise). Assignments are persisted in a transaction that also writes
 * the `ConversationAssignment` history row and the matching
 * `CONVERSATION_ASSIGNED` / `CONVERSATION_REASSIGNED` audit event, then a
 * realtime notification is published strictly *after* commit to the staff
 * room only (visitor sockets never learn who the agent is).
 *
 * Concurrency: a `SELECT … FOR UPDATE` on the conversation row serializes all
 * concurrent claims/assigns for the same conversation, so two simultaneous
 * claims cannot both open assignments. The schema's partial unique index on
 * open assignments is the second, database-level guarantee that at most one
 * open `ConversationAssignment` exists per conversation.
 */
@Injectable()
export class AssignmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly conversations: ConversationsService,
    private readonly realtime: RealtimeService,
  ) {}

  /** Assign the conversation to the actor (staff must already be authorized). */
  async claim(
    website: Website,
    conversationId: string,
    actor: AuthUser,
  ): Promise<StaffConversation> {
    this.assertWritableWebsite(website);
    const outcome = await this.assignInTransaction(
      website,
      conversationId,
      actor,
      actor.id,
      'claim',
    );
    return this.publishAndReturn(website, conversationId, outcome.assignedAt);
  }

  /** Assign (or, when already assigned to someone else, reassign) to a staff member. */
  async assign(
    website: Website,
    conversationId: string,
    actor: AuthUser,
    assigneeUserId: string,
  ): Promise<StaffConversation> {
    this.assertWritableWebsite(website);
    const outcome = await this.assignInTransaction(
      website,
      conversationId,
      actor,
      assigneeUserId,
      'assign',
    );
    return this.publishAndReturn(website, conversationId, outcome.assignedAt);
  }

  /** Full append-only assignment history, newest first. */
  async history(website: Website, conversationId: string): Promise<ConversationAssignmentEntry[]> {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
    });

    if (!conversation || conversation.websiteId !== website.id) {
      throw new NotFoundException('Conversation not found');
    }

    const rows = await this.prisma.conversationAssignment.findMany({
      where: { conversationId },
      include: {
        user: { select: { id: true, name: true, email: true } },
        assignedBy: { select: { id: true, name: true, email: true } },
      },
      orderBy: [{ assignedAt: 'desc' }, { id: 'desc' }],
    });

    return rows.map((row) => ({
      id: row.id,
      userId: row.userId,
      user: row.user,
      assignedById: row.assignedById,
      assignedBy: row.assignedBy,
      assignedAt: row.assignedAt.toISOString(),
      unassignedAt: row.unassignedAt?.toISOString() ?? null,
      active: row.unassignedAt === null,
    }));
  }

  /**
   * Staff who may be assigned work on this website: active ADMIN accounts
   * (implicit access) plus AGENT accounts holding an active membership.
   */
  async listAssignable(website: Website): Promise<PublicUser[]> {
    const users = await this.prisma.user.findMany({
      where: {
        isActive: true,
        OR: [
          { role: Role.ADMIN },
          { role: Role.AGENT, memberships: { some: { websiteId: website.id, isActive: true } } },
        ],
      },
      orderBy: [{ name: 'asc' }, { email: 'asc' }],
    });
    return users.map(toPublicUser);
  }

  // -------------------------------------------------------------- internals

  private assertWritableWebsite(website: Website): void {
    if (!website.isActive) {
      throw new ForbiddenException('Website is deactivated');
    }
  }

  private async publishAndReturn(
    website: Website,
    conversationId: string,
    assignedAt: Date,
  ): Promise<StaffConversation> {
    const staff = await this.conversations.getForStaff(website, conversationId);

    this.realtime.publishConversationAssigned(
      {
        conversationId,
        assignedAgent: staff.assignedAgent,
        assignedAt: assignedAt.toISOString(),
        handling: staff.handling,
      },
      website.id,
    );

    return staff;
  }

  /**
   * The atomic unit: conversation state + assignment history + audit event
   * together or not at all. Throwing (already assigned, closed, ineligible
   * assignee, …) rolls the whole unit back — no partial rows survive.
   */
  private async assignInTransaction(
    website: Website,
    conversationId: string,
    actor: AuthUser,
    assigneeUserId: string,
    mode: 'claim' | 'assign',
  ): Promise<{ assignedAt: Date }> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "conversations" WHERE "id" = ${conversationId}::uuid FOR UPDATE`;

      const conversation = await tx.conversation.findUnique({
        where: { id: conversationId },
      });
      if (!conversation || conversation.websiteId !== website.id) {
        throw new NotFoundException('Conversation not found');
      }
      if (conversation.status === ConversationStatus.CLOSED) {
        throw new ConflictException('Conversation is closed');
      }

      if (mode === 'assign') {
        await this.assertEligibleAssignee(tx, website.id, assigneeUserId);
      }

      const current = await tx.conversationAssignment.findFirst({
        where: { conversationId, unassignedAt: null },
        orderBy: { assignedAt: 'desc' },
        select: { id: true, userId: true },
      });

      if (mode === 'claim' && current) {
        throw new ConflictException('Conversation is already assigned');
      }
      if (mode === 'assign' && current && current.userId === assigneeUserId) {
        throw new ConflictException('Conversation is already assigned to this agent');
      }

      const now = new Date();

      if (current && current.userId !== assigneeUserId) {
        await tx.conversationAssignment.update({
          where: { id: current.id },
          data: { unassignedAt: now },
        });
      }

      const assignment = await tx.conversationAssignment.create({
        data: {
          conversationId,
          userId: assigneeUserId,
          assignedById: actor.id,
          assignedAt: now,
        },
        select: { id: true },
      });

      await tx.conversation.update({
        where: { id: conversationId },
        data: { assignedAgentId: assigneeUserId },
      });

      await tx.conversationEvent.create({
        data: {
          conversationId,
          websiteId: website.id,
          type: current ? 'CONVERSATION_REASSIGNED' : 'CONVERSATION_ASSIGNED',
          actorUserId: actor.id,
          actorVisitorId: null,
          metadata: {
            assignmentId: assignment.id,
            userId: assigneeUserId,
            previousUserId: current ? current.userId : null,
          },
        },
      });

      return { assignedAt: now };
    });
  }

  /**
   * An assignee must exist, be active, and be able to reach the website:
   * either an ADMIN (implicit access) or an AGENT with an *active* membership.
   * Agent without membership and inactive accounts are rejected as invalid.
   */
  private async assertEligibleAssignee(
    tx: Prisma.TransactionClient,
    websiteId: string,
    userId: string,
  ): Promise<void> {
    const user = await tx.user.findUnique({
      where: { id: userId },
      include: {
        memberships: { where: { websiteId, isActive: true }, select: { id: true } },
      },
    });

    if (!user) {
      throw new NotFoundException('Assignee not found');
    }
    if (!user.isActive) {
      throw new BadRequestException('Assignee is deactivated');
    }
    if (user.role !== Role.ADMIN && user.memberships.length === 0) {
      throw new BadRequestException('Assignee is not a member of this website');
    }
  }
}
