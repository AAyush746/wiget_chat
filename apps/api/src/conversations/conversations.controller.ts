import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type {
  AuthUser,
  ChatMessage,
  CursorPage,
  MessageSendResult,
  Paginated,
  StaffConversation,
} from '@chatflow/types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CurrentWebsite } from '../auth/decorators/current-website.decorator';
import { WebsiteAccess } from '../auth/decorators/website-access.decorator';
import { WebsiteAccessGuard } from '../auth/guards/website-access.guard';
import type { WebsiteRequest } from '../auth/interfaces/website-request.interface';
import { ConversationsService } from './conversations.service';
import { MessagesService } from './messages.service';
import { CreateMessageDto } from './dto/create-message.dto';
import { ListConversationsQueryDto } from './dto/list-conversations-query.dto';
import { ListMessagesQueryDto } from './dto/list-messages-query.dto';
import { StaffConversationParamDto } from './dto/staff-conversation-param.dto';

/**
 * Staff access to a conversation and its messages, scoped to a single
 * website. Message paths are nested under the website (adapted from the
 * bare `/conversations/:id/messages` sketch) so the existing
 * WebsiteAccessGuard chain — JWT → role → ADMIN/AGENT membership → tenant —
 * applies unchanged and `conversationId` alone can never reach a foreign
 * tenant's rows.
 *
 * No `@Roles` here: WebsiteAccessGuard decides between ADMIN (always) and
 * AGENT (active membership required). Every query is built from the
 * guard-authorized website, so changing `websiteId` or `conversationId` in the
 * request can never reach another tenant's rows.
 */
@UseGuards(WebsiteAccessGuard)
@WebsiteAccess('websiteId')
@Controller('websites/:websiteId/conversations')
export class ConversationsController {
  constructor(
    private readonly conversations: ConversationsService,
    private readonly messages: MessagesService,
  ) {}

  @Get()
  list(
    @CurrentWebsite() website: WebsiteRequest['website'],
    @Query() query: ListConversationsQueryDto,
  ): Promise<Paginated<StaffConversation>> {
    return this.conversations.listForStaff(website, query);
  }

  @Get(':conversationId')
  getOne(
    @CurrentWebsite() website: WebsiteRequest['website'],
    @Param() params: StaffConversationParamDto,
  ): Promise<StaffConversation> {
    return this.conversations.getForStaff(website, params.conversationId);
  }

  @Get(':conversationId/messages')
  listMessages(
    @CurrentWebsite() website: WebsiteRequest['website'],
    @Param() params: StaffConversationParamDto,
    @Query() query: ListMessagesQueryDto,
  ): Promise<CursorPage<ChatMessage>> {
    return this.messages.listForStaff(website, params.conversationId, query);
  }

  @Post(':conversationId/messages')
  @HttpCode(HttpStatus.CREATED)
  sendMessage(
    @CurrentUser() user: AuthUser,
    @CurrentWebsite() website: WebsiteRequest['website'],
    @Param() params: StaffConversationParamDto,
    @Body() dto: CreateMessageDto,
  ): Promise<MessageSendResult> {
    return this.messages.createForStaff(user, params.conversationId, dto, website.id);
  }

  @Post(':conversationId/close')
  @HttpCode(HttpStatus.OK)
  close(
    @CurrentUser() user: AuthUser,
    @CurrentWebsite() website: WebsiteRequest['website'],
    @Param() params: StaffConversationParamDto,
  ): Promise<StaffConversation> {
    return this.conversations.closeForStaff(user, params.conversationId, website.id);
  }
}
