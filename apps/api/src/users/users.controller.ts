import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import type { AuthUser, PublicUser } from '@chatflow/types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { normalizeEmail } from '../common/normalize-email';
import { CreateUserDto } from './dto/create-user.dto';
import { ListUsersQueryDto } from './dto/list-users-query.dto';
import { UserIdParamDto } from './dto/user-id-param.dto';
import { toPublicUser } from './user.mapper';
import { UsersService, type PaginatedUsers } from './users.service';

/** All user-management endpoints are ADMIN-only. */
@Roles(Role.ADMIN)
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  list(@Query() query: ListUsersQueryDto): Promise<PaginatedUsers> {
    return this.users.list(query);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() dto: CreateUserDto): Promise<PublicUser> {
    const role = dto.role ?? Role.AGENT;
    if (role !== Role.AGENT) {
      throw new ForbiddenException('Only AGENT accounts can be created through this endpoint');
    }

    const user = await this.users.createUser({
      email: normalizeEmail(dto.email),
      password: dto.password,
      name: dto.name,
      role: Role.AGENT,
    });

    return toPublicUser(user);
  }

  @Get(':id')
  getOne(@Param() params: UserIdParamDto): Promise<PublicUser> {
    return this.users.getPublicUserById(params.id);
  }

  @Patch(':id/deactivate')
  deactivate(@Param() params: UserIdParamDto, @CurrentUser() actor: AuthUser): Promise<PublicUser> {
    return this.users.setActive(params.id, false, actor);
  }

  @Patch(':id/reactivate')
  reactivate(@Param() params: UserIdParamDto, @CurrentUser() actor: AuthUser): Promise<PublicUser> {
    return this.users.setActive(params.id, true, actor);
  }
}
