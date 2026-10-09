import { IsBoolean } from 'class-validator';

export class UpdateMembershipDto {
  @IsBoolean({ message: 'isActive must be a boolean' })
  isActive!: boolean;
}
