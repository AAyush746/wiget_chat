import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { Website } from '@prisma/client';
import type {
  AuthUser,
  ConversationAssignmentEntry,
  PublicUser,
  StaffConversation,
} from '@chatflow/types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CurrentWebsite } from '../auth/decorators/current-website.decorator';
import { WebsiteAccess } from '../auth/decorators/website-access.decorator';
import { WebsiteAccessGuard } from '../auth/guards/website-access.guard';
import { AssignConversationDto } from './dto/assign-conversation.dto';
import { StaffConversationParamDto } from './dto/staff-conversation-param.dto';
import { AssignmentsService } from './assignments.service';

/**
 * Assignment workflow for authorized staff, all website-scoped through the
 * same `WebsiteAccessGuard` chain as messaging (JWT → role → membership →
 * tenant). Assignment is a *staff-side* concept: these endpoints are never
 * reachable from the visitor widget, and the visitor-facing
 * `PublicConversation` never carries assignee data.
 */
@UseGuards(WebsiteAccessGuard)
@WebsiteAccess('websiteId')
@Controller('websites/:websiteId/conversations')
export class AssignmentsController {
  constructor(private readonly assignments: AssignmentsService) {}

  /** Assign the conversation to the calling staff member. */
  @Post(':conversationId/claim')
  @HttpCode(HttpStatus.OK)
  claim(
    @CurrentUser() user: AuthUser,
    @CurrentWebsite() website: Website,
    @Param() params: StaffConversationParamDto,
  ): Promise<StaffConversation> {
    return this.assignments.claim(website, params.conversationId, user);
  }

  /** Assign — or, when already held by someone else, reassign — to an eligible agent. */
  @Post(':conversationId/assign')
  @HttpCode(HttpStatus.OK)
  assign(
    @CurrentUser() user: AuthUser,
    @CurrentWebsite() website: Website,
    @Param() params: StaffConversationParamDto,
    @Body() dto: AssignConversationDto,
  ): Promise<StaffConversation> {
    return this.assignments.assign(website, params.conversationId, user, dto.userId);
  }

  /** Append-only assignment history for the conversation. */
  @Get(':conversationId/assignments')
  history(
    @CurrentWebsite() website: Website,
    @Param() params: StaffConversationParamDto,
  ): Promise<ConversationAssignmentEntry[]> {
    return this.assignments.history(website, params.conversationId);
  }
}

/** Who may be assigned work on this website (for the dashboard's agent picker). */
@UseGuards(WebsiteAccessGuard)
@WebsiteAccess('websiteId')
@Controller('websites/:websiteId')
export class AssignableAgentsController {
  constructor(private readonly assignments: AssignmentsService) {}

  @Get('assignable')
  listAssignable(@CurrentWebsite() website: Website): Promise<PublicUser[]> {
    return this.assignments.listAssignable(website);
  }
}
