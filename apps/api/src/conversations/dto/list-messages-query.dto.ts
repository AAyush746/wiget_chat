import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';

/**
 * Cursor pagination for message history. No offset paging: `before` is the
 * opaque cursor returned as `nextCursor` by the previous page, which keeps
 * deep history reads O(limit) regardless of how many messages precede them.
 */
export class ListMessagesQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limit must be an integer' })
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{8,200}$/, {
    message: 'before must be a valid message cursor',
  })
  before?: string;
}
