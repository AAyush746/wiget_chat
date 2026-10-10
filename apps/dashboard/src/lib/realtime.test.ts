import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { ChatMessage, Paginated, StaffConversation } from '@chatflow/types';
import {
  handleConversationAssigned,
  handleConversationClosed,
  handleConversationNew,
  handleConversationUpdated,
  handleMessageNew,
} from './realtime';
import type { MessagesState } from './messages';

const message = (id: string, content: string): ChatMessage => ({
  id,
  conversationId: 'c1',
  senderType: 'VISITOR',
  senderName: 'Aria',
  content,
  clientMessageId: null,
  createdAt: '2026-10-09T10:00:00.000Z',
});

function freshClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

const inboxRow: StaffConversation = {
  id: 'c1',
  status: 'OPEN',
  handling: 'HUMAN',
  subject: null,
  createdAt: '2026-10-09T09:00:00.000Z',
  updatedAt: '2026-10-09T09:00:00.000Z',
  lastMessageAt: null,
  closedAt: null,
  visitor: { id: 'v1', name: 'Aria', email: null, lastSeenAt: '2026-10-09T10:00:00.000Z' },
  assignedAgent: null,
  handoffReason: null,
  handoffRequestedAt: null,
  lastMessage: null,
};

const page = (rows: StaffConversation[], total = rows.length): Paginated<StaffConversation> => ({
  data: rows,
  total,
  page: 1,
  limit: 20,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('realtime → cache reconciliation', () => {
  it('upserts a pushed message into the loaded messages cache', () => {
    const client = freshClient();
    client.setQueryData<MessagesState>(['messages', 'w1', 'c1'], {
      messages: [],
      nextCursor: null,
    });

    handleMessageNew(client, 'w1', { conversationId: 'c1', message: message('m1', 'hello') });

    const state = client.getQueryData<MessagesState>(['messages', 'w1', 'c1']);
    expect(state?.messages.map((m) => m.id)).toEqual(['m1']);
  });

  it('never fabricates a messages cache that REST never produced', () => {
    const client = freshClient();
    handleMessageNew(client, 'w1', { conversationId: 'c1', message: message('m1', 'hello') });
    expect(client.getQueryData(['messages', 'w1', 'c1'])).toBeUndefined();
  });

  it('bumps the inbox row preview and detail lastMessage', () => {
    const client = freshClient();
    client.setQueryData(['conversations', 'w1', 'ALL', 1], page([inboxRow]));
    client.setQueryData(['conversation', 'w1', 'c1'], inboxRow);

    handleMessageNew(client, 'w1', { conversationId: 'c1', message: message('m2', 'updated') });

    const rows = cachedRows(client, 'w1');
    expect(rows[0]?.lastMessage?.content).toBe('updated');

    const detail = client.getQueryData(['conversation', 'w1', 'c1']) as typeof inboxRow;
    expect(detail.lastMessageAt).toBe('2026-10-09T10:00:00.000Z');
  });

  it('refetches the inbox when a message arrives for a thread the cache has never loaded', () => {
    const client = freshClient();
    client.setQueryData(['conversations', 'w1', 'ALL', 1], page([inboxRow]));
    const spy = vi.spyOn(client, 'invalidateQueries');

    handleMessageNew(client, 'w1', { conversationId: 'unknown', message: message('m9', 'hi') });

    expect(spy).toHaveBeenCalledWith({ queryKey: ['conversations', 'w1'] });
  });

  it('does not refetch when the conversation row already exists in the inbox', () => {
    const client = freshClient();
    client.setQueryData(['conversations', 'w1', 'ALL', 1], page([inboxRow]));
    const spy = vi.spyOn(client, 'invalidateQueries');

    handleMessageNew(client, 'w1', { conversationId: 'c1', message: message('m2', 'updated') });

    expect(spy).not.toHaveBeenCalled();
  });

  it('applies a status transition to detail and inbox', () => {
    const client = freshClient();
    client.setQueryData(['conversation', 'w1', 'c1'], inboxRow);
    client.setQueryData(['conversations', 'w1', 'ALL', 1], page([inboxRow]));

    handleConversationUpdated(client, 'w1', {
      conversation: {
        id: 'c1',
        status: 'OPEN',
        handling: 'HUMAN',
        subject: null,
        createdAt: '2026-10-09T09:00:00.000Z',
        updatedAt: '2026-10-09T10:00:00.000Z',
        lastMessageAt: '2026-10-09T10:00:00.000Z',
        closedAt: null,
      },
    });

    const detail = client.getQueryData(['conversation', 'w1', 'c1']) as typeof inboxRow;
    expect(detail.status).toBe('OPEN');
    const rows = cachedRows(client, 'w1');
    expect(rows[0]?.status).toBe('OPEN');
  });

  it('closes the conversation in every cache it appears in', () => {
    const client = freshClient();
    client.setQueryData(['conversation', 'w1', 'c1'], inboxRow);
    client.setQueryData(['conversations', 'w1', 'ALL', 1], page([inboxRow]));

    handleConversationClosed(client, 'w1', {
      conversationId: 'c1',
      status: 'CLOSED',
      closedAt: '2026-10-09T11:00:00.000Z',
    });

    const detail = client.getQueryData(['conversation', 'w1', 'c1']) as typeof inboxRow;
    expect(detail.status).toBe('CLOSED');
    const rows = cachedRows(client, 'w1');
    expect(rows[0]?.status).toBe('CLOSED');
  });

  it('updates caches for the selected website only', () => {
    const client = freshClient();
    client.setQueryData(['conversations', 'w1', 'ALL', 1], page([inboxRow]));
    client.setQueryData(['conversations', 'w2', 'ALL', 1], page([{ ...inboxRow, id: 'other' }]));

    handleMessageNew(client, 'w1', { conversationId: 'c1', message: message('m3', 'hi') });

    const w1Rows = cachedRows(client, 'w1');
    const w2Rows = cachedRows(client, 'w2');
    expect(w1Rows[0]?.lastMessage?.content).toBe('hi');
    expect(w2Rows[0]?.lastMessage).toBeNull();
  });

  it('reflects a claim on the detail and inbox caches', () => {
    const client = freshClient();
    client.setQueryData(['conversation', 'w1', 'c1'], inboxRow);
    client.setQueryData(['conversations', 'w1', 'ALL', 1], page([inboxRow]));

    handleConversationAssigned(client, 'w1', {
      conversationId: 'c1',
      assignedAgent: { id: 'u9', name: 'Bryn' },
      assignedAt: '2026-10-09T11:00:00.000Z',
      handling: 'HUMAN',
    });

    const detail = client.getQueryData(['conversation', 'w1', 'c1']) as typeof inboxRow;
    expect(detail.assignedAgent).toEqual({ id: 'u9', name: 'Bryn' });
    const rows = cachedRows(client, 'w1');
    expect(rows[0]?.assignedAgent).toEqual({ id: 'u9', name: 'Bryn' });
  });

  it('leaves the cache untouched when the rest key was never populated', () => {
    const client = freshClient();
    handleConversationAssigned(client, 'w1', {
      conversationId: 'c2',
      assignedAgent: { id: 'u9', name: 'Bryn' },
      assignedAt: '2026-10-09T11:00:00.000Z',
      handling: 'HUMAN',
    });
    expect(client.getQueryData(['conversation', 'w1', 'c2'])).toBeUndefined();
    expect(client.getQueryData(['conversations', 'w1', 'ALL', 1])).toBeUndefined();
  });
});

describe('conversation:new → inbox fan-out', () => {
  const brandNew: StaffConversation = {
    ...inboxRow,
    id: 'c-new',
    createdAt: '2026-10-09T11:30:00.000Z',
    updatedAt: '2026-10-09T11:30:00.000Z',
  };

  it('inserts a new conversation at the head of a loaded page-1 ALL list', () => {
    const client = freshClient();
    client.setQueryData(['conversations', 'w1', 'ALL', 2], page([inboxRow], 21));
    client.setQueryData(['conversations', 'w1', 'ALL', 1], page([inboxRow]));

    handleConversationNew(client, { websiteId: 'w1', conversation: brandNew });

    const paginated = client.getQueryData<Paginated<StaffConversation>>([
      'conversations',
      'w1',
      'ALL',
      1,
    ]);
    expect(paginated?.data.map((r) => r.id)).toEqual(['c-new', 'c1']);
    expect(paginated?.total).toBe(2);
  });

  it('does not double-insert an already-present conversation (idempotent)', () => {
    const client = freshClient();
    client.setQueryData(['conversations', 'w1', 'ALL', 1], page([inboxRow, brandNew]));

    handleConversationNew(client, { websiteId: 'w1', conversation: brandNew });
    handleConversationNew(client, { websiteId: 'w1', conversation: brandNew });

    const paginated = client.getQueryData<Paginated<StaffConversation>>([
      'conversations',
      'w1',
      'ALL',
      1,
    ]);
    expect(paginated?.data).toHaveLength(2);
    expect(paginated?.total).toBe(2);
  });

  it('skips page > 1 and non-ALL/OPEN filters, then refetches as the fallback', () => {
    const client = freshClient();
    client.setQueryData(['conversations', 'w1', 'ALL', 2], page([inboxRow], 21));
    client.setQueryData(['conversations', 'w1', 'CLOSED', 1], page([inboxRow]));
    const spy = vi.spyOn(client, 'invalidateQueries');

    handleConversationNew(client, { websiteId: 'w1', conversation: brandNew });

    expect(spy).toHaveBeenCalledWith({ queryKey: ['conversations', 'w1'] });
  });

  it('refetches when no inbox page can hold the row (nothing cached)', () => {
    const client = freshClient();
    const spy = vi.spyOn(client, 'invalidateQueries');

    handleConversationNew(client, { websiteId: 'w1', conversation: brandNew });

    expect(spy).toHaveBeenCalledWith({ queryKey: ['conversations', 'w1'] });
  });

  it('keeps the row out of its own website only; other websites are untouched', () => {
    const client = freshClient();
    client.setQueryData(['conversations', 'w1', 'ALL', 1], page([]));
    client.setQueryData(['conversations', 'w2', 'ALL', 1], page([inboxRow]));

    handleConversationNew(client, { websiteId: 'w1', conversation: brandNew });

    expect(cachedRows(client, 'w1').map((r) => r.id)).toEqual(['c-new']);
    expect(cachedRows(client, 'w2').map((r) => r.id)).toEqual(['c1']);
  });
});

function cachedRows(client: QueryClient, websiteId: string): StaffConversation[] {
  return (
    client.getQueriesData<Paginated<StaffConversation>>({
      queryKey: ['conversations', websiteId],
    })[0]?.[1]?.data ?? []
  );
}
