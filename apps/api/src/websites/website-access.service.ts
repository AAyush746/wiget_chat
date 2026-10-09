import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Role, type Website } from '@prisma/client';
import type { AuthUser } from '@chatflow/types';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The single place that answers: "may this staff user act on this website?".
 *
 * Authorization order (user -> permitted website -> requested resource):
 *  1. the caller is authenticated and active (JwtStrategy),
 *  2. the caller may reach the website (this service),
 *  3. the resource belongs to that website (services below).
 *
 * ADMIN accounts have platform-wide authority and therefore implicit access to
 * every website; AGENT accounts need an *active* membership for the specific
 * website. WebsiteAccessGuard calls this on every website-scoped staff route;
 * Phase 5+ services can call it directly for non-HTTP checks.
 */
@Injectable()
export class WebsiteAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async getAccessibleWebsite(user: AuthUser, websiteId: string): Promise<Website> {
    const website = await this.prisma.website.findUnique({ where: { id: websiteId } });
    if (!website) {
      // 404 before any role/membership reasoning so a probe cannot distinguish
      // "does not exist" from "exists but is not yours" by status code ordering.
      throw new NotFoundException('Website not found');
    }

    if (user.role === Role.ADMIN) {
      return website;
    }

    const membership = await this.prisma.websiteMembership.findUnique({
      where: { userId_websiteId: { userId: user.id, websiteId } },
    });

    if (!membership || !membership.isActive) {
      throw new ForbiddenException('You do not have access to this website');
    }

    return website;
  }
}
