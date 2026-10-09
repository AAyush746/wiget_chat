import { IsUUID } from 'class-validator';

export class WebsiteIdParamDto {
  @IsUUID('all', { message: 'id must be a valid UUID' })
  id!: string;
}
