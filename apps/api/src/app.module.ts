import { join } from 'node:path';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { RolesGuard } from './auth/guards/roles.guard';
import { ConversationsModule } from './conversations/conversations.module';
import { validateEnv } from './config/env.validation';
import { HealthController } from './health/health.controller';
import { PrismaModule } from './prisma/prisma.module';
import { RealtimeModule } from './realtime/realtime.module';
import { WebSocketModule } from './realtime/websocket.module';
import { UsersModule } from './users/users.module';
import { VisitorsModule } from './visitors/visitors.module';
import { WebsitesModule } from './websites/websites.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      // Support both a workspace-local .env and the monorepo-root .env.
      envFilePath: [join(process.cwd(), '.env'), join(process.cwd(), '../../.env')],
      validate: validateEnv,
    }),
    PrismaModule,
    AuthModule,
    UsersModule,
    WebsitesModule,
    VisitorsModule,
    ConversationsModule,
    RealtimeModule,
    WebSocketModule,
  ],
  controllers: [HealthController],
  providers: [
    // Default-deny: authentication first, then coarse role checks. Website
    // membership (tenant) checks are layered per-route by WebsiteAccessGuard.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
