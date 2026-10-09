import type { Role } from '@prisma/client';

/** Minimal, non-sensitive claims carried by the access token. */
export interface JwtPayload {
  sub: string;
  email: string;
  role: Role;
}
