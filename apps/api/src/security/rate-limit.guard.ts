import {
  HttpException,
  HttpStatus,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { RATE_LIMIT_BUCKET_KEY } from './rate-limit.decorator';
import { RateLimitService } from './rate-limit.service';

interface RateLimitPolicy {
  max: number;
  windowMs: number;
}

/**
 * Applies a named rate-limit policy to a route.
 *
 * The counter key is `${bucket}:${ip}:${publicKey}`, so limits are per client,
 * per tenant and per action (a burst of widget traffic on one website cannot
 * starve another). Buckets and their limits are configured through
 * PUBLIC_RATE_LIMIT_* environment variables; see .env.example.
 *
 * State is in-memory: single-instance only (see RateLimitService).
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly policies: Record<string, RateLimitPolicy>;

  constructor(
    private readonly reflector: Reflector,
    private readonly rateLimit: RateLimitService,
    config: ConfigService,
  ) {
    const windowMs = config.get<number>('PUBLIC_RATE_LIMIT_WINDOW_MS') ?? 60_000;
    this.policies = {
      'public:read': { max: config.get<number>('PUBLIC_RATE_LIMIT_READ_MAX') ?? 300, windowMs },
      'public:visitor-init': {
        max: config.get<number>('PUBLIC_RATE_LIMIT_INIT_MAX') ?? 20,
        windowMs,
      },
      'public:conversation-create': {
        max: config.get<number>('PUBLIC_RATE_LIMIT_CREATE_MAX') ?? 30,
        windowMs,
      },
      'public:message-send': {
        max: config.get<number>('PUBLIC_RATE_LIMIT_MESSAGE_MAX') ?? 60,
        windowMs,
      },
    };
  }

  canActivate(context: ExecutionContext): boolean {
    const bucket = this.reflector.getAllAndOverride<string | undefined>(RATE_LIMIT_BUCKET_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!bucket) {
      return true;
    }

    const policy = this.policies[bucket];
    if (!policy) {
      // Programming error: an unknown bucket name must never silently allow
      // unlimited traffic.
      throw new HttpException('Unknown rate limit policy', HttpStatus.INTERNAL_SERVER_ERROR);
    }

    const request = context.switchToHttp().getRequest<{
      ip?: string;
      params?: Record<string, string | undefined>;
    }>();

    const key = `${bucket}:${request.ip ?? 'unknown'}:${request.params?.publicKey ?? '-'}`;
    const decision = this.rateLimit.hit(key, policy.max, policy.windowMs);

    if (!decision.allowed) {
      throw new HttpException(
        'Too many requests. Please try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }
}
