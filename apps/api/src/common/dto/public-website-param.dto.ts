import { Matches } from 'class-validator';
import { OPAQUE_KEY_PATTERN } from '../opaque-keys';

/**
 * Route parameter carrying a website's public widget credential. The pattern
 * rejects malformed keys before any database lookup happens.
 */
export class PublicWebsiteParamDto {
  @Matches(OPAQUE_KEY_PATTERN, { message: 'publicKey must be a valid website key' })
  publicKey!: string;
}
