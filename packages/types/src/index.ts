export type Role = 'ADMIN' | 'AGENT';

export type ConversationStatus = 'OPEN' | 'PENDING' | 'CLOSED';

export type MessageSender = 'VISITOR' | 'AGENT' | 'SYSTEM';

export type HealthStatus = 'ok' | 'error';

export type DatabaseStatus = 'up' | 'down';

export interface HealthResponse {
  status: HealthStatus;
  service: string;
  timestamp: string;
  database: DatabaseStatus;
}

/** The authenticated principal attached to a request. Never contains secrets. */
export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  role: Role;
}

/** A user representation safe to return to API clients. */
export interface PublicUser extends AuthUser {
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AuthResponse {
  accessToken: string;
  user: PublicUser;
}

/** Standard paginated envelope used by list endpoints. */
export interface Paginated<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

/**
 * A tenant website as seen by staff. `publicKey` is the public widget
 * credential (safe to publish); the database id is only ever needed by
 * staff-facing endpoints, never by the widget.
 */
export interface PublicWebsite {
  id: string;
  name: string;
  domain: string;
  publicKey: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/** An agent's membership on a single website, plus the member's profile. */
export interface WebsiteMember {
  id: string;
  userId: string;
  websiteId: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  user: PublicUser;
}

/**
 * What a visitor may read about itself. Deliberately omits the internal
 * database id: the widget only ever speaks publicKey + visitorKey.
 */
export interface PublicVisitor {
  visitorKey: string;
  name: string | null;
  email: string | null;
  createdAt: string;
  lastSeenAt: string;
}

/** A conversation as seen by the visitor who owns it. */
export interface PublicConversation {
  id: string;
  status: ConversationStatus;
  subject: string | null;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string | null;
  closedAt: string | null;
}

/**
 * A conversation as seen by staff of the owning website. `lastMessage` is the
 * newest message's wire representation (or null for an empty thread) so an
 * inbox can render a preview without a per-row history fetch.
 */
export interface StaffConversation extends PublicConversation {
  visitor: {
    id: string;
    name: string | null;
    email: string | null;
    lastSeenAt: string;
  };
  lastMessage: ChatMessage | null;
}

export interface ApiErrorResponse {
  statusCode: number;
  message: string | string[];
  error?: string;
}

// --------------------------------------------------------------- messaging

/**
 * One message as it appears on the wire (REST responses and WebSocket events
 * alike). Deliberately free of Prisma types: `senderName` is a resolved
 * display name (never an email), and internal sender ids are not exposed —
 * clients authorize by conversation, not by sender id.
 */
export interface ChatMessage {
  id: string;
  conversationId: string;
  senderType: MessageSender;
  senderName: string | null;
  content: string;
  /** Echo of the caller's idempotency key when one was supplied, else null. */
  clientMessageId: string | null;
  createdAt: string;
}

/**
 * Cursor-paginated page. Message history is ordered chronologically
 * ascending (oldest first); `nextCursor` is the opaque `before` value that
 * fetches the next *older* page, or null when the history is exhausted.
 */
export interface CursorPage<T> {
  data: T[];
  nextCursor: string | null;
  limit: number;
}

// ---------------------------------------------------------------- websocket

/** Error codes returned by WebSocket acks and the `error` event. */
export type WsErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VALIDATION'
  | 'CONFLICT'
  | 'CONVERSATION_CLOSED'
  | 'RATE_LIMITED'
  | 'INTERNAL';

export interface WsError {
  code: WsErrorCode;
  message: string;
}

/** Acknowledgement envelope for every client → server request.
 * The default (`object`) gives payload-free acks a plain `{ ok: true }`
 * success branch — a structurally impossible `{ ok: true } & Record<string, never>`. */
export type WsAck<T = object> = ({ ok: true } & T) | { ok: false; error: WsError };

/** Handshake credentials: exactly one of the two shapes is accepted. */
export interface WsHandshakeAuth {
  /** Staff: the same JWT used for REST (`Authorization: Bearer …`). */
  token?: string;
  /** Visitor: the Phase 4 public widget credentials. */
  publicKey?: string;
  visitorKey?: string;
}

export interface ConversationJoinInput {
  conversationId: string;
}

export interface ConversationLeaveInput {
  conversationId: string;
}

export interface MessageSendInput {
  conversationId: string;
  content: string;
  /** Optional idempotency key; a retry with the same key never duplicates. */
  clientMessageId?: string;
}

export type ConversationJoinResult = { conversation: PublicConversation };
export type MessageSendResult = { message: ChatMessage; replay: boolean };

/** A committed message fanned out to every authorized socket in the room. */
export interface MessageNewEvent {
  conversationId: string;
  message: ChatMessage;
}

/** Conversation fields that changed (e.g. PENDING → OPEN after a reply). */
export interface ConversationUpdatedEvent {
  conversation: PublicConversation;
}

export interface ConversationClosedEvent {
  conversationId: string;
  status: ConversationStatus;
  closedAt: string;
}

/** Socket.IO contract: events a client may emit. Acks carry results/errors. */
export interface ClientToServerEvents {
  'conversation:join': (
    payload: ConversationJoinInput,
    ack: (result: WsAck<ConversationJoinResult>) => void,
  ) => void;
  'conversation:leave': (payload: ConversationLeaveInput, ack: (result: WsAck) => void) => void;
  'message:send': (
    payload: MessageSendInput,
    ack: (result: WsAck<MessageSendResult>) => void,
  ) => void;
}

/** Socket.IO contract: events the server may push. */
export interface ServerToClientEvents {
  'message:new': (payload: MessageNewEvent) => void;
  'conversation:updated': (payload: ConversationUpdatedEvent) => void;
  'conversation:closed': (payload: ConversationClosedEvent) => void;
  error: (payload: { error: WsError }) => void;
}
