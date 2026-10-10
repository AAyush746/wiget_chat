import { io, type Socket } from 'socket.io-client';
import type {
  ClientToServerEvents,
  ConversationJoinResult,
  MessageSendInput,
  MessageSendResult,
  ServerToClientEvents,
  WsAck,
} from '@chatflow/types';
import type {
  MessageNewEvent,
  ConversationNewEvent,
  ConversationUpdatedEvent,
  ConversationClosedEvent,
  ConversationAssignedEvent,
} from '@chatflow/types';

export type SocketStatus = 'disconnected' | 'connecting' | 'connected';

/**
 * Events multiplexed to dashboard subscribers. `reconnected` is a distinct
 * signal: it fires only when a previously-connected session re-establishes
 * the transport, so the app can re-sync authoritative state (refetch REST,
 * rejoin the active room) instead of trusting stale front-end state.
 */
export type ChatSocketEvent =
  | { type: 'status'; status: SocketStatus }
  | { type: 'reconnected' }
  | { type: 'conversation:new'; payload: ConversationNewEvent }
  | { type: 'message:new'; payload: MessageNewEvent }
  | { type: 'conversation:updated'; payload: ConversationUpdatedEvent }
  | { type: 'conversation:closed'; payload: ConversationClosedEvent }
  | { type: 'conversation:assigned'; payload: ConversationAssignedEvent }
  | { type: 'error'; payload: { code: string; message: string } };

type Listener = (event: ChatSocketEvent) => void;

type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const ACK_TIMEOUT_MS = 8_000;

/**
 * One authenticated Socket.IO connection per dashboard session — a maximally
 * simple reference-counted singleton so React's mount/unmount (including
 * StrictMode double-mounts) can never open more than one transport.
 *
 * The server is the authority: this wrapper only exposes acks (join/leave/
 * send), relays pushed events, and tracks connection state. It never treats
 * a realtime event as durable state.
 */
export class ChatSocket {
  private socket: TypedSocket | null = null;
  private readonly listeners = new Set<Listener>();
  private status: SocketStatus = 'disconnected';
  private hadConnection = false;

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getState(): SocketStatus {
    return this.status;
  }

  isConnected(): boolean {
    return this.status === 'connected';
  }

  connect(token: string): void {
    if (this.socket) {
      // Already establishing/re-establishing this session.
      return;
    }
    this.setStatus('connecting');

    const socket: TypedSocket = io('/', {
      auth: { token },
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1_000,
      reconnectionDelayMax: 8_000,
      randomizationFactor: 0.5,
      timeout: 10_000,
    });
    this.socket = socket;

    socket.on('connect', () => {
      const reconnected = this.hadConnection;
      this.hadConnection = true;
      this.status = 'connected';
      this.emit({ type: 'status', status: 'connected' });
      if (reconnected) {
        this.emit({ type: 'reconnected' });
      }
    });
    socket.on('disconnect', () => this.setStatus('disconnected'));
    socket.on('connect_error', () => this.setStatus('disconnected'));
    socket.on('conversation:new', (payload) => this.emit({ type: 'conversation:new', payload }));
    socket.on('message:new', (payload) => this.emit({ type: 'message:new', payload }));
    socket.on('conversation:updated', (payload) =>
      this.emit({ type: 'conversation:updated', payload }),
    );
    socket.on('conversation:closed', (payload) =>
      this.emit({ type: 'conversation:closed', payload }),
    );
    socket.on('conversation:assigned', (payload) =>
      this.emit({ type: 'conversation:assigned', payload }),
    );
    socket.on('error', ({ error }) => this.emit({ type: 'error', payload: error }));
  }

  disconnect(): void {
    this.socket?.disconnect();
    this.socket?.removeAllListeners();
    this.socket = null;
    this.hadConnection = false;
    this.setStatus('disconnected');
  }

  join(conversationId: string): Promise<WsAck<ConversationJoinResult>> {
    return this.ack<ConversationJoinResult>((resolve) => {
      this.requireSocket().emit('conversation:join', { conversationId }, (result) =>
        resolve(result),
      );
    }).then((ack) => {
      if (ack === null) {
        throw new Error('no ack for conversation:join');
      }
      return ack;
    });
  }

  leave(conversationId: string): Promise<WsAck> {
    return this.ack<object>((resolve) => {
      this.requireSocket().emit('conversation:leave', { conversationId }, (result) =>
        resolve(result),
      );
    }).then((ack) => {
      if (ack === null) {
        throw new Error('no ack for conversation:leave');
      }
      return ack;
    });
  }

  /**
   * Sends a message and resolves with the server's ack, or `null` when the
   * socket never answered (a dropped ack — the caller falls back to REST with
   * the *same* `clientMessageId` so the backend collapses any duplicate).
   */
  send(input: MessageSendInput): Promise<WsAck<MessageSendResult> | null> {
    return this.ack<MessageSendResult>((resolve) => {
      this.requireSocket().emit('message:send', input, (result) => resolve(result));
    });
  }

  // ---------------------------------------------------------------- internals

  private setStatus(status: SocketStatus): void {
    if (this.status !== status) {
      this.status = status;
      this.emit({ type: 'status', status });
    }
  }

  private emit(event: ChatSocketEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private requireSocket(): TypedSocket {
    if (!this.socket) {
      throw new Error('socket not connected');
    }
    return this.socket;
  }

  /** Wrap an ack callback; resolves `null` when the server stayed silent. */
  private ack<T>(
    emitToSocket: (onAck: (result: WsAck<T>) => void) => void,
  ): Promise<WsAck<T> | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), ACK_TIMEOUT_MS);
      emitToSocket((result) => {
        clearTimeout(timer);
        resolve(result);
      });
    });
  }
}

/** The single per-session transport instance used across the dashboard. */
export const chatSocket = new ChatSocket();
