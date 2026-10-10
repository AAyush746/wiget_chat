import { Module } from '@nestjs/common';
import { WebsiteAccessGuard } from '../auth/guards/website-access.guard';
import { PrismaModule } from '../prisma/prisma.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { RateLimitGuard } from '../security/rate-limit.guard';
import { SecurityModule } from '../security/security.module';
import { VisitorsModule } from '../visitors/visitors.module';
import { WebsitesModule } from '../websites/websites.module';
import { AssignableAgentsController, AssignmentsController } from './assignments.controller';
import { AssignmentsService } from './assignments.service';
import { ConversationsController } from './conversations.controller';
import { ConversationsService } from './conversations.service';
import { MessagesService } from './messages.service';
import { PublicConversationsController } from './public-conversations.controller';

@Module({
  imports: [PrismaModule, SecurityModule, VisitorsModule, WebsitesModule, RealtimeModule],
  controllers: [
    PublicConversationsController,
    ConversationsController,
    AssignmentsController,
    AssignableAgentsController,
  ],
  providers: [
    ConversationsService,
    MessagesService,
    AssignmentsService,
    RateLimitGuard,
    WebsiteAccessGuard,
  ],
  // Exported for the WebSocket gateway, which reuses the exact same
  // authorization + persistence path as the REST controllers.
  exports: [ConversationsService, MessagesService],
})
export class ConversationsModule {}
