import type { User } from '@prisma/client';
import type { AuthUser, PublicUser } from '@chatflow/types';

/** Maps a persisted user to the request principal. Never exposes secrets. */
export function toAuthUser(user: User): AuthUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
  };
}

/** Maps a persisted user to the safe, client-facing representation. */
export function toPublicUser(user: User): PublicUser {
  return {
    ...toAuthUser(user),
    isActive: user.isActive,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}
