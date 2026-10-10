import type { Website, WebsiteMembership, User } from '@prisma/client';
import type { PublicWebsite, WebsiteMember } from '@chatflow/types';
import { toPublicUser } from '../users/user.mapper';

/** Maps a persisted website to its staff-facing representation. */
export function toPublicWebsite(website: Website): PublicWebsite {
  return {
    id: website.id,
    name: website.name,
    domain: website.domain,
    publicKey: website.publicKey,
    isActive: website.isActive,
    aiEnabled: website.aiEnabled,
    aiFallbackMessage: website.aiFallbackMessage,
    createdAt: website.createdAt.toISOString(),
    updatedAt: website.updatedAt.toISOString(),
  };
}

/** Maps a membership (with its user preloaded) to the staff-facing view. */
export function toWebsiteMember(membership: WebsiteMembership & { user: User }): WebsiteMember {
  return {
    id: membership.id,
    userId: membership.userId,
    websiteId: membership.websiteId,
    isActive: membership.isActive,
    createdAt: membership.createdAt.toISOString(),
    updatedAt: membership.updatedAt.toISOString(),
    user: toPublicUser(membership.user),
  };
}
