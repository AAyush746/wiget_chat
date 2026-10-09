import type { QueryClient } from '@tanstack/react-query';
import type {
  ConversationClosedEvent,
  ConversationUpdatedEvent,
  MessageNewEvent,
  StaffConversation,
} from '@chatflow/types';
import { applyInboxClose, applyInboxMessage, upsertMessage, type MessagesState } from './messages';

/**
 * Realtime event → React Query cache reconciliation.
 *
 * The server is authoritative: a pushed event only *updates* an existing
 * cache entry (matching the REST-loaded shape). Queries that have never
 * loaded stay undefined and are fetched on demand — pushed events never
 * fabricate state that REST would not have returned.
 */

/** Insert a committed message into the open conversation + its inbox row. */
export function handleMessageNew(
  queryClient: QueryClient,
  websiteId: string | null,
  payload: MessageNewEvent,
): void {
  if (websiteId === null) {
    return;
  }
  const { conversationId, message } = payload;

  queryClient.setQueryData<MessagesState>(['messages', websiteId, conversationId], (state) =>
    state ? upsertMessage(state, message) : state,
  );

  queryClient.setQueryData<StaffConversation>(
    ['conversation', websiteId, conversationId],
    (conversation) =>
      conversation
        ? { ...conversation, lastMessage: message, lastMessageAt: message.createdAt }
        : conversation,
  );

  queryClient.setQueriesData<StaffConversation[]>(
    { queryKey: ['conversations', websiteId] },
    (rows) => (rows ? applyInboxMessage(rows, message) : rows),
  );
}

/** Reflect status transitions (e.g. PENDING → OPEN) in open views. */
export function handleConversationUpdated(
  queryClient: QueryClient,
  websiteId: string | null,
  payload: ConversationUpdatedEvent,
): void {
  if (websiteId === null) {
    return;
  }
  const conversation = payload.conversation;

  queryClient.setQueryData<StaffConversation>(
    ['conversation', websiteId, conversation.id],
    (current) => (current ? { ...current, ...conversation, closedAt: null } : current),
  );

  queryClient.setQueriesData<StaffConversation[]>(
    { queryKey: ['conversations', websiteId] },
    (rows) =>
      rows
        ? rows.map((row) =>
            row.id === conversation.id
              ? { ...row, status: conversation.status, closedAt: null }
              : row,
          )
        : rows,
  );
}

/** Close the conversation everywhere it is displayed. */
export function handleConversationClosed(
  queryClient: QueryClient,
  websiteId: string | null,
  payload: ConversationClosedEvent,
): void {
  if (websiteId === null) {
    return;
  }
  const { conversationId, closedAt } = payload;

  queryClient.setQueryData<StaffConversation>(
    ['conversation', websiteId, conversationId],
    (conversation) =>
      conversation ? { ...conversation, status: 'CLOSED', closedAt } : conversation,
  );

  queryClient.setQueriesData<StaffConversation[]>(
    { queryKey: ['conversations', websiteId] },
    (rows) => (rows ? applyInboxClose(rows, conversationId, closedAt) : rows),
  );
}
