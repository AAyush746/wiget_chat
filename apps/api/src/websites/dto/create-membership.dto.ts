import { IsBoolean, IsOptional, IsUUID } from 'class-validator';

export class CreateMembershipDto {
  @IsUUID('all', { message: 'userId must be a valid UUID' })
  userId!: string;

  @IsOptional()
  @IsBoolean({ message: 'isActive must be a boolean' })
  isActive?: boolean;
}
