import { IsUUID } from 'class-validator';

export class AssignConversationDto {
  @IsUUID('all', { message: 'userId must be a valid UUID' })
  userId!: string;
}
