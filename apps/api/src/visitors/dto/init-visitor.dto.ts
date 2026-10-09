import { IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Optional, self-declared visitor details. Neither field is required and both
 * are treated as a hint about identity — never as an authentication factor.
 */
export class InitVisitorDto {
  @IsOptional()
  @IsString({ message: 'name must be a string' })
  @MaxLength(120, { message: 'name must be at most 120 characters' })
  name?: string;

  @IsOptional()
  @IsEmail({}, { message: 'email must be a valid email address' })
  @MaxLength(254)
  email?: string;
}
