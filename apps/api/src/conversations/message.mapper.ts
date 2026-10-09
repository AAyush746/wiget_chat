import type { Message, User, Visitor } from '@prisma/client';
import type { ChatMessage } from '@chatflow/types';

/** Message row plus the sender display names (never e-mails). */
export type MessageWithSenders = Message & {
  visitor: Pick<Visitor, 'name'> | null;
  user: Pick<User, 'name'> | null;
};

/** Fields loaded for every message read/create so the wire shape can resolve. */
export const messageInclude = {
  visitor: { select: { name: true } },
  user: { select: { name: true } },
} as const;

/**
 * Wire representation shared by REST responses and `message:new` events.
 * Sender database ids are deliberately not exposed: clients scope by
 * conversation, and leaking internal ids would widen every IDOR surface.
 */
export function toChatMessage(message: MessageWithSenders): ChatMessage {
  return {
    id: message.id,
    conversationId: message.conversationId,
    senderType: message.senderType,
    senderName: message.visitor?.name ?? message.user?.name ?? null,
    content: message.content,
    clientMessageId: message.clientMessageId,
    createdAt: message.createdAt.toISOString(),
  };
}
