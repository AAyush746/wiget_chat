import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AuthUser } from '@chatflow/types';
import type { AuthenticatedRequest } from '../interfaces/authenticated-request.interface';

/** Injects the authenticated principal validated by the JWT strategy. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthUser => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    return request.user;
  },
);
