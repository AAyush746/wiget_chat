import type { Visitor } from '@prisma/client';
import type { AuthUser } from '@chatflow/types';

/**
 * Who is behind a socket, established once at the handshake and then trusted
 * for the connection's lifetime. Visitor principal keeps the resolved
 * `Visitor` row (never a client-supplied id) and the `publicKey` used to
 * resolve it so revocation (deactivated website) can be re-checked on join.
 */
export type WsPrincipal =
  { kind: 'staff'; user: AuthUser } | { kind: 'visitor'; visitor: Visitor; publicKey: string };

/** Per-socket state carried by Socket.IO (`socket.data`). */
export interface WsSocketData {
  principal?: WsPrincipal;
}
