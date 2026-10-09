import { IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';

/** A visitor may only ever edit its own profile (proven by visitorKey). */
export class UpdateVisitorDto {
  @IsOptional()
  @IsString({ message: 'name must be a string' })
  @MaxLength(120, { message: 'name must be at most 120 characters' })
  name?: string;

  @IsOptional()
  @IsEmail({}, { message: 'email must be a valid email address' })
  @MaxLength(254)
  email?: string;
}
