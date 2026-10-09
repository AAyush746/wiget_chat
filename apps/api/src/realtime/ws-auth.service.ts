import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { AuthUser, WsHandshakeAuth } from '@chatflow/types';
import { UsersService } from '../users/users.service';
import { VisitorsService } from '../visitors/visitors.service';
import type { JwtPayload } from '../auth/strategies/jwt-payload.interface';
import type { WsPrincipal } from './ws-principal';

/**
 * Socket.IO handshake authentication — one credential system per audience,
 * reusing exactly what Phase 3/4 established:
 *
 *  - staff: `auth.token` is the *same* JWT as REST (`Authorization: Bearer`).
 *    Signature/expiry are verified by the same JwtService secret, then the
 *    user is re-loaded and must still be active — so deactivation kills live
 *    and future socket connections just like it kills REST requests.
 *  - visitor: `auth.publicKey` + `auth.visitorKey` go through
 *    `resolveVisitor`, the composite (website, key) lookup that requires an
 *    active website. A bare `visitorId` is never accepted.
 *
 * Any failure rejects the connection (`connect_error`); there is no
 * "connected but unauthenticated" state to forget about later.
 */
@Injectable()
export class WsAuthService {
  constructor(
    private readonly jwt: JwtService,
    private readonly users: UsersService,
    private readonly visitors: VisitorsService,
  ) {}

  async authenticate(rawAuth: unknown): Promise<WsPrincipal> {
    const auth = (rawAuth ?? {}) as Partial<WsHandshakeAuth>;

    if (typeof auth.token === 'string' && auth.token.length > 0) {
      return this.authenticateStaff(auth.token);
    }

    if (typeof auth.publicKey === 'string' && typeof auth.visitorKey === 'string') {
      const visitor = await this.visitors.resolveVisitor(auth.publicKey, auth.visitorKey);
      return { kind: 'visitor', visitor, publicKey: auth.publicKey };
    }

    throw new UnauthorizedException('Missing credentials');
  }

  private async authenticateStaff(token: string): Promise<WsPrincipal> {
    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }

    const user = await this.users.findById(payload.sub);
    if (!user || !user.isActive) {
      throw new UnauthorizedException('Invalid or expired token');
    }

    const principal: AuthUser = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    };
    return { kind: 'staff', user: principal };
  }
}
