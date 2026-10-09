import type { AuthUser } from '@chatflow/types';

/** The Express request shape after the JWT strategy has authenticated it. */
export interface AuthenticatedRequest {
  user: AuthUser;
  ip?: string;
}
