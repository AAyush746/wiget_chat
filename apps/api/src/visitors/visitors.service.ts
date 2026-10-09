import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Visitor } from '@prisma/client';
import type { PublicVisitor } from '@chatflow/types';
import { generateVisitorKey } from '../common/opaque-keys';
import { normalizeEmail } from '../common/normalize-email';
import { PrismaService } from '../prisma/prisma.service';
import type { InitVisitorDto } from './dto/init-visitor.dto';
import type { UpdateVisitorDto } from './dto/update-visitor.dto';
import { toPublicVisitor } from './visitor.mapper';
import { WebsitesService } from '../websites/websites.service';

/**
 * Anonymous visitor identities for the public widget API.
 *
 * A visitor is authenticated purely by possession of its `visitorKey`, which
 * is generated server-side (192 random bits), carries no personal data and is
 * always resolved through a composite `(websiteId, visitorKey)` lookup — so a
 * key from website A never resolves on website B, and swapping keys always
 * yields 404.
 */
@Injectable()
export class VisitorsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly websites: WebsitesService,
  ) {}

  async init(publicKey: string, dto: InitVisitorDto): Promise<PublicVisitor> {
    const website = await this.websites.resolveActiveByKey(publicKey);

    const visitor = await this.prisma.visitor.create({
      data: {
        websiteId: website.id,
        visitorKey: generateVisitorKey(),
        name: normalizeName(dto.name),
        email: dto.email ? normalizeEmail(dto.email) : null,
      },
    });

    return toPublicVisitor(visitor);
  }

  async getState(publicKey: string, visitorKey: string): Promise<PublicVisitor> {
    const visitor = await this.resolveVisitor(publicKey, visitorKey);

    const updated = await this.prisma.visitor.update({
      where: { id: visitor.id },
      data: { lastSeenAt: new Date() },
    });

    return toPublicVisitor(updated);
  }

  async updateInfo(
    publicKey: string,
    visitorKey: string,
    dto: UpdateVisitorDto,
  ): Promise<PublicVisitor> {
    if (dto.name === undefined && dto.email === undefined) {
      throw new BadRequestException('Provide at least one field to update');
    }

    const visitor = await this.resolveVisitor(publicKey, visitorKey);

    const updated = await this.prisma.visitor.update({
      where: { id: visitor.id },
      data: {
        ...(dto.name !== undefined ? { name: normalizeName(dto.name) } : {}),
        ...(dto.email !== undefined ? { email: dto.email ? normalizeEmail(dto.email) : null } : {}),
      },
    });

    return toPublicVisitor(updated);
  }

  /**
   * Resolves website + visitor in one scoped lookup. The website must be
   * active (resolveActiveByKey) and the visitor must belong to *that*
   * website; a mismatch on either side is an indistinguishable 404.
   */
  async resolveVisitor(publicKey: string, visitorKey: string): Promise<Visitor> {
    const website = await this.websites.resolveActiveByKey(publicKey);

    const visitor = await this.prisma.visitor.findUnique({
      where: { websiteId_visitorKey: { websiteId: website.id, visitorKey } },
    });

    if (!visitor) {
      throw new NotFoundException('Visitor not found');
    }

    return visitor;
  }
}

function normalizeName(name: string | undefined): string | null {
  const trimmed = name?.trim();
  return trimmed ? trimmed : null;
}
