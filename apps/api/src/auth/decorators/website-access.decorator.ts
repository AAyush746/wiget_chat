import { SetMetadata } from '@nestjs/common';

export const WEBSITE_ACCESS_PARAM_KEY = 'websiteAccessParam';

/**
 * Declares that a website-scoped route must pass through WebsiteAccessGuard,
 * naming the route parameter that carries the website id.
 *
 * Usage: `@WebsiteAccess('websiteId')` alongside `@UseGuards(WebsiteAccessGuard)`.
 */
export const WebsiteAccess = (paramName: string): MethodDecorator & ClassDecorator =>
  SetMetadata(WEBSITE_ACCESS_PARAM_KEY, paramName);
