import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { OPAQUE_KEY_PATTERN } from '../../common/opaque-keys';

/**
 * Body of a public conversation-creation request. The visitor identity is
 * carried here (not as a bare client-chosen id) so the server can derive
 * websiteId/visitorId itself; `websiteId` is never accepted from the client.
 */
export class CreateConversationDto {
  @Matches(OPAQUE_KEY_PATTERN, { message: 'visitorKey must be a valid visitor key' })
  visitorKey!: string;

  @IsOptional()
  @IsString({ message: 'subject must be a string' })
  @MaxLength(200, { message: 'subject must be at most 200 characters' })
  subject?: string;
}
