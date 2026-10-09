import { IsUUID } from 'class-validator';

/** Website-scoped staff route parameter (validated, then guarded). */
export class StaffWebsiteParamDto {
  @IsUUID('all', { message: 'websiteId must be a valid UUID' })
  websiteId!: string;
}
