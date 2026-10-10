import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AiService } from './ai.service';
import { AiWorker } from './ai.worker';
import { PrismaModule } from '../prisma/prisma.module';
import { FaqsService } from '../websites/faqs.service';
import { ConversationsModule } from '../conversations/conversations.module';
import { WebsitesModule } from '../websites/websites.module';
import { VisitorsModule } from '../visitors/visitors.module';
import { RealtimeModule } from '../realtime/realtime.module';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    ConversationsModule,
    WebsitesModule,
    VisitorsModule,
    RealtimeModule,
  ],
  providers: [AiService, AiWorker, FaqsService],
  exports: [AiService],
})
export class AiModule {}
