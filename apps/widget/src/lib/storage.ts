import type { PublicVisitor } from '@chatflow/types';

const VISITOR_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const visitorKey = (publicKey: string) => `chatflow:visitor:${publicKey}`;
const conversationKey = (publicKey: string) => `chatflow:conversation:${publicKey}`;

/**
 * The only identity material a visitor ever persists: the opaque `visitorKey`
 * issued by the server (plus the last active conversation id, as UI state).
 * This is deliberately scoped per website so two customer sites never share a
 * visitor, and no staff JWT or any other credential is stored here.
 *
 * localStorage is *not* the source of truth: on every boot the stored key is
 * re-validated against the API and discards if the server rejects it.
 */

export function loadStoredVisitor(publicKey: string): PublicVisitor | null {
  try {
    const raw = window.localStorage.getItem(visitorKey(publicKey));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PublicVisitor;
    if (!isValidStoredVisitor(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveStoredVisitor(publicKey: string, visitor: PublicVisitor): void {
  try {
    window.localStorage.setItem(visitorKey(publicKey), JSON.stringify(visitor));
  } catch {
    // Storage unavailable (private mode / quota): the session still works.
  }
}

export function clearStoredVisitor(publicKey: string): void {
  try {
    window.localStorage.removeItem(visitorKey(publicKey));
  } catch {
    // ignore
  }
}

export function loadStoredConversationId(publicKey: string): string | null {
  try {
    const raw = window.localStorage.getItem(conversationKey(publicKey));
    return raw && UUID_PATTERN.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function saveStoredConversationId(publicKey: string, conversationId: string): void {
  try {
    window.localStorage.setItem(conversationKey(publicKey), conversationId);
  } catch {
    // ignore
  }
}

export function clearStoredConversation(publicKey: string): void {
  try {
    window.localStorage.removeItem(conversationKey(publicKey));
  } catch {
    // ignore
  }
}

function isValidStoredVisitor(visitor: PublicVisitor): boolean {
  return (
    typeof visitor.visitorKey === 'string' &&
    VISITOR_KEY_PATTERN.test(visitor.visitorKey) &&
    typeof visitor.createdAt === 'string' &&
    typeof visitor.lastSeenAt === 'string'
  );
}
