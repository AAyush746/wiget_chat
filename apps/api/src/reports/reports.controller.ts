import { Controller, Get, Header, Param, Query, Res, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import type { Response } from 'express';
import type {
  ReportAgentsPage,
  ReportConversations,
  ReportOverview,
  ReportSummary,
  ReportTimeseries,
} from '@chatflow/types';
import { Roles } from '../auth/decorators/roles.decorator';
import { WebsiteAccess } from '../auth/decorators/website-access.decorator';
import { WebsiteAccessGuard } from '../auth/guards/website-access.guard';
import { WebsiteIdParamDto } from '../websites/dto/website-id-param.dto';
import { ReportRangeQueryDto } from './dto/report-range-query.dto';
import { ReportsService } from './reports.service';
import { ReportExportService } from './report-export.service';

/**
 * Reporting surface. Read-only by construction: every route is a GET, so a
 * reporting bug can never mutate tenant data. Tenant scoping comes from the
 * same `@WebsiteAccess` guard the inbox and FAQ routes use, so an agent who is
 * not a member of a website sees a 404 for its reports exactly as they would
 * for its conversations.
 */
@Roles(Role.ADMIN, Role.AGENT)
@WebsiteAccess('id')
@UseGuards(WebsiteAccessGuard)
@Controller('websites/:id/reports')
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly exporter: ReportExportService,
  ) {}

  @Get('overview')
  overview(
    @Param() params: WebsiteIdParamDto,
    @Query() query: ReportRangeQueryDto,
  ): Promise<ReportOverview> {
    return this.reports.overview(params.id, query);
  }

  @Get('summary')
  summary(
    @Param() params: WebsiteIdParamDto,
    @Query() query: ReportRangeQueryDto,
  ): Promise<ReportSummary> {
    return this.reports.summary(params.id, query);
  }

  @Get('timeseries')
  timeseries(
    @Param() params: WebsiteIdParamDto,
    @Query() query: ReportRangeQueryDto,
  ): Promise<ReportTimeseries> {
    return this.reports.timeseries(params.id, query);
  }

  @Get('agents')
  async agents(
    @Param() params: WebsiteIdParamDto,
    @Query() query: ReportRangeQueryDto,
  ): Promise<ReportAgentsPage> {
    return {
      ...this.reports.window(query),
      data: await this.reports.agents(params.id, query),
    };
  }

  @Get('conversations')
  conversations(
    @Param() params: WebsiteIdParamDto,
    @Query() query: ReportRangeQueryDto,
  ): Promise<ReportConversations> {
    return this.reports.conversations(params.id, query);
  }

  @Get('export.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async exportCsv(
    @Param() params: WebsiteIdParamDto,
    @Query() query: ReportRangeQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    const csv = await this.exporter.csv(params.id, query);
    res.setHeader('Content-Disposition', `attachment; filename="${this.exporter.filename(query)}"`);
    // A BOM makes Excel open UTF-8 (and non-ASCII visitor names) correctly.
    res.send(`﻿${csv}`);
  }
}
