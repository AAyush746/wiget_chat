import { Controller, Get } from '@nestjs/common';
import type { AuthUser, PublicWebsite } from '@chatflow/types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { WebsitesService } from './websites.service';

/**
 * "Which tenants can I work on?" for the dashboard sidebar. Access is derived
 * from the authenticated principal and membership rows — never filtered
 * client-side — so there is deliberately no `@Roles` here: ADMIN gets every
 * website, AGENT only their active memberships.
 */
@Controller('me/websites')
export class AccessibleWebsitesController {
  constructor(private readonly websites: WebsitesService) {}

  @Get()
  list(@CurrentUser() user: AuthUser): Promise<PublicWebsite[]> {
    return this.websites.listAccessibleFor(user);
  }
}
