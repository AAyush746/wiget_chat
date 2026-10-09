import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';

@Injectable()
export class PasswordService {
  /**
   * A valid bcrypt hash of an arbitrary string. Compared against when the
   * email does not exist so a failed login takes roughly the same time
   * whether or not the account is real (blunts user-enumeration timing).
   * It can never match a user-supplied password.
   */
  static readonly DUMMY_HASH = '$2b$12$G0XIahHnph4C74gTpwafoeslxVc/YGZSMZzNevGiWg.jbbu7/udQu';

  private readonly rounds: number;

  constructor(config: ConfigService) {
    this.rounds = config.get<number>('BCRYPT_ROUNDS') ?? 12;
  }

  hash(plainPassword: string): Promise<string> {
    return bcrypt.hash(plainPassword, this.rounds);
  }

  verify(plainPassword: string, passwordHash: string): Promise<boolean> {
    return bcrypt.compare(plainPassword, passwordHash);
  }
}
