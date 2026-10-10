export type Role = 'ADMIN' | 'AGENT';

export type ConversationStatus = 'OPEN' | 'PENDING' | 'CLOSED';

export type MessageSender = 'VISITOR' | 'AGENT' | 'SYSTEM' | 'AI';

/**
 * Who is on the hook to reply. `AI` means the automatic assistant may answer
 * the next visitor message; `HANDOFF_PENDING` means the AI (or the visitor)
 * requested a human and no agent has claimed the thread yet; `HUMAN` means a
 * human agent owns the conversation and the AI is muted until an authorized
 * staff action explicitly releases the thread back to it.
 */
export type HandlingMode = 'AI' | 'HANDOFF_PENDING' | 'HUMAN';

/**
 * Recorded human-handoff reasons (staff-facing, lowercase snake keys). Sent by
 * the server, never free-form client text.
 */
export type HandoffReason =
  'VISITOR_REQUESTED' | 'UNSUPPORTED' | 'LOW_CONFIDENCE' | 'AI_FAILURE' | 'LIMIT_REACHED';

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
  /** Whether the automatic AI assistant may reply to this site's visitors. */
  aiEnabled: boolean;
  /** Configured pre-written escalation reply, or null when unset. */
  aiFallbackMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Write payload for the (ADMIN-only) AI settings endpoint. */
export interface AiSettingsUpdate {
  aiEnabled?: boolean;
  aiFallbackMessage?: string | null;
}

/**
 * The model backend the AI agent is wired to. `mock` is the built-in,
 * offline, deterministic responder (no external calls); `openai` and `groq`
 * are real chat-completions providers (Groq offers a free tier).
 */
export type AiProviderName = 'mock' | 'openai' | 'groq';

/**
 * Staff-facing view of a website's AI agent ("Connect Agent" panel): whether
 * the agent is connected, its escalation reply, and which provider backend is
 * actually configured for the deployment.
 */
export interface AiAgentStatus {
  aiEnabled: boolean;
  aiFallbackMessage: string | null;
  provider: AiProviderName;
  model: string;
  /** True when the provider has everything it needs (e.g. a configured key). */
  ready: boolean;
  /** Short human-readable description of the backend, for the dashboard. */
  description: string;
}

/** One Q&A entry in a website's AI knowledge base. */
export interface FaqEntry {
  id: string;
  websiteId: string;
  question: string;
  answer: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateFaqInput {
  question: string;
  answer: string;
}

export interface UpdateFaqInput {
  question?: string;
  answer?: string;
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
  handling: HandlingMode;
  subject: string | null;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string | null;
  closedAt: string | null;
}

/**
 * A conversation as seen by staff of the owning website. `lastMessage` is the
 * newest message's wire representation (or null for an empty thread) so an
 * inbox can render a preview without a per-row history fetch. `assignedAgent`
 * is the current assignee (null when unassigned) — staff-internal, never
 * included in `PublicConversation`.
 */
export interface StaffConversation extends PublicConversation {
  visitor: {
    id: string;
    name: string | null;
    email: string | null;
    lastSeenAt: string;
  };
  assignedAgent: { id: string; name: string | null } | null;
  /** Recorded escalation code for the current/last handoff (staff-internal). */
  handoffReason: HandoffReason | null;
  /** When the current/last handoff to a human was requested. */
  handoffRequestedAt: string | null;
  lastMessage: ChatMessage | null;
}

/** One row of a conversation's append-only assignment history. */
export interface ConversationAssignmentEntry {
  id: string;
  userId: string;
  user: { id: string; name: string | null; email: string | null };
  assignedById: string | null;
  assignedBy: { id: string; name: string | null; email: string | null } | null;
  assignedAt: string;
  /** When this assignment ended (null = the conversation's current assignee). */
  unassignedAt: string | null;
  /** Derived: `unassignedAt === null`. */
  active: boolean;
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

/**
 * Fan-out after a conversation is created by a visitor. Pushed to the owning
 * website's staff inbox room so agents see the new row without a refetch —
 * even when no staff socket has joined the conversation room yet.
 */
export interface ConversationNewEvent {
  websiteId: string;
  conversation: StaffConversation;
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

/**
 * Fan-out after a claim/assign/reassign commits. Pushed only to staff sockets
 * subscribed to the conversation (never to the visitor's socket): assignment
 * is staff-internal and must not leak who the agent is.
 */
export interface ConversationAssignedEvent {
  conversationId: string;
  assignedAgent: { id: string; name: string | null } | null;
  assignedAt: string;
  /** Always `HUMAN`: taking/assigning ownership mutes the AI assistant. */
  handling: HandlingMode;
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
  'conversation:new': (payload: ConversationNewEvent) => void;
  'message:new': (payload: MessageNewEvent) => void;
  'conversation:updated': (payload: ConversationUpdatedEvent) => void;
  'conversation:closed': (payload: ConversationClosedEvent) => void;
  'conversation:assigned': (payload: ConversationAssignedEvent) => void;
  error: (payload: { error: WsError }) => void;
}

// ------------------------------------------------------------------ reporting
//
// Reporting reads the append-only `ConversationEvent` table plus the denormalized
// `websiteId` on conversations/messages, so every query below is tenant- and
// time-filtered without joining across tenants.

/** The window a report was computed over, echoed back so a client can label it. */
export interface ReportWindow {
  from: string;
  to: string;
}

/** Headline KPIs for one website over the reporting window. */
export interface ReportSummary extends ReportWindow {
  /** Conversations *created* inside the window. */
  conversationsCreated: number;
  /** Conversations *closed* inside the window (not "now closed"). */
  conversationsClosed: number;
  /** Current standing inventory across the whole website. */
  open: number;
  pending: number;
  closed: number;
  /** Conversations that received at least one automated AI reply. */
  aiHandled: number;
  /** Conversations that were escalated to a human queue. */
  handedOff: number;
  visitorMessages: number;
  agentMessages: number;
  aiMessages: number;
  /** Average visitor-open → first human reply, in milliseconds (null if none). */
  avgFirstResponseMs: number | null;
  /** Average creation → close, over conversations closed in the window. */
  avgResolutionMs: number | null;
  /** Share of created conversations the AI handled, 0–1. */
  aiHandlingRate: number;
  /** Share of created conversations that ended up in the human queue, 0–1. */
  handoffRate: number;
}

export interface ReportTimeseriesPoint {
  /** Bucket start, ISO 8601. */
  bucket: string;
  conversationsCreated: number;
  conversationsClosed: number;
  visitorMessages: number;
  agentMessages: number;
  aiMessages: number;
}

export interface ReportTimeseries extends ReportWindow {
  bucket: 'hour' | 'day' | 'week';
  points: ReportTimeseriesPoint[];
}

/** One agent's row in the team-performance table. */
export interface ReportAgentRow {
  userId: string;
  name: string;
  email: string;
  /** Assignment windows opened inside the reporting window. */
  assigned: number;
  /** Of those, conversations closed inside the window. */
  resolved: number;
  /** Still open and currently assigned to them. */
  currentlyOpen: number;
  /** Reassignments away from them — a churn / contention signal. */
  reassignedAway: number;
  agentMessages: number;
  /** Median-ish average of their first-response times, in milliseconds. */
  avgFirstResponseMs: number | null;
}

/** A single conversation as listed in the report drill-down / CSV export. */
export interface ReportConversationRow {
  id: string;
  createdAt: string;
  closedAt: string | null;
  status: string;
  handling: string;
  subject: string | null;
  visitorName: string | null;
  visitorEmail: string | null;
  assignedAgentName: string | null;
  firstResponseMs: number | null;
  resolutionMs: number | null;
  messageCount: number;
  aiMessageCount: number;
}

export interface ReportConversations extends ReportWindow {
  total: number;
  data: ReportConversationRow[];
}

/** Everything the Reports screen needs, in one round trip. */
export interface ReportOverview {
  summary: ReportSummary;
  timeseries: ReportTimeseries;
  agents: ReportAgentRow[];
}

export interface ReportAgentsPage extends ReportWindow {
  data: ReportAgentRow[];
}
