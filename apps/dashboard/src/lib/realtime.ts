import type { QueryClient } from '@tanstack/react-query';
import type {
  ConversationAssignedEvent,
  ConversationClosedEvent,
  ConversationNewEvent,
  ConversationUpdatedEvent,
  MessageNewEvent,
  Paginated,
  StaffConversation,
} from '@chatflow/types';
import {
  applyInboxClose,
  applyInboxMessage,
  insertInboxConversation,
  upsertMessage,
  type MessagesState,
} from './messages';

/**
 * Realtime event → React Query cache reconciliation.
 *
 * The server is authoritative: a pushed event only *updates* an existing
 * cache entry (matching the REST-loaded shape). Queries that have never
 * loaded stay undefined and are fetched on demand — pushed events never
 * fabricate state that REST would not have returned. When an event cannot be
 * applied to the cached rows (a message for a thread the inbox has never
 * loaded), the authoritative queries are invalidated so a background refetch
 * reconciles instead of trusting a stale list.
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

  // The inbox cache holds `Paginated<StaffConversation>`; update the preview on
  // every loaded page that contains the row without disturbing pagination.
  queryClient.setQueriesData<Paginated<StaffConversation>>(
    { queryKey: ['conversations', websiteId] },
    (page) => (page ? { ...page, data: applyInboxMessage(page.data, message) } : page),
  );

  // A message for a thread the inbox caches do not know about (unopened
  // conversation, or one created before this session) must surface in the
  // list: refetch the authoritative pages instead of guessing where the row
  // belongs.
  if (!inboxKnows(queryClient, websiteId, conversationId)) {
    queryClient.invalidateQueries({ queryKey: ['conversations', websiteId] });
  }
}

/**
 * A freshly-created conversation lands in the inbox the moment it commits.
 * Only page-1 ALL/OPEN lists can hold it (it is the newest row and OPEN by
 * definition); anything else gets a background refetch so the authoritative
 * list picks it up — including PENDING/CLOSED filters it does not belong in.
 */
export function handleConversationNew(
  queryClient: QueryClient,
  payload: ConversationNewEvent,
): void {
  const { websiteId, conversation } = payload;
  let applied = false;

  const matches = queryClient.getQueriesData<Paginated<StaffConversation>>({
    queryKey: ['conversations', websiteId],
  });

  for (const [queryKey, data] of matches) {
    const [, , filter, page] = queryKey as [string, string, string, number];
    if (page !== 1 || (filter !== 'ALL' && filter !== 'OPEN')) {
      continue;
    }
    if (!data) {
      continue;
    }
    // Already visible (duplicate/race): nothing to do, but the website is
    // "handled" — no refetch needed.
    if (data.data.some((row) => row.id === conversation.id)) {
      applied = true;
      continue;
    }
    applied = true;
    queryClient.setQueryData<Paginated<StaffConversation>>(queryKey, {
      ...data,
      data: insertInboxConversation(data.data, conversation),
      total: data.total + 1,
    });
  }

  if (!applied) {
    queryClient.invalidateQueries({ queryKey: ['conversations', websiteId] });
  }
}

function inboxKnows(queryClient: QueryClient, websiteId: string, conversationId: string): boolean {
  return queryClient
    .getQueriesData<Paginated<StaffConversation>>({ queryKey: ['conversations', websiteId] })
    .some(([, data]) => data?.data.some((row) => row.id === conversationId));
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

  queryClient.setQueriesData<Paginated<StaffConversation>>(
    { queryKey: ['conversations', websiteId] },
    (page) =>
      page
        ? {
            ...page,
            data: page.data.map((row) =>
              row.id === conversation.id
                ? { ...row, status: conversation.status, closedAt: null }
                : row,
            ),
          }
        : page,
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

  queryClient.setQueriesData<Paginated<StaffConversation>>(
    { queryKey: ['conversations', websiteId] },
    (page) =>
      page ? { ...page, data: applyInboxClose(page.data, conversationId, closedAt) } : page,
  );
}

/** Reflect a claim/assign/reassign in staff caches (assignee is never pushed to visitors). */
export function handleConversationAssigned(
  queryClient: QueryClient,
  websiteId: string | null,
  payload: ConversationAssignedEvent,
): void {
  if (websiteId === null) {
    return;
  }
  const { conversationId, assignedAgent } = payload;

  queryClient.setQueryData<StaffConversation>(
    ['conversation', websiteId, conversationId],
    (conversation) => (conversation ? { ...conversation, assignedAgent } : conversation),
  );

  queryClient.setQueriesData<Paginated<StaffConversation>>(
    { queryKey: ['conversations', websiteId] },
    (page) =>
      page
        ? {
            ...page,
            data: page.data.map((row) =>
              row.id === conversationId ? { ...row, assignedAgent } : row,
            ),
          }
        : page,
  );
}
