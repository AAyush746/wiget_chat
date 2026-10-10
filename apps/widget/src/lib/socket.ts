import { io, type Socket } from 'socket.io-client';
import type {
  ClientToServerEvents,
  ConversationClosedEvent,
  ConversationJoinResult,
  ConversationUpdatedEvent,
  MessageNewEvent,
  MessageSendInput,
  MessageSendResult,
  ServerToClientEvents,
  WsAck,
} from '@chatflow/types';

export type SocketStatus = 'disconnected' | 'connecting' | 'connected';

export type VisitorSocketEvent =
  | { type: 'status'; status: SocketStatus }
  | { type: 'reconnected' }
  | { type: 'message:new'; payload: MessageNewEvent }
  | { type: 'conversation:updated'; payload: ConversationUpdatedEvent }
  | { type: 'conversation:closed'; payload: ConversationClosedEvent }
  | { type: 'error'; payload: { code: string; message: string } };

type Listener = (event: VisitorSocketEvent) => void;
type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const ACK_TIMEOUT_MS = 8_000;

/**
 * One Socket.IO connection per visitor, authenticated with the opaque
 * `visitorKey` (never a staff JWT). Wraps the transport exactly like the
 * dashboard's `ChatSocket`: server acks are authoritative, `reconnected` is a
 * distinct signal so the app can resynchronize from REST, and a missing ack
 * resolves `null` so callers retry over REST with the same idempotency key.
 */
export class VisitorSocket {
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

  connect(apiUrl: string, credentials: { publicKey: string; visitorKey: string }): void {
    if (this.socket) {
      return;
    }
    this.setStatus('connecting');

    const socket: TypedSocket = io(apiUrl, {
      auth: { publicKey: credentials.publicKey, visitorKey: credentials.visitorKey },
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
    socket.on('message:new', (payload) => this.emit({ type: 'message:new', payload }));
    socket.on('conversation:updated', (payload) =>
      this.emit({ type: 'conversation:updated', payload }),
    );
    socket.on('conversation:closed', (payload) =>
      this.emit({ type: 'conversation:closed', payload }),
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

  private emit(event: VisitorSocketEvent): void {
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

/** The single transport per visitor session (module singleton). */
export const visitorSocket = new VisitorSocket();
