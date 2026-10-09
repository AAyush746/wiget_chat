import type { ChatMessage, MessageSendResult, StaffConversation, WsError } from '@chatflow/types';

/**
 * Pure helpers for reconciling server-confirmed messages with UI state.
 *
 * The invariant every helper enforces: a message is identified by its server
 * `id`; the same id arriving via an ack, a realtime event, or history is the
 * same message and is never rendered twice.
 */

const MESSAGE_LIMIT = 50;

export interface MessagesState {
  messages: ChatMessage[];
  /** Opaque `before` cursor; null when no older history remains. */
  nextCursor: string | null;
}

export interface MessagesPage {
  data: ChatMessage[];
  nextCursor: string | null;
}

const compare = (a: ChatMessage, b: ChatMessage): number => {
  const byTime = a.createdAt.localeCompare(b.createdAt);
  return byTime !== 0 ? byTime : a.id.localeCompare(b.id);
};

/** Initial state populated from a REST history page (newest N, oldest first). */
export function stateFromPage(page: MessagesPage): MessagesState {
  return {
    messages: [...page.data], // data is already chronological ascending.
    nextCursor: page.nextCursor,
  };
}

/** Insert a server-confirmed message, de-duplicated by id, kept in order. */
export function upsertMessage(state: MessagesState, message: ChatMessage): MessagesState {
  if (state.messages.some((m) => m.id === message.id)) {
    return state;
  }
  const messages = [...state.messages, message].sort(compare);
  return { messages, nextCursor: state.nextCursor };
}

/**
 * Prepend an older history page (from `before` pagination). Newer realtime
 * additions may have arrived since the cursor was read, so ids are merged and
 * deduplicated before sorting.
 */
export function mergeOlderPage(state: MessagesState, older: MessagesPage): MessagesState {
  const byId = new Map<string, ChatMessage>();
  for (const message of state.messages) byId.set(message.id, message);
  for (const message of older.data) byId.set(message.id, message);
  return { messages: [...byId.values()].sort(compare), nextCursor: older.nextCursor };
}

// ------------------------------------------------------ send / error mapping

export interface SendInput {
  websiteId: string;
  conversationId: string;
  content: string;
}

export interface SendPayload {
  conversationId: string;
  content: string;
  clientMessageId: string;
}

/**
 * The transport layer behind one logical message send.
 *
 * - `socket` is preferred: it either resolves a server-confirmed result, a
 *   refused send (ok:false ack → `{ failure }`), or `null` when no ack ever
 *   arrived. Only `null` triggers the REST fallback — with the same
 *   `clientMessageId`, so the backend's idempotency collapses the duplicate.
 * - `rest` throws (its callers get friendly messages) with the identical
 *   `MessageSendResult` contract on success.
 */
export type SocketSendResult =
  { status: 'ok'; message: MessageSendResult } | { status: 'refused'; failure: SendFailure };

export interface SocketTransport {
  canSend(): boolean;
  send(payload: SendPayload): Promise<SocketSendResult | null>;
}

export interface RestTransport {
  send(payload: SendPayload): Promise<MessageSendResult>;
}

export type SendFailureKind =
  | 'VALIDATION'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'CONVERSATION_CLOSED'
  | 'RATE_LIMITED'
  | 'NETWORK'
  | 'INTERNAL';

export interface SendFailure {
  code: SendFailureKind;
  message: string;
}

export interface SendOutcome {
  result: MessageSendResult | null;
  failure: SendFailure | null;
}

const friendly: Record<SendFailureKind, string> = {
  VALIDATION: 'The message was not accepted.',
  FORBIDDEN: "You don't have permission, or this website is deactivated.",
  NOT_FOUND: 'The conversation could not be found.',
  CONFLICT: 'A message with that idempotency key already exists.',
  CONVERSATION_CLOSED: 'This conversation is closed.',
  RATE_LIMITED: 'Too many messages — please slow down.',
  NETWORK: 'Cannot reach the server.',
  INTERNAL: 'Something went wrong on the server.',
};

function toKind(code: string): SendFailureKind {
  if (
    code === 'VALIDATION' ||
    code === 'FORBIDDEN' ||
    code === 'NOT_FOUND' ||
    code === 'CONFLICT' ||
    code === 'CONVERSATION_CLOSED' ||
    code === 'RATE_LIMITED'
  ) {
    return code;
  }
  return 'INTERNAL';
}

export function wsFailure(error: WsError): SendFailure {
  const code = toKind(error.code);
  const serverMessage = error.message?.trim();
  return {
    code,
    message: serverMessage && code === 'VALIDATION' ? serverMessage : friendly[code],
  };
}

export function httpFailure(error: { status: number; message?: string }): SendFailure {
  const code: SendFailureKind =
    error.status === 0
      ? 'NETWORK'
      : error.status === 400
        ? 'VALIDATION'
        : error.status === 403
          ? 'FORBIDDEN'
          : error.status === 404
            ? 'NOT_FOUND'
            : error.status === 409
              ? 'CONFLICT'
              : error.status === 429
                ? 'RATE_LIMITED'
                : 'INTERNAL';
  return { code, message: code === 'VALIDATION' && error.message ? error.message : friendly[code] };
}

/**
 * One logical send = one `clientMessageId`, reused across transport retries.
 * The socket is preferred; only when it cannot produce an ack (disconnected,
 * or the ack timed out after a network blip) does the REST endpoint retry the
 * exact same logical message with the same key — so the backend's idempotency
 * collapses any partial duplicate into the original row.
 */
export async function sendMessage(
  input: SendInput,
  transports: { socket: SocketTransport; rest: RestTransport },
): Promise<SendOutcome> {
  const clientMessageId = crypto.randomUUID();
  const payload = { conversationId: input.conversationId, content: input.content, clientMessageId };

  if (transports.socket.canSend()) {
    const outcome = await transports.socket.send(payload);
    if (outcome !== null) {
      // Either a confirmed send or a clean refusal from the server —
      // both are final, no retry.
      return outcome.status === 'ok'
        ? { result: outcome.message, failure: null }
        : { result: null, failure: outcome.failure };
    }
    // No ack (timeout): retry the same logical message over REST.
  }

  try {
    const result = await transports.rest.send(payload);
    return { result, failure: null };
  } catch (error) {
    return { result: null, failure: httpFailure(error as { status: number }) };
  }
}

// ------------------------------------------------------ inbox row preview

/** Apply a realtime event to an inbox row (list cache) without a refetch. */
export function applyInboxMessage(
  rows: StaffConversation[],
  message: ChatMessage,
): StaffConversation[] {
  return rows.map((row) =>
    row.id === message.conversationId
      ? { ...row, lastMessage: message, lastMessageAt: message.createdAt }
      : row,
  );
}

export function applyInboxClose(
  rows: StaffConversation[],
  conversationId: string,
  closedAt: string,
): StaffConversation[] {
  return rows.map((row) =>
    row.id === conversationId ? { ...row, status: 'CLOSED', closedAt } : row,
  );
}

/** Bound the composer text to the backend's enforced maximum. */
export const MAX_MESSAGE_LENGTH = 4000;
export const HISTORY_LIMIT = MESSAGE_LIMIT;
