import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Role } from '@prisma/client';

export class RegisterDto {
  @IsEmail({}, { message: 'email must be a valid email address' })
  @MaxLength(254)
  email!: string;

  @IsString()
  @MinLength(8, { message: 'password must be at least 8 characters' })
  @MaxLength(72, { message: 'password must be at most 72 characters' })
  @Matches(/[A-Za-z]/, { message: 'password must contain at least one letter' })
  @Matches(/\d/, { message: 'password must contain at least one number' })
  password!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  /**
   * Accepted for contract completeness but restricted server-side: public
   * registration can only ever create an AGENT.
   */
  @IsOptional()
  @IsEnum(Role, { message: 'role must be one of ADMIN, AGENT' })
  role?: Role;
}
