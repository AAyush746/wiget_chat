import { IsUUID } from 'class-validator';

export class StaffConversationParamDto {
  @IsUUID('all', { message: 'websiteId must be a valid UUID' })
  websiteId!: string;

  @IsUUID('all', { message: 'conversationId must be a valid UUID' })
  conversationId!: string;
}
