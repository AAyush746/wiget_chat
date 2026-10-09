import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { WebsiteAccessGuard } from '../auth/guards/website-access.guard';
import { AccessibleWebsitesController } from './accessible-websites.controller';
import { MembershipsController } from './memberships.controller';
import { MembershipsService } from './memberships.service';
import { WebsiteAccessService } from './website-access.service';
import { WebsitesController } from './websites.controller';
import { WebsitesService } from './websites.service';

@Module({
  imports: [PrismaModule],
  controllers: [WebsitesController, MembershipsController, AccessibleWebsitesController],
  providers: [WebsitesService, MembershipsService, WebsiteAccessService, WebsiteAccessGuard],
  exports: [WebsitesService, WebsiteAccessService],
})
export class WebsitesModule {}
