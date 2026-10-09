import type { Visitor } from '@prisma/client';
import type { PublicVisitor } from '@chatflow/types';

/**
 * Maps a visitor to the shape its own widget may see. The internal database id
 * is intentionally omitted: the widget only ever holds publicKey+visitorKey,
 * so leaking `id` would add attack surface for no benefit.
 */
export function toPublicVisitor(visitor: Visitor): PublicVisitor {
  return {
    visitorKey: visitor.visitorKey,
    name: visitor.name,
    email: visitor.email,
    createdAt: visitor.createdAt.toISOString(),
    lastSeenAt: visitor.lastSeenAt.toISOString(),
  };
}
