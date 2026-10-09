import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import type { User } from '@prisma/client';
import type { AuthUser, PublicUser } from '@chatflow/types';
import { PrismaService } from '../prisma/prisma.service';
import { PasswordService } from '../security/password.service';
import type { ListUsersQueryDto } from './dto/list-users-query.dto';
import { toPublicUser } from './user.mapper';

export interface PaginatedUsers {
  data: PublicUser[];
  total: number;
  page: number;
  limit: number;
}

export interface CreateUserInput {
  email: string;
  password: string;
  name?: string;
  role: Role;
}

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly password: PasswordService,
  ) {}

  findById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { email } });
  }

  async createUser(input: CreateUserInput): Promise<User> {
    const passwordHash = await this.password.hash(input.password);

    try {
      return await this.prisma.user.create({
        data: {
          email: input.email,
          name: input.name ?? null,
          role: input.role,
          passwordHash,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('An account with this email already exists');
      }
      throw error;
    }
  }

  async list(query: ListUsersQueryDto): Promise<PaginatedUsers> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.UserWhereInput = {};
    if (query.role !== undefined) {
      where.role = query.role;
    }
    if (query.isActive !== undefined) {
      where.isActive = query.isActive;
    }

    const [total, users] = await this.prisma.$transaction([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return { data: users.map(toPublicUser), total, page, limit };
  }

  async getPublicUserById(id: string): Promise<PublicUser> {
    const user = await this.findById(id);
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return toPublicUser(user);
  }

  async setActive(targetId: string, isActive: boolean, actor: AuthUser): Promise<PublicUser> {
    if (targetId === actor.id) {
      throw new BadRequestException('You cannot change your own account status');
    }

    const target = await this.findById(targetId);
    if (!target) {
      throw new NotFoundException('User not found');
    }

    if (target.role === Role.ADMIN) {
      throw new ForbiddenException(
        'Administrator accounts cannot be modified through user management',
      );
    }

    if (target.isActive === isActive) {
      throw new ConflictException(
        isActive ? 'User is already active' : 'User is already deactivated',
      );
    }

    const updated = await this.prisma.user.update({
      where: { id: targetId },
      data: { isActive },
    });

    return toPublicUser(updated);
  }
}
