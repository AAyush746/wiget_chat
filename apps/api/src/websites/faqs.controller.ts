import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import type { FaqEntry } from '@chatflow/types';
import { Roles } from '../auth/decorators/roles.decorator';
import { WebsiteAccessGuard } from '../auth/guards/website-access.guard';
import { WebsiteAccess } from '../auth/decorators/website-access.decorator';
import { WebsiteIdParamDto } from './dto/website-id-param.dto';
import { CreateFaqDto } from './dto/create-faq.dto';
import { UpdateFaqDto } from './dto/update-faq.dto';
import { FaqsService } from './faqs.service';

@Roles(Role.ADMIN, Role.AGENT)
@WebsiteAccess('id')
@UseGuards(WebsiteAccessGuard)
@Controller('websites/:id/faqs')
export class FaqsController {
  constructor(private readonly faqs: FaqsService) {}

  @Get()
  list(@Param() params: WebsiteIdParamDto): Promise<FaqEntry[]> {
    return this.faqs.list(params.id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Param() params: WebsiteIdParamDto, @Body() dto: CreateFaqDto): Promise<FaqEntry> {
    return this.faqs.create(params.id, dto);
  }

  @Patch(':faqId')
  update(
    @Param() params: WebsiteIdParamDto,
    @Param('faqId') faqId: string,
    @Body() dto: UpdateFaqDto,
  ): Promise<FaqEntry> {
    return this.faqs.update(params.id, faqId, dto);
  }

  @Delete(':faqId')
  @HttpCode(HttpStatus.NO_CONTENT)
  delete(@Param() params: WebsiteIdParamDto, @Param('faqId') faqId: string): Promise<void> {
    return this.faqs.delete(params.id, faqId);
  }
}
