import {
  BadRequestException,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Website } from '@prisma/client';
import type { AuthUser } from '@chatflow/types';
import { WEBSITE_ACCESS_PARAM_KEY } from '../decorators/website-access.decorator';
import { WebsiteAccessService } from '../../websites/website-access.service';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface WebsiteScopedRequest {
  params?: Record<string, string | undefined>;
  user?: AuthUser;
  website?: Website;
}

/**
 * Tenant guard for website-scoped staff routes. Runs *after* the global JWT
 * and role guards, resolves the website id from the route, authorizes the
 * caller against it (ADMIN implicit, AGENT via active membership) and attaches
 * the loaded website to `request.website`.
 *
 * Mark the route with `@WebsiteAccess('<paramName>')`; controllers then read
 * the authorized tenant through `@CurrentWebsite()`.
 */
@Injectable()
export class WebsiteAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly access: WebsiteAccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const paramName = this.reflector.getAllAndOverride<string | undefined>(
      WEBSITE_ACCESS_PARAM_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!paramName) {
      // Not a website-scoped route; resource-level checks still apply there.
      return true;
    }

    const request = context.switchToHttp().getRequest<WebsiteScopedRequest>();
    const websiteId = request.params?.[paramName];

    if (!websiteId || !UUID_PATTERN.test(websiteId)) {
      // Guards run before pipes, so validate the identifier here as well.
      throw new BadRequestException(`${paramName} must be a valid UUID`);
    }

    if (!request.user) {
      // Unreachable behind the global JwtAuthGuard, but never authorize an
      // anonymous principal.
      return false;
    }

    request.website = await this.access.getAccessibleWebsite(request.user, websiteId);
    return true;
  }
}
