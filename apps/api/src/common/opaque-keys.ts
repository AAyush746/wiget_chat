import { randomBytes } from 'node:crypto';

/**
 * Format for opaque, URL-safe credentials (website `publicKey`, visitor
 * `visitorKey`). Both are generated as base64url of random bytes; the pattern
 * also accepts legacy UUID-shaped values so a key can never be rejected just
 * because of its encoding. The 16-character minimum rejects short, guessable
 * strings before they ever reach the database.
 */
export const OPAQUE_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

/** 32 random bytes (256 bits of entropy) for the public website credential. */
export function generatePublicKey(): string {
  return randomBytes(32).toString('base64url');
}

/** 24 random bytes (192 bits of entropy) for an anonymous visitor identity. */
export function generateVisitorKey(): string {
  return randomBytes(24).toString('base64url');
}
