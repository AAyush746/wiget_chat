import { SetMetadata } from '@nestjs/common';

export const RATE_LIMIT_BUCKET_KEY = 'rateLimitBucket';

/**
 * Names a rate-limit policy (see RateLimitGuard) for a route. May be applied
 * at class level for a default and overridden per handler.
 */
export const RateLimit = (bucket: string): MethodDecorator & ClassDecorator =>
  SetMetadata(RATE_LIMIT_BUCKET_KEY, bucket);
