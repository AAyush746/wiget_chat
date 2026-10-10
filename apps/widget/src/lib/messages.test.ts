import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage, MessageSendResult } from '@chatflow/types';
import {
  addPending,
  clearPending,
  createPending,
  httpFailure,
  markPendingError,
  mergeHistory,
  mergeThread,
  sendMessage,
  upsertMessage,
  wsFailure,
  type PendingMessage,
  type RestTransport,
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

function pending(overrides: Partial<PendingMessage> = {}): PendingMessage {
  return {
    clientMessageId: 'key-1',
    conversationId: 'conv-1',
    content: 'optimistic',
    status: 'sending',
    error: null,
    createdAt: '2026-10-09T10:01:00.000Z',
    ...overrides,
  };
}

describe('server-confirmed reconciliation', () => {
  it('upsertMessage appends in chronological order and dedupes by id', () => {
    const older = message({ id: 'm-old', createdAt: '2026-10-09T10:00:00.000Z' });
    const newer = message({ id: 'm-new', createdAt: '2026-10-09T10:00:10.000Z' });

    let list = upsertMessage([older], newer);
    expect(list.map((m) => m.id)).toEqual(['m-old', 'm-new']);

    // ack + realtime event for the same message must not render twice
    list = upsertMessage(list, newer);
    expect(list).toHaveLength(2);
  });

  it('mergeHistory dedupes overlapping pages', () => {
    const overlap = message({ id: 'shared', createdAt: '2026-10-09T10:00:05.000Z' });
    const newest = message({ id: 'newest', createdAt: '2026-10-09T10:00:06.000Z' });
    const oldest = message({ id: 'oldest', createdAt: '2026-10-09T10:00:04.000Z' });

    const merged = mergeHistory([newest, overlap], [overlap, oldest]);
    expect(merged.map((m) => m.id)).toEqual(['oldest', 'shared', 'newest']);
  });
});

describe('pending (optimistic) rows', () => {
  it('createPending owns a stable identity for retries', () => {
    const first = createPending('hi', 'conv-1');
    const second = createPending('hi', 'conv-1');
    expect(first.clientMessageId).not.toBe(second.clientMessageId);
    expect(first).toMatchObject({
      conversationId: 'conv-1',
      content: 'hi',
      status: 'sending',
      error: null,
    });
  });

  it('addPending keeps a single row per clientMessageId', () => {
    const row = pending();
    expect(addPending([row], row)).toHaveLength(1);
    expect(addPending([], row)).toEqual([row]);
  });

  it('markPendingError and clearPending update/remove the matching row', () => {
    const row = pending();
    const errored = markPendingError([row], 'key-1', 'Cannot reach the server.');
    expect(errored[0]).toMatchObject({ status: 'error', error: 'Cannot reach the server.' });

    const cleared = clearPending(errored, 'key-1');
    expect(cleared).toEqual([]);
  });

  it('mergeThread interleaves confirmed and optimistic rows by time', () => {
    const confirmed = message({ id: 'm', createdAt: '2026-10-09T10:00:30.000Z' });
    const optimistic = pending({ createdAt: '2026-10-09T10:00:45.000Z' });

    const thread = mergeThread([confirmed], [optimistic]);
    expect(thread).toEqual([
      { kind: 'server', message: confirmed },
      { kind: 'pending', pending: optimistic },
    ]);
  });
});

describe('sendMessage — one idempotency key across transports', () => {
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
  const input = { conversationId: 'c1', content: 'hi', clientMessageId: 'key-1' };

  it('prefers the socket when it acks', async () => {
    const socket = makeSocket();
    const rest = makeRest();
    const outcome = await sendMessage(input, { socket, rest });
    expect(outcome.result).not.toBeNull();
    expect(socket.send).toHaveBeenCalledOnce();
    expect(rest.send).not.toHaveBeenCalled();
  });

  it('reuses the same clientMessageId when the ack is lost', async () => {
    const socket = makeSocket({ send: vi.fn(async () => null) });
    const rest = makeRest();
    await sendMessage(input, { socket, rest });

    const socketCall = vi.mocked(socket.send).mock.calls[0]![0]!;
    const restCall = vi.mocked(rest.send).mock.calls[0]![0]!;
    expect(restCall.clientMessageId).toBe(socketCall.clientMessageId);
    expect(restCall.content).toBe('hi');
  });

  it('falls back to REST when the socket is disconnected', async () => {
    const socket = makeSocket({ canSend: () => false });
    const rest = makeRest();
    const outcome = await sendMessage(input, { socket, rest });
    expect(outcome.result).not.toBeNull();
    expect(socket.send).not.toHaveBeenCalled();
    expect(rest.send).toHaveBeenCalledOnce();
  });

  it('surfaces a server refusal without touching REST', async () => {
    const socket = makeSocket({
      send: vi.fn(async () => ({
        status: 'refused' as const,
        failure: { code: 'CONVERSATION_CLOSED' as const, message: 'This conversation is closed.' },
      })),
    });
    const rest = makeRest();
    const outcome = await sendMessage(input, { socket, rest });
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
    const outcome = await sendMessage(input, { socket, rest });
    expect(outcome.result).toBeNull();
    expect(outcome.failure?.code).toBe('RATE_LIMITED');
  });
});

describe('failure mapping', () => {
  it('maps HTTP statuses to friendly codes', () => {
    expect(httpFailure({ status: 0 }).code).toBe('NETWORK');
    expect(httpFailure({ status: 400 }).code).toBe('VALIDATION');
    expect(httpFailure({ status: 403 }).code).toBe('FORBIDDEN');
    expect(httpFailure({ status: 404 }).code).toBe('NOT_FOUND');
    expect(httpFailure({ status: 409 }).code).toBe('CONFLICT');
    expect(httpFailure({ status: 429 }).code).toBe('RATE_LIMITED');
    expect(httpFailure({ status: 500 }).code).toBe('INTERNAL');
  });

  it('keeps the server message for validation errors', () => {
    expect(
      httpFailure({ status: 400, message: 'content must be at most 4000 characters' }).message,
    ).toContain('4000');
  });

  it('maps WS error codes to friendly codes', () => {
    expect(wsFailure({ code: 'CONVERSATION_CLOSED', message: 'no' }).code).toBe(
      'CONVERSATION_CLOSED',
    );
    expect(wsFailure({ code: 'UNKNOWN_THING', message: '' } as never).code).toBe('INTERNAL');
  });
});
