import type { Website } from '@prisma/client';
import type { AuthenticatedRequest } from './authenticated-request.interface';

/** The Express request shape after WebsiteAccessGuard has run. */
export interface WebsiteRequest extends AuthenticatedRequest {
  website: Website;
}
