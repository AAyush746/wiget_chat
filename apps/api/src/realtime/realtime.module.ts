import { Module } from '@nestjs/common';
import { RealtimeService } from './realtime.service';

/**
 * Realtime event bus only — no gateway, no WebSocket dependencies, no
 * imports of feature modules. Feature modules (conversations, future
 * assignment/analytics flows) import this to publish committed changes;
 * `WebSocketModule` imports it to consume them.
 */
@Module({
  providers: [RealtimeService],
  exports: [RealtimeService],
})
export class RealtimeModule {}
