import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { DOMAIN_PATTERN } from './create-website.dto';

/** At least one field must be present; the service rejects an empty patch. */
export class UpdateWebsiteDto {
  @IsOptional()
  @IsString({ message: 'name must be a string' })
  @MinLength(1, { message: 'name must not be empty' })
  @MaxLength(120, { message: 'name must be at most 120 characters' })
  name?: string;

  @IsOptional()
  @Matches(DOMAIN_PATTERN, {
    message: 'domain must be a valid hostname, e.g. example.com',
  })
  @MaxLength(253, { message: 'domain must be at most 253 characters' })
  domain?: string;
}
