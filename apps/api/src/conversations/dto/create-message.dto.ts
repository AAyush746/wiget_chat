import { IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';

/**
 * Hard cap on message content. Deliberately generous for a support chat but
 * small enough that a single frame cannot stress the database or the
 * realtime fan-out. Oversized input is rejected with 400 — content is never
 * silently truncated.
 */
export const MAX_MESSAGE_LENGTH = 4000;

/**
 * Body of a message send (REST and WebSocket alike). Only content and the
 * optional idempotency key are accepted: sender type and sender/tenant ids
 * are derived server-side from the authenticated principal, never from the
 * client, so `forbidNonWhitelisted` rejects any attempt to inject them.
 */
export class CreateMessageDto {
  @IsString({ message: 'content must be a string' })
  @MaxLength(MAX_MESSAGE_LENGTH, {
    message: `content must be at most ${MAX_MESSAGE_LENGTH} characters`,
  })
  @Matches(/\S/, { message: 'content must not be blank' })
  content!: string;

  @IsOptional()
  @IsUUID('all', { message: 'clientMessageId must be a valid UUID' })
  clientMessageId?: string;
}
