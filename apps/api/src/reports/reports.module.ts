import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { WebsitesModule } from '../websites/websites.module';
import { WebsiteAccessGuard } from '../auth/guards/website-access.guard';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { ReportExportService } from './report-export.service';

/**
 * Reporting is self-contained: apart from the shared tenant-guard it reads the
 * Prisma client directly and depends on no inbox or assignment service, so a
 * slow report can never contend for their in-memory state or change their
 * behaviour.
 */
@Module({
  // WebsitesModule supplies WebsiteAccessService, so reports authorize a
  // tenant through exactly the same code path as the inbox and FAQ routes.
  imports: [PrismaModule, WebsitesModule],
  controllers: [ReportsController],
  providers: [ReportsService, ReportExportService, WebsiteAccessGuard],
})
export class ReportsModule {}
