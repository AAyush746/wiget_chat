import type { ChatMessage, MessageSendResult, WsError } from '@chatflow/types';

/**
 * Widget message model.
 *
 * - `ChatMessage[]` holds server-confirmed messages, identified by server `id`
 *   and de-duplicated by it (an ack, a realtime event and a history refetch of
 *   the same message can never render twice).
 * - `PendingMessage[]` are optimistic rows awaiting server confirmation. Each
 *   logical send owns one `clientMessageId` that is reused across transport
 *   retries; a pending row is *only* removed when the server confirms it or the
 *   user retries after an explicit failure — never fabricated as sent.
 */

export const MAX_MESSAGE_LENGTH = 4000;
export const HISTORY_LIMIT = 50;

export type PendingStatus = 'sending' | 'error';

export interface PendingMessage {
  clientMessageId: string;
  conversationId: string;
  content: string;
  status: PendingStatus;
  error: string | null;
  createdAt: string;
}

export type ThreadEntry =
  { kind: 'pending'; pending: PendingMessage } | { kind: 'server'; message: ChatMessage };

// ------------------------------------------------------------ reconciliation

const compare = (a: ChatMessage, b: ChatMessage): number => {
  const byTime = a.createdAt.localeCompare(b.createdAt);
  return byTime !== 0 ? byTime : a.id.localeCompare(b.id);
};

export function upsertMessage(messages: ChatMessage[], message: ChatMessage): ChatMessage[] {
  if (messages.some((m) => m.id === message.id)) {
    return messages;
  }
  return [...messages, message].sort(compare);
}

export function mergeHistory(messages: ChatMessage[], page: ChatMessage[]): ChatMessage[] {
  const byId = new Map<string, ChatMessage>();
  for (const message of messages) byId.set(message.id, message);
  for (const message of page) byId.set(message.id, message);
  return [...byId.values()].sort(compare);
}

export function createPending(content: string, conversationId: string): PendingMessage {
  return {
    clientMessageId: crypto.randomUUID(),
    conversationId,
    content,
    status: 'sending',
    error: null,
    createdAt: new Date().toISOString(),
  };
}

export function addPending(pending: PendingMessage[], message: PendingMessage): PendingMessage[] {
  if (pending.some((p) => p.clientMessageId === message.clientMessageId)) {
    return pending;
  }
  return [...pending, message];
}

export function markPendingError(
  pending: PendingMessage[],
  clientMessageId: string,
  error: string,
): PendingMessage[] {
  return pending.map((p) =>
    p.clientMessageId === clientMessageId ? { ...p, status: 'error' as const, error } : p,
  );
}

export function clearPending(pending: PendingMessage[], clientMessageId: string): PendingMessage[] {
  return pending.filter((p) => p.clientMessageId !== clientMessageId);
}

/** Merge server-confirmed + optimistic rows into one rendered thread. */
export function mergeThread(messages: ChatMessage[], pending: PendingMessage[]): ThreadEntry[] {
  const server: ThreadEntry[] = messages.map((message) => ({ kind: 'server', message }));
  const optimistic: ThreadEntry[] = pending.map((p) => ({ kind: 'pending', pending: p }));
  return [...server, ...optimistic].sort((a, b) => {
    const ta = a.kind === 'pending' ? a.pending.createdAt : a.message.createdAt;
    const tb = b.kind === 'pending' ? b.pending.createdAt : b.message.createdAt;
    return ta.localeCompare(tb);
  });
}

// -------------------------------------------------------- send / error mapping

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

export interface SendPayload {
  conversationId: string;
  content: string;
  clientMessageId: string;
}

export type SocketSendResult =
  { status: 'ok'; message: MessageSendResult } | { status: 'refused'; failure: SendFailure };

export interface SocketTransport {
  canSend(): boolean;
  send(payload: SendPayload): Promise<SocketSendResult | null>;
}

export interface RestTransport {
  send(payload: SendPayload): Promise<MessageSendResult>;
}

export interface SendOutcome {
  result: MessageSendResult | null;
  failure: SendFailure | null;
}

const friendly: Record<SendFailureKind, string> = {
  VALIDATION: 'The message was not accepted.',
  FORBIDDEN: 'This conversation is not available any more.',
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
 * The socket is preferred; only when it cannot deliver an ack (disconnected or
 * timed out) does REST retry the identical key so the backend collapses any
 * duplicate. A clean refusal (ok:false) is final — no retry.
 */
export async function sendMessage(
  input: { conversationId: string; content: string; clientMessageId: string },
  transports: { socket: SocketTransport; rest: RestTransport },
): Promise<SendOutcome> {
  const payload: SendPayload = {
    conversationId: input.conversationId,
    content: input.content,
    clientMessageId: input.clientMessageId,
  };

  if (transports.socket.canSend()) {
    const outcome = await transports.socket.send(payload);
    if (outcome !== null) {
      return outcome.status === 'ok'
        ? { result: outcome.message, failure: null }
        : { result: null, failure: outcome.failure };
    }
  }

  try {
    const result = await transports.rest.send(payload);
    return { result, failure: null };
  } catch (error) {
    return { result: null, failure: httpFailure(error as { status: number }) };
  }
}
