import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { SecurityModule } from '../security/security.module';
import { UsersModule } from '../users/users.module';
import { VisitorsModule } from '../visitors/visitors.module';
import { WebsitesModule } from '../websites/websites.module';
import { ChatGateway } from './chat.gateway';
import { RealtimeModule } from './realtime.module';
import { WsAuthService } from './ws-auth.service';

/**
 * Socket.IO transport. Imports the feature modules (never the reverse) so
 * `ConversationsModule` only depends on the leaf `RealtimeModule` — no
 * circular DI, and the HTTP layer keeps working with this module removed.
 */
@Module({
  imports: [
    RealtimeModule,
    ConversationsModule,
    AuthModule,
    UsersModule,
    VisitorsModule,
    WebsitesModule,
    SecurityModule,
  ],
  providers: [ChatGateway, WsAuthService],
})
export class WebSocketModule {}
