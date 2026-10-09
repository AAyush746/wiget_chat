import { IsUUID } from 'class-validator';

/** WebSocket payload identifying one conversation (join/leave). */
export class WsConversationRefDto {
  @IsUUID('all', { message: 'conversationId must be a valid UUID' })
  conversationId!: string;
}
