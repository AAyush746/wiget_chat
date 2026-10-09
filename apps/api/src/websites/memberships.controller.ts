import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import type { Website } from '@prisma/client';
import type { WebsiteMember } from '@chatflow/types';
import { CurrentWebsite } from '../auth/decorators/current-website.decorator';
import { WebsiteAccess } from '../auth/decorators/website-access.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { WebsiteAccessGuard } from '../auth/guards/website-access.guard';
import { CreateMembershipDto } from './dto/create-membership.dto';
import { MembershipParamDto } from './dto/membership-param.dto';
import { UpdateMembershipDto } from './dto/update-membership.dto';
import { MembershipsService } from './memberships.service';

/**
 * ADMIN-only membership management. The website is resolved and authorized by
 * WebsiteAccessGuard, so every handler operates on a tenant that was verified
 * before it ran.
 */
@Roles(Role.ADMIN)
@UseGuards(WebsiteAccessGuard)
@WebsiteAccess('id')
@Controller('websites/:id/memberships')
export class MembershipsController {
  constructor(private readonly memberships: MembershipsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @CurrentWebsite() website: Website,
    @Body() dto: CreateMembershipDto,
  ): Promise<WebsiteMember> {
    return this.memberships.create(website, dto);
  }

  @Get()
  list(@CurrentWebsite() website: Website): Promise<WebsiteMember[]> {
    return this.memberships.list(website);
  }

  @Patch(':membershipId')
  update(
    @CurrentWebsite() website: Website,
    @Param() params: MembershipParamDto,
    @Body() dto: UpdateMembershipDto,
  ): Promise<WebsiteMember> {
    return this.memberships.setActive(website, params.membershipId, dto);
  }
}
