import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import type { AiAgentStatus, Paginated, PublicWebsite } from '@chatflow/types';
import { Roles } from '../auth/decorators/roles.decorator';
import { CreateWebsiteDto } from './dto/create-website.dto';
import { ListWebsitesQueryDto } from './dto/list-websites-query.dto';
import { UpdateWebsiteDto } from './dto/update-website.dto';
import { UpdateWebsiteAiDto } from './dto/update-website-ai.dto';
import { WebsiteIdParamDto } from './dto/website-id-param.dto';
import { WebsitesService } from './websites.service';

/** Website management is ADMIN-only; AGENT accounts are rejected with 403. */
@Roles(Role.ADMIN)
@Controller('websites')
export class WebsitesController {
  constructor(private readonly websites: WebsitesService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateWebsiteDto): Promise<PublicWebsite> {
    return this.websites.create(dto);
  }

  @Get()
  list(@Query() query: ListWebsitesQueryDto): Promise<Paginated<PublicWebsite>> {
    return this.websites.list(query);
  }

  @Get(':id')
  getOne(@Param() params: WebsiteIdParamDto): Promise<PublicWebsite> {
    return this.websites.getById(params.id);
  }

  @Patch(':id')
  update(
    @Param() params: WebsiteIdParamDto,
    @Body() dto: UpdateWebsiteDto,
  ): Promise<PublicWebsite> {
    return this.websites.update(params.id, dto);
  }

  @Patch(':id/deactivate')
  deactivate(@Param() params: WebsiteIdParamDto): Promise<PublicWebsite> {
    return this.websites.setActive(params.id, false);
  }

  @Patch(':id/reactivate')
  reactivate(@Param() params: WebsiteIdParamDto): Promise<PublicWebsite> {
    return this.websites.setActive(params.id, true);
  }

  @Patch(':id/ai')
  updateAi(
    @Param() params: WebsiteIdParamDto,
    @Body() dto: UpdateWebsiteAiDto,
  ): Promise<PublicWebsite> {
    return this.websites.updateAiSettings(params.id, dto);
  }

  @Get(':id/ai')
  getAi(@Param() params: WebsiteIdParamDto): Promise<AiAgentStatus> {
    return this.websites.getAiAgentStatus(params.id);
  }
}
