import { IsOptional, IsString, MinLength, MaxLength } from 'class-validator';

export class UpdateFaqDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  question?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  answer?: string;
}
