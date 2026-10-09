import { Matches } from 'class-validator';
import { OPAQUE_KEY_PATTERN } from '../opaque-keys';

/**
 * Route parameters identifying "visitor X on website Y". Both credentials are
 * validated for format here; existence and tenant binding are resolved
 * together server-side (composite lookup), never trusted from the client.
 */
export class VisitorIdentityParamDto {
  @Matches(OPAQUE_KEY_PATTERN, { message: 'publicKey must be a valid website key' })
  publicKey!: string;

  @Matches(OPAQUE_KEY_PATTERN, { message: 'visitorKey must be a valid visitor key' })
  visitorKey!: string;
}
