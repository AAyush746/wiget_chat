import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Role, type Website } from '@prisma/client';
import type { WebsiteMember } from '@chatflow/types';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateMembershipDto } from './dto/create-membership.dto';
import type { UpdateMembershipDto } from './dto/update-membership.dto';
import { toWebsiteMember } from './website.mapper';

/**
 * ADMIN-only management of agent -> website memberships. Membership changes
 * only affect *future* access: no conversation, message or visitor data is
 * ever modified or deleted here.
 */
@Injectable()
export class MembershipsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(website: Website, dto: CreateMembershipDto): Promise<WebsiteMember> {
    const user = await this.prisma.user.findUnique({ where: { id: dto.userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (user.role !== Role.AGENT) {
      throw new BadRequestException('Memberships can only be granted to AGENT accounts');
    }

    try {
      const membership = await this.prisma.websiteMembership.create({
        data: {
          websiteId: website.id,
          userId: user.id,
          isActive: dto.isActive ?? true,
        },
        include: { user: true },
      });
      return toWebsiteMember(membership);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('This user is already a member of this website');
      }
      throw error;
    }
  }

  async list(website: Website): Promise<WebsiteMember[]> {
    const memberships = await this.prisma.websiteMembership.findMany({
      where: { websiteId: website.id },
      include: { user: true },
      orderBy: { createdAt: 'desc' },
    });
    return memberships.map(toWebsiteMember);
  }

  async setActive(
    website: Website,
    membershipId: string,
    dto: UpdateMembershipDto,
  ): Promise<WebsiteMember> {
    const membership = await this.prisma.websiteMembership.findUnique({
      where: { id: membershipId },
      include: { user: true },
    });

    // A membership id from another tenant is reported as missing, never as
    // forbidden: membership ids are not guessable, and 404 keeps the response
    // identical to "does not exist".
    if (!membership || membership.websiteId !== website.id) {
      throw new NotFoundException('Membership not found');
    }

    if (membership.isActive === dto.isActive) {
      throw new ConflictException(
        dto.isActive ? 'Membership is already active' : 'Membership is already deactivated',
      );
    }

    const updated = await this.prisma.websiteMembership.update({
      where: { id: membershipId },
      data: { isActive: dto.isActive },
      include: { user: true },
    });

    return toWebsiteMember(updated);
  }
}
