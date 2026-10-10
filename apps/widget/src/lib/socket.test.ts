import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MessageSendResult } from '@chatflow/types';
import { VisitorSocket } from './socket';

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

const CREDENTIALS = { publicKey: 'Ak9x_vLp2Mq7zQw1eRnt8Yb0', visitorKey: 'visitor-secret' };

function makeSocket(): { socket: VisitorSocket; fake: FakeSocket } {
  const fake = new FakeSocket('http://localhost:4000', {});
  ioMock.mockReturnValue(fake);
  const socket = new VisitorSocket();
  socket.connect('http://localhost:4000', CREDENTIALS);
  expect(ioMock).toHaveBeenCalledWith(
    'http://localhost:4000',
    expect.objectContaining({ auth: CREDENTIALS }),
  );
  return { socket, fake };
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

describe('VisitorSocket', () => {
  it('connects with the website public key + visitor key and emits status', () => {
    const states: string[] = [];
    const fake = new FakeSocket('http://localhost:4000', {});
    ioMock.mockReturnValue(fake);
    const socket = new VisitorSocket();
    socket.subscribe((event) => {
      if (event.type === 'status') states.push(event.status);
    });

    socket.connect('http://localhost:4000', CREDENTIALS);
    expect(ioMock).toHaveBeenCalledWith(
      'http://localhost:4000',
      expect.objectContaining({ auth: CREDENTIALS }),
    );
    expect(socket.getState()).toBe('connecting');
    expect(states).toEqual(['connecting']);

    fake.serverEmit('connect');
    expect(socket.getState()).toBe('connected');
    expect(states).toEqual(['connecting', 'connected']);
  });

  it('emits a distinct reconnected event on a subsequent connect, not the first', () => {
    const seen: string[] = [];
    const { socket, fake } = makeSocket();
    socket.subscribe((event) => {
      if (event.type !== 'status') seen.push(event.type);
    });
    fake.serverEmit('connect');
    fake.serverEmit('disconnect');
    fake.serverEmit('connect');
    expect(seen).toEqual(['reconnected']);
  });

  it('sends with the visitor credentials and resolves the ack payload', async () => {
    const { socket, fake } = makeSocket();
    fake.serverEmit('connect');

    const result = socket.send({ conversationId: 'c1', content: 'hi', clientMessageId: 'k' });
    expect(fake.sent.at(-1)?.event).toBe('message:send');
    expect(fake.sent.at(-1)?.args[0]).toMatchObject({ conversationId: 'c1', content: 'hi' });

    fake.lastAck('message:send')(serverMessage());
    await expect(result).resolves.toEqual(serverMessage());
  });

  it('resolves null when the server never acks a send (REST retry with same key)', async () => {
    vi.useFakeTimers();
    const { socket, fake } = makeSocket();
    fake.serverEmit('connect');

    let resolved: unknown = Symbol('pending');
    void socket
      .send({ conversationId: 'c1', content: 'hi', clientMessageId: 'k' })
      .then((value) => {
        resolved = value;
      });
    await vi.advanceTimersByTimeAsync(8_000);
    expect(resolved).toBeNull();
  });

  it('relays pushed server events to subscribers', async () => {
    const { socket, fake } = makeSocket();
    fake.serverEmit('connect');

    const kinds: string[] = [];
    socket.subscribe((event) => kinds.push(event.type));

    fake.serverEmit('message:new', { conversationId: 'c1', message: serverMessage().message });
    fake.serverEmit('conversation:closed', {
      conversationId: 'c1',
      status: 'CLOSED',
      closedAt: '2026-10-09T10:00:00.000Z',
    });
    fake.serverEmit('error', { error: { code: 'RATE_LIMITED', message: 'slow down' } });

    expect(kinds).toEqual(['message:new', 'conversation:closed', 'error']);
  });

  it('disconnect tears down and connect opens a fresh transport', () => {
    ioMock.mockClear();
    const first = makeSocket();
    first.fake.serverEmit('connect');
    expect(first.socket.isConnected()).toBe(true);

    first.socket.disconnect();
    expect(first.socket.getState()).toBe('disconnected');
    expect(first.socket.isConnected()).toBe(false);

    const second = makeSocket();
    expect(ioMock).toHaveBeenCalledTimes(2);
    expect(second.socket.send).toBeDefined();
  });
});
