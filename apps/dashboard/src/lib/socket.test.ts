import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MessageSendResult } from '@chatflow/types';
import { ChatSocket } from './socket';

type AnyFn = (...args: unknown[]) => void;

class FakeSocket {
  listeners = new Map<string, AnyFn[]>();
  sent: { event: string; args: unknown[] }[] = [];

  constructor(
    public url: string,
    public opts: Record<string, unknown>,
  ) {}

  on(event: string, listener: AnyFn): this {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }

  emit(event: string, ...args: unknown[]): this {
    this.sent.push({ event, args });
    return this;
  }

  serverEmit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }

  lastAck(event: string): (result: unknown) => void {
    const entry = [...this.sent].reverse().find((e) => e.event === event);
    if (!entry || typeof entry.args[entry.args.length - 1] !== 'function') {
      throw new Error(`no ack callback for ${event}`);
    }
    return entry.args[entry.args.length - 1] as (result: unknown) => void;
  }

  disconnect(): this {
    return this;
  }

  removeAllListeners(): this {
    this.listeners.clear();
    return this;
  }
}

const ioMock = vi.hoisted(() => vi.fn());

vi.mock('socket.io-client', () => ({ io: ioMock }));

function makeChat(token = 'token-t'): { chat: ChatSocket; fake: FakeSocket } {
  const fake = new FakeSocket('/', {});
  ioMock.mockReturnValue(fake);
  const chat = new ChatSocket();
  chat.connect(token);
  expect(ioMock).toHaveBeenCalledWith('/', expect.objectContaining({ auth: { token } }));
  return { chat, fake };
}

const serverMessage = (id = 'm1'): { ok: true } & MessageSendResult => ({
  ok: true as const,
  replay: false,
  message: {
    id,
    conversationId: 'c1',
    senderType: 'AGENT',
    senderName: null,
    content: 'hi',
    clientMessageId: 'k',
    createdAt: '2026-10-09T10:00:00.000Z',
  },
});

afterEach(() => {
  ioMock.mockReset();
  vi.useRealTimers();
});

describe('ChatSocket', () => {
  it('connects with the bearer token in the handshake and emits status', () => {
    const states: string[] = [];
    const fake = new FakeSocket('/', {});
    ioMock.mockReturnValue(fake);
    const chat = new ChatSocket();
    chat.subscribe((event) => {
      if (event.type === 'status') states.push(event.status);
    });

    chat.connect('token-abc');
    expect(ioMock).toHaveBeenCalledWith(
      '/',
      expect.objectContaining({ auth: { token: 'token-abc' } }),
    );
    expect(chat.getState()).toBe('connecting');
    expect(states).toEqual(['connecting']);

    fake.serverEmit('connect');
    expect(chat.getState()).toBe('connected');
    expect(states).toEqual(['connecting', 'connected']);
  });

  it('emits a distinct reconnected event on a subsequent connect, not the first', () => {
    const seen: string[] = [];
    const { chat, fake } = makeChat();
    chat.subscribe((event) => {
      if (event.type !== 'status') seen.push(event.type);
    });
    fake.serverEmit('connect');
    fake.serverEmit('disconnect');
    fake.serverEmit('connect');
    expect(seen).toEqual(['reconnected']);
  });

  it('acknowledges conversation:join with the server payload', async () => {
    const { chat, fake } = makeChat();
    fake.serverEmit('connect');

    const result = chat.join('c1');
    expect(fake.sent.at(-1)?.event).toBe('conversation:join');
    fake.lastAck('conversation:join')({ ok: true, conversation: { id: 'c1' } });

    await expect(result).resolves.toEqual({ ok: true, conversation: expect.anything() });
  });

  it('resolves sends with the ack payload', async () => {
    const { chat, fake } = makeChat();
    fake.serverEmit('connect');

    const result = chat.send({ conversationId: 'c1', content: 'hi', clientMessageId: 'k' });
    expect(fake.sent.at(-1)?.event).toBe('message:send');

    fake.lastAck('message:send')(serverMessage());
    await expect(result).resolves.toEqual(serverMessage());
  });

  it('resolves null when the server never acks a send', async () => {
    vi.useFakeTimers();
    const { chat, fake } = makeChat();
    fake.serverEmit('connect');

    let resolved: unknown = Symbol('pending');
    void chat.send({ conversationId: 'c1', content: 'hi', clientMessageId: 'k' }).then((value) => {
      resolved = value;
    });
    await vi.advanceTimersByTimeAsync(8_000);
    expect(resolved).toBeNull();
  });

  it('relays pushed server events to subscribers', async () => {
    const { chat, fake } = makeChat();
    fake.serverEmit('connect');

    const kinds: string[] = [];
    chat.subscribe((event) => kinds.push(event.type));

    fake.serverEmit('conversation:new', {
      websiteId: 'w1',
      conversation: { id: 'c-new' },
    });
    fake.serverEmit('message:new', { conversationId: 'c1', message: serverMessage().message });
    fake.serverEmit('conversation:closed', {
      conversationId: 'c1',
      status: 'CLOSED',
      closedAt: '2026-10-09T10:00:00.000Z',
    });
    fake.serverEmit('conversation:assigned', {
      conversationId: 'c1',
      assignedAgent: { id: 'u9', name: 'Bryn' },
      assignedAt: '2026-10-09T10:05:00.000Z',
    });
    fake.serverEmit('error', { error: { code: 'RATE_LIMITED', message: 'slow down' } });

    expect(kinds).toEqual([
      'conversation:new',
      'message:new',
      'conversation:closed',
      'conversation:assigned',
      'error',
    ]);
  });

  it('disconnect tears the transport down and a new connect opens a fresh one', () => {
    ioMock.mockClear();
    const first = makeChat('a');
    first.fake.serverEmit('connect');
    expect(first.chat.isConnected()).toBe(true);

    first.chat.disconnect();
    expect(first.chat.getState()).toBe('disconnected');
    expect(first.chat.isConnected()).toBe(false);

    const second = makeChat('b');
    expect(ioMock).toHaveBeenCalledTimes(2);
    expect(ioMock.mock.calls[1]).toEqual(['/', expect.objectContaining({ auth: { token: 'b' } })]);
    expect(second.chat.send).toBeDefined();
  });
});
