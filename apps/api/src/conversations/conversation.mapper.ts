import type { Conversation, Prisma, Visitor } from '@prisma/client';
import type { HandoffReason, PublicConversation, StaffConversation } from '@chatflow/types';
import { messageInclude, toChatMessage, type MessageWithSenders } from './message.mapper';

/** Conversation fields visible to the visitor who owns the thread. */
export function toPublicConversation(conversation: Conversation): PublicConversation {
  return {
    id: conversation.id,
    status: conversation.status,
    handling: conversation.handling,
    subject: conversation.subject,
    createdAt: conversation.createdAt.toISOString(),
    updatedAt: conversation.updatedAt.toISOString(),
    lastMessageAt: conversation.lastMessageAt?.toISOString() ?? null,
    closedAt: conversation.closedAt?.toISOString() ?? null,
  };
}

/** A staff conversation row with the owner, current assignee and newest message preloaded. */
export type StaffConversationRow = Conversation & {
  visitor: Visitor;
  assignedAgent: { id: string; name: string | null } | null;
  messages: MessageWithSenders[];
};

/** Include clause that fetches exactly the newest message per conversation. */
export const staffConversationInclude = {
  visitor: true,
  assignedAgent: { select: { id: true, name: true } },
  messages: {
    take: 1,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    include: messageInclude,
  },
} satisfies Prisma.ConversationInclude;

/** Conversation fields visible to authorized staff of the owning website. */
export function toStaffConversation(conversation: StaffConversationRow): StaffConversation {
  return {
    ...toPublicConversation(conversation),
    visitor: {
      id: conversation.visitor.id,
      name: conversation.visitor.name,
      email: conversation.visitor.email,
      lastSeenAt: conversation.visitor.lastSeenAt.toISOString(),
    },
    assignedAgent: conversation.assignedAgent,
    handoffReason: conversation.handoffReason as HandoffReason | null,
    handoffRequestedAt: conversation.handoffRequestedAt?.toISOString() ?? null,
    lastMessage: conversation.messages[0] ? toChatMessage(conversation.messages[0]) : null,
  };
}
