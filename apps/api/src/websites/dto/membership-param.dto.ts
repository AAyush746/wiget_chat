import { IsUUID } from 'class-validator';

export class MembershipParamDto {
  @IsUUID('all', { message: 'id must be a valid UUID' })
  id!: string;

  @IsUUID('all', { message: 'membershipId must be a valid UUID' })
  membershipId!: string;
}
