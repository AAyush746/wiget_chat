import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { WebsiteRequest } from '../interfaces/website-request.interface';

/**
 * Injects the website already authorized by WebsiteAccessGuard. Never reads
 * the raw route parameter: controllers must use the guarded object so a
 * resource is always resolved against the tenant that was actually checked.
 */
export const CurrentWebsite = createParamDecorator(
  (_data: unknown, context: ExecutionContext): WebsiteRequest['website'] =>
    context.switchToHttp().getRequest<WebsiteRequest>().website,
);
