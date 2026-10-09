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
  ChatMessage,
  CursorPage,
  MessageSendResult,
  Paginated,
  PublicConversation,
} from '@chatflow/types';
import { Public } from '../auth/decorators/public.decorator';
import { PublicWebsiteParamDto } from '../common/dto/public-website-param.dto';
import { VisitorIdentityParamDto } from '../common/dto/visitor-identity-param.dto';
import { RateLimit } from '../security/rate-limit.decorator';
import { RateLimitGuard } from '../security/rate-limit.guard';
import { ConversationsService } from './conversations.service';
import { MessagesService } from './messages.service';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { CreateMessageDto } from './dto/create-message.dto';
import { ListConversationsQueryDto } from './dto/list-conversations-query.dto';
import { ListMessagesQueryDto } from './dto/list-messages-query.dto';
import { PublicConversationParamDto } from './dto/public-conversation-param.dto';

/**
 * Public conversation endpoints for the widget. Staff authentication does not
 * apply here, but key validation, active-website checks, per-visitor scoping
 * and rate limits all do.
 */
@Public()
@UseGuards(RateLimitGuard)
@RateLimit('public:read')
@Controller('public/websites/:publicKey')
export class PublicConversationsController {
  constructor(
    private readonly conversations: ConversationsService,
    private readonly messages: MessagesService,
  ) {}

  @Post('conversations')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit('public:conversation-create')
  create(
    @Param() params: PublicWebsiteParamDto,
    @Body() dto: CreateConversationDto,
  ): Promise<PublicConversation> {
    return this.conversations.createFromVisitor(params.publicKey, dto);
  }

  @Get('visitor/:visitorKey/conversations')
  list(
    @Param() params: VisitorIdentityParamDto,
    @Query() query: ListConversationsQueryDto,
  ): Promise<Paginated<PublicConversation>> {
    return this.conversations.listFromVisitor(params.publicKey, params.visitorKey, query);
  }

  @Get('visitor/:visitorKey/conversations/:conversationId')
  getOne(@Param() params: PublicConversationParamDto): Promise<PublicConversation> {
    return this.conversations.getFromVisitor(
      params.publicKey,
      params.visitorKey,
      params.conversationId,
    );
  }

  @Post('visitor/:visitorKey/conversations/:conversationId/close')
  @HttpCode(HttpStatus.OK)
  close(@Param() params: PublicConversationParamDto): Promise<PublicConversation> {
    return this.conversations.closeFromVisitor(
      params.publicKey,
      params.visitorKey,
      params.conversationId,
    );
  }

  @Get('visitor/:visitorKey/conversations/:conversationId/messages')
  listMessages(
    @Param() params: PublicConversationParamDto,
    @Query() query: ListMessagesQueryDto,
  ): Promise<CursorPage<ChatMessage>> {
    return this.messages.listForVisitor(
      params.publicKey,
      params.visitorKey,
      params.conversationId,
      query,
    );
  }

  @Post('visitor/:visitorKey/conversations/:conversationId/messages')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit('public:message-send')
  sendMessage(
    @Param() params: PublicConversationParamDto,
    @Body() dto: CreateMessageDto,
  ): Promise<MessageSendResult> {
    return this.messages.createForVisitor(
      params.publicKey,
      params.visitorKey,
      params.conversationId,
      dto,
    );
  }
}
