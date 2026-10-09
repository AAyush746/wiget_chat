import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

/**
 * Global authentication guard. Every route requires a valid bearer token
 * unless it (or its controller) is annotated with `@Public()`.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') implements CanActivate {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  override canActivate(context: ExecutionContext) {
    // WebSocket connections authenticate once, at the handshake, inside the
    // gateway middleware (`WsAuthService` verifies the same JWT/visitor keys
    // with the same services). Passport's HTTP strategies cannot read a
    // bearer token from a Socket.IO context — they would throw before any
    // handler runs — so this guard deliberately stops here. Every gateway
    // handler independently consumes `socket.data.principal`, which the
    // handshake refuses to leave empty (the connection is rejected instead).
    if (context.getType<'ws' | 'http'>() === 'ws') {
      return true;
    }

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    return super.canActivate(context);
  }
}
