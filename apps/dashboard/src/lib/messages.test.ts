import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage, MessageSendResult } from '@chatflow/types';
import {
  applyInboxClose,
  applyInboxMessage,
  httpFailure,
  mergeOlderPage,
  sendMessage,
  stateFromPage,
  upsertMessage,
  wsFailure,
  type RestTransport,
  type SendFailure,
  type SocketTransport,
} from './messages';

let seq = 0;
function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  seq += 1;
  return {
    id: `msg-${seq}`,
    conversationId: 'conv-1',
    senderType: 'VISITOR',
    senderName: 'Aria',
    content: `hello ${seq}`,
    clientMessageId: null,
    createdAt: `2026-10-09T10:00:${String(seq).padStart(2, '0')}.000Z`,
    ...overrides,
  };
}

const staffRow = {
  id: 'conv-1',
  status: 'OPEN' as const,
  subject: null,
  createdAt: '2026-10-09T09:00:00.000Z',
  updatedAt: '2026-10-09T09:00:00.000Z',
  lastMessageAt: null,
  closedAt: null,
  visitor: {
    id: 'visitor-1',
    name: 'Aria',
    email: 'aria@example.com',
    lastSeenAt: '2026-10-09T10:00:00.000Z',
  },
  lastMessage: null,
};

describe('stateFromPage', () => {
  it('takes the page data and its cursor', () => {
    const state = stateFromPage({ data: [message()], nextCursor: 'cursor-a' });
    expect(state.messages).toHaveLength(1);
    expect(state.nextCursor).toBe('cursor-a');
  });
});

describe('upsertMessage', () => {
  it('appends a new message and stays chronological', () => {
    const first = message({ createdAt: '2026-10-09T10:00:01.000Z' });
    const second = message({ createdAt: '2026-10-09T10:00:00.000Z' });
    let state = stateFromPage({ data: [first], nextCursor: null });
    state = upsertMessage(state, second);
    expect(state.messages.map((m) => m.id)).toEqual([second.id, first.id]);
  });

  it('never inserts the same id twice (ack + realtime event) ', () => {
    const msg = message();
    let state = stateFromPage({ data: [msg], nextCursor: null });
    state = upsertMessage(state, msg);
    expect(state.messages).toHaveLength(1);
  });
});

describe('mergeOlderPage', () => {
  it('merges older history, dedupes overlaps, and takes the older cursor', () => {
    const overlap = message({ id: 'shared', createdAt: '2026-10-09T10:00:05.000Z' });
    const newest = message({ createdAt: '2026-10-09T10:00:06.000Z' });
    const older = message({ createdAt: '2026-10-09T10:00:04.000Z' });

    const state = stateFromPage({ data: [newest, overlap], nextCursor: 'cursor-2' });
    const merged = mergeOlderPage(state, { data: [overlap, older], nextCursor: null });

    expect(merged.messages.map((m) => m.id)).toEqual([older.id, overlap.id, newest.id]);
    expect(merged.nextCursor).toBeNull();
  });
});

describe('inbox row updates', () => {
  it('bumps the preview row for the newest message', () => {
    const rows = applyInboxMessage([staffRow as never], message({ content: 'hi there' }));
    expect(rows[0]!.lastMessage?.content).toBe('hi there');
    expect(rows[0]!.lastMessageAt).toBeTruthy();
  });

  it('marks the inbox row closed', () => {
    const rows = applyInboxClose([staffRow as never], 'conv-1', '2026-10-09T11:00:00.000Z');
    expect(rows[0]!.status).toBe('CLOSED');
    expect(rows[0]!.closedAt).toBe('2026-10-09T11:00:00.000Z');
  });
});

describe('sendMessage — idempotency across transports', () => {
  const result = (): MessageSendResult => ({
    message: message({ clientMessageId: 'key-1' }),
    replay: false,
  });

  function makeSocket(overrides: Partial<SocketTransport> = {}): SocketTransport {
    return {
      canSend: () => true,
      send: vi.fn(async () => ({ status: 'ok' as const, message: result() })),
      ...overrides,
    };
  }
  function makeRest(overrides: Partial<RestTransport> = {}): RestTransport {
    return {
      send: vi.fn(async () => result()),
      ...overrides,
    };
  }

  it('prefers the socket when it acks', async () => {
    const socket = makeSocket();
    const rest = makeRest();
    const outcome = await sendMessage(
      { websiteId: 'w1', conversationId: 'c1', content: 'hi' },
      { socket, rest },
    );
    expect(outcome.result).not.toBeNull();
    expect(socket.send).toHaveBeenCalledOnce();
    expect(rest.send).not.toHaveBeenCalled();
  });

  it('reuses the same clientMessageId when the ack is lost', async () => {
    const socket = makeSocket({ send: vi.fn(async () => null) });
    const rest = makeRest();
    const outcome = await sendMessage(
      { websiteId: 'w1', conversationId: 'c1', content: 'hi' },
      { socket, rest },
    );
    expect(outcome.result).not.toBeNull();

    const socketCall = vi.mocked(socket.send).mock.calls[0]![0]!;
    const restCall = vi.mocked(rest.send).mock.calls[0]![0]!;
    expect(restCall.clientMessageId).toBe(socketCall.clientMessageId);
    expect(restCall.content).toBe('hi');
  });

  it('falls back to REST when the socket is disconnected', async () => {
    const socket = makeSocket({ canSend: () => false });
    const rest = makeRest();
    const outcome = await sendMessage(
      { websiteId: 'w1', conversationId: 'c1', content: 'hi' },
      { socket, rest },
    );
    expect(outcome.result).not.toBeNull();
    expect(socket.send).not.toHaveBeenCalled();
    expect(rest.send).toHaveBeenCalledOnce();
  });

  it('surfaces a server refusal without touching REST', async () => {
    const failure: SendFailure = {
      code: 'CONVERSATION_CLOSED',
      message: 'This conversation is closed.',
    };
    const socket = makeSocket({
      send: vi.fn(async () => ({ status: 'refused' as const, failure })),
    });
    const rest = makeRest();
    const outcome = await sendMessage(
      { websiteId: 'w1', conversationId: 'c1', content: 'hi' },
      { socket, rest },
    );
    expect(outcome.failure?.code).toBe('CONVERSATION_CLOSED');
    expect(rest.send).not.toHaveBeenCalled();
  });

  it('maps a REST failure into a friendly code', async () => {
    const socket = makeSocket({ canSend: () => false });
    const rest = makeRest({
      send: vi.fn(async () => {
        throw { status: 429 };
      }),
    });
    const outcome = await sendMessage(
      { websiteId: 'w1', conversationId: 'c1', content: 'hi' },
      { socket, rest },
    );
    expect(outcome.result).toBeNull();
    expect(outcome.failure?.code).toBe('RATE_LIMITED');
  });
});

describe('error mapping', () => {
  it('maps HTTP statuses to friendly codes', () => {
    expect(httpFailure({ status: 0 }).code).toBe('NETWORK');
    expect(httpFailure({ status: 403 }).code).toBe('FORBIDDEN');
    expect(httpFailure({ status: 404 }).code).toBe('NOT_FOUND');
    expect(httpFailure({ status: 409 }).code).toBe('CONFLICT');
    expect(httpFailure({ status: 429 }).code).toBe('RATE_LIMITED');
    expect(httpFailure({ status: 500 }).code).toBe('INTERNAL');
  });

  it('keeps the server message for validation errors', () => {
    expect(
      httpFailure({
        status: 400,
        message: 'content must be shorter than or equal to 4000 characters',
      }).message,
    ).toContain('4000');
  });

  it('maps WS error codes to friendly codes', () => {
    expect(wsFailure({ code: 'CONVERSATION_CLOSED', message: 'no' }).code).toBe(
      'CONVERSATION_CLOSED',
    );
    expect(wsFailure({ code: 'UNKNOWN_THING', message: '' } as never).code).toBe('INTERNAL');
  });
});
