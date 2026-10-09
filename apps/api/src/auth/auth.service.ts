import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Role } from '@prisma/client';
import type { User } from '@prisma/client';
import type { AuthResponse } from '@chatflow/types';
import { normalizeEmail } from '../common/normalize-email';
import { PasswordService } from '../security/password.service';
import { toPublicUser } from '../users/user.mapper';
import { UsersService } from '../users/users.service';
import type { LoginDto } from './dto/login.dto';
import type { RegisterDto } from './dto/register.dto';
import { LoginThrottleService } from './login-throttle.service';
import type { JwtPayload } from './strategies/jwt-payload.interface';

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly password: PasswordService,
    private readonly jwt: JwtService,
    private readonly throttle: LoginThrottleService,
  ) {}

  async register(dto: RegisterDto): Promise<AuthResponse> {
    const requestedRole = dto.role ?? Role.AGENT;
    if (requestedRole !== Role.AGENT) {
      throw new ForbiddenException('Public registration cannot create ADMIN accounts');
    }

    const email = normalizeEmail(dto.email);
    if (await this.users.findByEmail(email)) {
      throw new ConflictException('An account with this email already exists');
    }

    const user = await this.users.createUser({
      email,
      password: dto.password,
      name: dto.name,
      role: Role.AGENT,
    });

    return this.issueToken(user);
  }

  async login(dto: LoginDto, ip: string): Promise<AuthResponse> {
    const email = normalizeEmail(dto.email);
    const throttleKey = `${ip}:${email}`;

    if (this.throttle.isLocked(throttleKey)) {
      throw new HttpException(
        'Too many failed login attempts. Try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const user = await this.users.findByEmail(email);
    // Always run a bcrypt comparison so response time does not reveal whether
    // the email exists.
    const passwordHash = user?.passwordHash ?? PasswordService.DUMMY_HASH;
    const passwordMatches = await this.password.verify(dto.password, passwordHash);

    if (!user || !user.passwordHash || !passwordMatches || !user.isActive) {
      this.throttle.recordFailure(throttleKey);
      // Identical message for unknown email, wrong password and inactive
      // account: nothing about account existence or state is disclosed.
      throw new UnauthorizedException('Invalid email or password');
    }

    this.throttle.clear(throttleKey);
    return this.issueToken(user);
  }

  private issueToken(user: User): AuthResponse {
    const payload: JwtPayload = { sub: user.id, email: user.email, role: user.role };
    return {
      accessToken: this.jwt.sign(payload),
      user: toPublicUser(user),
    };
  }
}
