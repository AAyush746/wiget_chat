import { IsString, MinLength, MaxLength } from 'class-validator';

export class CreateFaqDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  question!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  answer!: string;
}
