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
import type { PublicVisitor } from '@chatflow/types';
import { Public } from '../auth/decorators/public.decorator';
import { PublicWebsiteParamDto } from '../common/dto/public-website-param.dto';
import { VisitorIdentityParamDto } from '../common/dto/visitor-identity-param.dto';
import { RateLimit } from '../security/rate-limit.decorator';
import { RateLimitGuard } from '../security/rate-limit.guard';
import { InitVisitorDto } from './dto/init-visitor.dto';
import { UpdateVisitorDto } from './dto/update-visitor.dto';
import { VisitorsService } from './visitors.service';

/**
 * Public widget endpoints. `@Public()` only skips *staff* authentication —
 * every route still validates key formats through DTOs, resolves an active
 * website, scopes lookups per tenant and is rate limited.
 */
@Public()
@UseGuards(RateLimitGuard)
@RateLimit('public:read')
@Controller('public/websites/:publicKey')
export class VisitorsController {
  constructor(private readonly visitors: VisitorsService) {}

  @Post('visitor')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit('public:visitor-init')
  init(
    @Param() params: PublicWebsiteParamDto,
    @Body() dto: InitVisitorDto,
  ): Promise<PublicVisitor> {
    return this.visitors.init(params.publicKey, dto);
  }

  @Get('visitor/:visitorKey')
  getState(@Param() params: VisitorIdentityParamDto): Promise<PublicVisitor> {
    return this.visitors.getState(params.publicKey, params.visitorKey);
  }

  @Patch('visitor/:visitorKey')
  update(
    @Param() params: VisitorIdentityParamDto,
    @Body() dto: UpdateVisitorDto,
  ): Promise<PublicVisitor> {
    return this.visitors.updateInfo(params.publicKey, params.visitorKey, dto);
  }
}
