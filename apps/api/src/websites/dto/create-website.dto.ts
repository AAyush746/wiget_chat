import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

/** FQDN shape, e.g. `shop.example.com` or `sub.domain.co.uk`. */
export const DOMAIN_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

export class CreateWebsiteDto {
  @IsString({ message: 'name must be a string' })
  @MinLength(1, { message: 'name must not be empty' })
  @MaxLength(120, { message: 'name must be at most 120 characters' })
  name!: string;

  @Matches(DOMAIN_PATTERN, {
    message: 'domain must be a valid hostname, e.g. example.com',
  })
  @MaxLength(253, { message: 'domain must be at most 253 characters' })
  domain!: string;
}
