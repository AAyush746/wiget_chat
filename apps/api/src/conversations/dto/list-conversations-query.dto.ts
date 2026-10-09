import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { ConversationStatus } from '@prisma/client';

export class ListConversationsQueryDto {
  @IsOptional()
  @IsEnum(ConversationStatus, {
    message: 'status must be one of OPEN, PENDING, CLOSED',
  })
  status?: ConversationStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'page must be an integer' })
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limit must be an integer' })
  @Min(1)
  @Max(100)
  limit?: number;
}
