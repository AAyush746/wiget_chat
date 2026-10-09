import { Module } from '@nestjs/common';
import { RateLimitGuard } from './rate-limit.guard';
import { RateLimitService } from './rate-limit.service';

/**
 * Public-endpoint abuse protection. Kept in its own module so feature modules
 * opt in explicitly instead of registering guards globally.
 */
@Module({
  providers: [RateLimitService, RateLimitGuard],
  exports: [RateLimitService, RateLimitGuard],
})
export class SecurityModule {}
