import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { ChatMessage, StaffConversation } from '@chatflow/types';
import { handleConversationClosed, handleConversationUpdated, handleMessageNew } from './realtime';
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
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

const inboxRow: StaffConversation = {
  id: 'c1',
  status: 'OPEN',
  subject: null,
  createdAt: '2026-10-09T09:00:00.000Z',
  updatedAt: '2026-10-09T09:00:00.000Z',
  lastMessageAt: null,
  closedAt: null,
  visitor: { id: 'v1', name: 'Aria', email: null, lastSeenAt: '2026-10-09T10:00:00.000Z' },
  lastMessage: null,
};

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
    client.setQueryData(['conversations', 'w1'], [inboxRow]);
    client.setQueryData(['conversation', 'w1', 'c1'], inboxRow);

    handleMessageNew(client, 'w1', { conversationId: 'c1', message: message('m2', 'updated') });

    const rows = cachedRows(client, 'w1');
    expect(rows[0]?.lastMessage?.content).toBe('updated');

    const detail = client.getQueryData(['conversation', 'w1', 'c1']) as typeof inboxRow;
    expect(detail.lastMessageAt).toBe('2026-10-09T10:00:00.000Z');
  });

  it('applies a status transition to detail and inbox', () => {
    const client = freshClient();
    client.setQueryData(['conversation', 'w1', 'c1'], inboxRow);
    client.setQueryData(['conversations', 'w1'], [inboxRow]);

    handleConversationUpdated(client, 'w1', {
      conversation: {
        id: 'c1',
        status: 'OPEN',
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
    client.setQueryData(['conversations', 'w1'], [inboxRow]);

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
    client.setQueryData(['conversations', 'w1'], [inboxRow]);
    client.setQueryData(['conversations', 'w2'], [{ ...inboxRow, id: 'other' }]);

    handleMessageNew(client, 'w1', { conversationId: 'c1', message: message('m3', 'hi') });

    const w1Rows = cachedRows(client, 'w1');
    const w2Rows = cachedRows(client, 'w2');
    expect(w1Rows[0]?.lastMessage?.content).toBe('hi');
    expect(w2Rows[0]?.lastMessage).toBeNull();
  });
});

function cachedRows(client: QueryClient, websiteId: string): StaffConversation[] {
  return (
    client.getQueriesData<StaffConversation[]>({
      queryKey: ['conversations', websiteId],
    })[0]?.[1] ?? []
  );
}
