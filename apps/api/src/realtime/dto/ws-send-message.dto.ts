import { IsUUID } from 'class-validator';
import { CreateMessageDto } from '../../conversations/dto/create-message.dto';

/**
 * WebSocket `message:send` payload: the thread target plus the message body.
 * `conversationId` is validated as a UUID here and then fully authorized by
 * the service (ownership/tenant/status) — it is never trusted on its own.
 */
export class WsSendMessageDto extends CreateMessageDto {
  @IsUUID('all', { message: 'conversationId must be a valid UUID' })
  conversationId!: string;
}
