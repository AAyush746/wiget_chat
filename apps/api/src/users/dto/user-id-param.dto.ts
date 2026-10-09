import { IsUUID } from 'class-validator';

export class UserIdParamDto {
  @IsUUID('all', { message: 'id must be a valid UUID' })
  id!: string;
}
