import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import type { AiAgentStatus, AuthUser, Paginated, PublicWebsite } from '@chatflow/types';
import { AI_DEFAULT_FALLBACK_MESSAGE } from '../ai/ai.constants';
import { describeProvider } from '../ai/ai.provider';
import { generatePublicKey } from '../common/opaque-keys';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateWebsiteDto } from './dto/create-website.dto';
import type { ListWebsitesQueryDto } from './dto/list-websites-query.dto';
import type { UpdateWebsiteDto } from './dto/update-website.dto';
import type { UpdateWebsiteAiDto } from './dto/update-website-ai.dto';
import { toPublicWebsite } from './website.mapper';

@Injectable()
export class WebsitesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async create(dto: CreateWebsiteDto): Promise<PublicWebsite> {
    try {
      const website = await this.prisma.website.create({
        data: {
          name: dto.name.trim(),
          domain: normalizeDomain(dto.domain),
          // High-entropy public widget credential; the Prisma default (a
          // plain UUID) is never relied upon for production rows.
          publicKey: generatePublicKey(),
        },
      });
      return toPublicWebsite(website);
    } catch (error) {
      rethrowConflict(error, 'A website with this domain already exists');
      throw error;
    }
  }

  async list(query: ListWebsitesQueryDto): Promise<Paginated<PublicWebsite>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.WebsiteWhereInput = {};
    if (query.isActive !== undefined) {
      where.isActive = query.isActive;
    }

    const [total, websites] = await this.prisma.$transaction([
      this.prisma.website.count({ where }),
      this.prisma.website.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return { data: websites.map(toPublicWebsite), total, page, limit };
  }

  async getById(id: string): Promise<PublicWebsite> {
    const website = await this.prisma.website.findUnique({ where: { id } });
    if (!website) {
      throw new NotFoundException('Website not found');
    }
    return toPublicWebsite(website);
  }

  /**
   * The websites the current staff user may actually reach: every website
   * for an ADMIN, or only the websites where the AGENT holds an active
   * membership. This is the dashboard's site list; it is derived server-side
   * so the client never sees tenants it was not granted. Deactivated
   * websites are still listed (staff may read a deactivated tenant) — the
   * `isActive` flag lets the UI forbid writes without re-implementing authz.
   */
  async listAccessibleFor(user: AuthUser): Promise<PublicWebsite[]> {
    const where: Prisma.WebsiteWhereInput =
      user.role === Role.ADMIN
        ? {}
        : { memberships: { some: { userId: user.id, isActive: true } } };

    const websites = await this.prisma.website.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });

    return websites.map(toPublicWebsite);
  }

  async update(id: string, dto: UpdateWebsiteDto): Promise<PublicWebsite> {
    if (dto.name === undefined && dto.domain === undefined) {
      throw new BadRequestException('Provide at least one field to update');
    }

    const current = await this.prisma.website.findUnique({ where: { id } });
    if (!current) {
      throw new NotFoundException('Website not found');
    }

    try {
      const updated = await this.prisma.website.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
          ...(dto.domain !== undefined ? { domain: normalizeDomain(dto.domain) } : {}),
        },
      });
      return toPublicWebsite(updated);
    } catch (error) {
      rethrowConflict(error, 'A website with this domain already exists');
      throw error;
    }
  }

  async setActive(id: string, isActive: boolean): Promise<PublicWebsite> {
    const website = await this.prisma.website.findUnique({ where: { id } });
    if (!website) {
      throw new NotFoundException('Website not found');
    }

    if (website.isActive === isActive) {
      throw new ConflictException(
        isActive ? 'Website is already active' : 'Website is already deactivated',
      );
    }

    const updated = await this.prisma.website.update({ where: { id }, data: { isActive } });
    return toPublicWebsite(updated);
  }

  /**
   * Resolves a widget credential for the public API. Returns 404 for an
   * unknown key *and* for a deactivated website with an identical message, so
   * a prober cannot tell the two apart.
   */

  async updateAiSettings(id: string, dto: UpdateWebsiteAiDto): Promise<PublicWebsite> {
    if (dto.aiEnabled === undefined && dto.aiFallbackMessage === undefined) {
      throw new BadRequestException('Provide at least one field to update');
    }

    const website = await this.prisma.website.findUnique({ where: { id } });
    if (!website) {
      throw new NotFoundException('Website not found');
    }

    // Connecting the agent without an explicit escalation reply adopts a
    // sensible default so a visitor is never left without an answer on handoff.
    const enabling = dto.aiEnabled === true;
    let nextFallback = website.aiFallbackMessage;
    if (dto.aiFallbackMessage !== undefined) {
      nextFallback = dto.aiFallbackMessage?.trim() || null;
    } else if (enabling && !nextFallback) {
      nextFallback = AI_DEFAULT_FALLBACK_MESSAGE;
    }

    const updated = await this.prisma.website.update({
      where: { id },
      data: {
        ...(dto.aiEnabled !== undefined ? { aiEnabled: dto.aiEnabled } : {}),
        ...(nextFallback !== website.aiFallbackMessage ? { aiFallbackMessage: nextFallback } : {}),
      },
    });
    return toPublicWebsite(updated);
  }

  /**
   * The "Connect Agent" panel's status: the website's connection flags plus
   * which model backend the deployment is actually configured to use. The
   * provider keys themselves are never exposed — only the safe summary.
   */
  async getAiAgentStatus(id: string): Promise<AiAgentStatus> {
    const website = await this.prisma.website.findUnique({ where: { id } });
    if (!website) {
      throw new NotFoundException('Website not found');
    }
    return {
      aiEnabled: website.aiEnabled,
      aiFallbackMessage: website.aiFallbackMessage,
      ...describeProvider(this.config),
    };
  }

  async resolveActiveByKey(publicKey: string) {
    const website = await this.prisma.website.findUnique({ where: { publicKey } });
    if (!website || !website.isActive) {
      throw new NotFoundException('Website not found');
    }
    return website;
  }
}

function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase();
}

function rethrowConflict(error: unknown, message: string): void {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    throw new ConflictException(message);
  }
}
