import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { RateLimitGuard } from '../security/rate-limit.guard';
import { SecurityModule } from '../security/security.module';
import { WebsitesModule } from '../websites/websites.module';
import { VisitorsController } from './visitors.controller';
import { VisitorsService } from './visitors.service';

@Module({
  imports: [PrismaModule, SecurityModule, WebsitesModule],
  controllers: [VisitorsController],
  providers: [VisitorsService, RateLimitGuard],
  exports: [VisitorsService],
})
export class VisitorsModule {}
