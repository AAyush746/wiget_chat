import { BadRequestException } from '@nestjs/common';

/**
 * Opaque pagination cursor for message history: `base64url(ISO-8601|uuid)`.
 *
 * Message timestamps are `timestamptz(3)` (millisecond precision), which
 * round-trips exactly through `Date.toISOString()`, so the encoded boundary
 * used by `WHERE (created_at, id) < (…)` is lossless — the cursor page can
 * never skip or repeat a row. The `id` half breaks ties for messages that
 * share a millisecond, which is what makes the order deterministic.
 */
const CURSOR_FORMAT = /^[A-Za-z0-9_-]{8,200}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface MessageCursor {
  createdAt: Date;
  id: string;
}

export function encodeMessageCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

/** Decodes a client-supplied cursor, rejecting anything malformed (400). */
export function decodeMessageCursor(raw: string): MessageCursor {
  if (!CURSOR_FORMAT.test(raw)) {
    throw new BadRequestException('before must be a valid message cursor');
  }

  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  const separator = decoded.indexOf('|');
  const iso = separator === -1 ? '' : decoded.slice(0, separator);
  const id = separator === -1 ? '' : decoded.slice(separator + 1);
  const timestamp = Date.parse(iso);

  if (!Number.isFinite(timestamp) || !UUID_PATTERN.test(id)) {
    throw new BadRequestException('before must be a valid message cursor');
  }

  return { createdAt: new Date(timestamp), id };
}
