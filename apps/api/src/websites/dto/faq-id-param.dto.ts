import { IsUUID } from 'class-validator';

export class FaqIdParamDto {
  @IsUUID()
  id!: string;
}
