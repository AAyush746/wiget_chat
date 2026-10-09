import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@prisma/client';
import type { AuthUser } from '@chatflow/types';
import { ROLES_KEY } from '../decorators/roles.decorator';
import type { AuthenticatedRequest } from '../interfaces/authenticated-request.interface';

/**
 * Global role guard. Runs after `JwtAuthGuard`, so `request.user` is already
 * populated for protected routes. Routes without `@Roles(...)` are allowed;
 * routes with it require the principal to hold one of the listed roles.
 *
 * NOTE: this is *role* authorization only. A role check on its own does not
 * grant access to a website/tenant or to a specific conversation. Later
 * phases must layer a per-resource guard (authenticated user -> permitted
 * website -> permitted resource) on top of this, e.g. a WebsiteAccessGuard
 * fed by assignment/tenant membership. Do not reuse this guard for tenant
 * scoping.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Partial<AuthenticatedRequest>>();
    const user: AuthUser | undefined = request.user;

    return user !== undefined && requiredRoles.includes(user.role);
  }
}
