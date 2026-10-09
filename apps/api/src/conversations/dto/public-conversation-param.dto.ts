import { IsUUID } from 'class-validator';
import { VisitorIdentityParamDto } from '../../common/dto/visitor-identity-param.dto';

/** Identifies one conversation *within* the calling visitor's own scope. */
export class PublicConversationParamDto extends VisitorIdentityParamDto {
  @IsUUID('all', { message: 'conversationId must be a valid UUID' })
  conversationId!: string;
}
