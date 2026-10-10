import { HttpException, Logger } from '@nestjs/common';
import {
  Ack,
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import type {
  ClientToServerEvents,
  ConversationJoinResult,
  MessageSendResult,
  ServerToClientEvents,
} from '@chatflow/types';
import { ConfigService } from '@nestjs/config';
import type { DefaultEventsMap, Server, Socket } from 'socket.io';
import { toPublicConversation } from '../conversations/conversation.mapper';
import {
  ClientMessageIdConflictException,
  MessagesService,
} from '../conversations/messages.service';
import { ConversationsService } from '../conversations/conversations.service';
import { RateLimitService } from '../security/rate-limit.service';
import { WebsitesService } from '../websites/websites.service';
import { WebsiteAccessService } from '../websites/website-access.service';
import { WsConversationRefDto } from './dto/ws-conversation-ref.dto';
import { WsSendMessageDto } from './dto/ws-send-message.dto';
import { RealtimeService, type RealtimeNotification } from './realtime.service';
import { WsAuthService } from './ws-auth.service';
import type { WsPrincipal, WsSocketData } from './ws-principal';
import {
  respondError,
  respondOk,
  validateWsPayload,
  WsPayloadError,
  type WsAckFn,
  type WsErrorEmitter,
} from './ws-payload';

type WsServer = Server<ClientToServerEvents, ServerToClientEvents, DefaultEventsMap, WsSocketData>;
type WsSocket = Socket<ClientToServerEvents, ServerToClientEvents, DefaultEventsMap, WsSocketData>;

interface WsRatePolicy {
  max: number;
  windowMs: number;
}

/**
 * The realtime transport — deliberately thin.
 *
 * Responsibilities: authenticate the handshake, authorize each subscription,
 * validate payloads, apply rate limits, call the *same* application services
 * the REST controllers use, and fan out committed changes to rooms. All
 * persistence and business rules live in `MessagesService` /
 * `ConversationsService`; this class never writes to the database itself and
 * never emits before a transaction has committed.
 *
 * Room strategy: two families under one authorization rule.
 *
 *  - `conversation:{id}` — joined only after per-conversation authorization
 *    (visitor ownership or staff membership).
 *  - `conversation:{id}:staff` — the membership check at join already gates
 *    who may enter, and staff-internal events (assignment ≠ the visitor's
 *    business) fan out here without ever reaching the visitor's socket.
 *  - `website:{id}:staff` — the staff inbox room. Every staff socket is added
 *    on connection, in the handshake, for each website its principal may read
 *    (ADMIN → all, AGENT → active memberships). Created conversations and
 *    messages in threads nobody has opened still reach every authorized agent
 *    without a reload. Visitors have no staff rooms. Reconnects are ordinary
 *    new connections, so the join set is recomputed and never goes stale.
 */
@WebSocketGateway({
  path: '/socket.io',
  cors: { origin: true },
})
export class ChatGateway {
  private static readonly ROOM_PREFIX = 'conversation:';
  private static readonly STAFF_ROOM_PREFIX = 'conversation:';
  private static readonly STAFF_ROOM_SUFFIX = ':staff';
  private static readonly WEBSITE_STAFF_PREFIX = 'website:';

  private static roomOf(conversationId: string): string {
    return ChatGateway.ROOM_PREFIX + conversationId;
  }

  private static staffRoomOf(conversationId: string): string {
    return ChatGateway.STAFF_ROOM_PREFIX + conversationId + ChatGateway.STAFF_ROOM_SUFFIX;
  }

  private static websiteStaffRoomOf(websiteId: string): string {
    return ChatGateway.WEBSITE_STAFF_PREFIX + websiteId + ChatGateway.STAFF_ROOM_SUFFIX;
  }

  private server!: WsServer;
  private readonly logger = new Logger(ChatGateway.name);
  private readonly policies: Record<'connect' | 'join' | 'message', WsRatePolicy>;

  constructor(
    private readonly wsAuth: WsAuthService,
    private readonly conversations: ConversationsService,
    private readonly messages: MessagesService,
    private readonly websites: WebsitesService,
    private readonly access: WebsiteAccessService,
    private readonly rateLimit: RateLimitService,
    private readonly realtime: RealtimeService,
    config: ConfigService,
  ) {
    const windowMs = config.get<number>('WS_RATE_LIMIT_WINDOW_MS') ?? 60_000;
    this.policies = {
      connect: { max: config.get<number>('WS_RATE_LIMIT_CONNECT_MAX') ?? 60, windowMs },
      join: { max: config.get<number>('WS_RATE_LIMIT_JOIN_MAX') ?? 60, windowMs },
      message: { max: config.get<number>('WS_RATE_LIMIT_MESSAGE_MAX') ?? 60, windowMs },
    };
  }

  afterInit(server: WsServer): void {
    this.server = server;

    // Handshake: exactly one credential shape, or the connection is refused.
    // There is no "connected but unauthenticated" state to forget later.
    server.use(async (socket, next) => {
      const ip = socket.handshake.address;
      if (!this.allow(`ws:connect:${ip ?? 'unknown'}`, 'connect')) {
        next(new Error('rate limited'));
        return;
      }
      try {
        socket.data.principal = await this.wsAuth.authenticate(socket.handshake.auth);
        next();
      } catch {
        next(new Error('unauthorized'));
      }
    });

    // Committed changes from REST *and* WebSocket flows fan out identically
    // because they all travel through the in-process bus.
    this.realtime.subscribe((notification) => this.fanOut(notification));

    // Staff inbox rooms are joined at connect time (never via a client event)
    // so a freshly established connection receives website-wide fan-out from
    // its first moment, and a reconnection re-derives the set automatically.
    server.on('connection', (socket) => {
      const principal = socket.data.principal;
      if (principal?.kind === 'staff') {
        void this.joinWebsiteRooms(socket, principal);
      }
    });
  }

  // ------------------------------------------------------ client → server

  @SubscribeMessage('conversation:join')
  async onConversationJoin(
    @ConnectedSocket() socket: WsSocket,
    @MessageBody() payload: unknown,
    @Ack() ack?: WsAckFn<ConversationJoinResult>,
  ): Promise<void> {
    const principal = this.principalOf(socket, ack);
    if (!principal) return;

    if (!this.allow(`ws:join:${socket.id}`, 'join')) {
      respondError(socket, ack, 'RATE_LIMITED', 'Too many requests');
      return;
    }

    let conversationId: string;
    try {
      conversationId = (await validateWsPayload(WsConversationRefDto, payload)).conversationId;
    } catch (error) {
      this.respondFailure(socket, ack, error);
      return;
    }

    try {
      const conversation =
        principal.kind === 'staff'
          ? (await this.conversations.resolveStaffConversation(principal.user, conversationId))
              .conversation
          : await this.resolveVisitorThread(principal, conversationId);

      socket.join(ChatGateway.roomOf(conversationId));
      if (principal.kind === 'staff') {
        // Assignment is staff-side: staff join a dedicated staff room for this
        // conversation, neither joinable nor visible to the visitor's socket.
        socket.join(ChatGateway.staffRoomOf(conversationId));
      }
      respondOk(socket, ack, { conversation: toPublicConversation(conversation) });
    } catch (error) {
      this.respondFailure(socket, ack, error);
    }
  }

  @SubscribeMessage('conversation:leave')
  async onConversationLeave(
    @ConnectedSocket() socket: WsSocket,
    @MessageBody() payload: unknown,
    @Ack() ack?: WsAckFn,
  ): Promise<void> {
    try {
      const { conversationId } = await validateWsPayload(WsConversationRefDto, payload);
      socket.leave(ChatGateway.roomOf(conversationId));
      socket.leave(ChatGateway.staffRoomOf(conversationId));
      respondOk(socket, ack, {});
    } catch (error) {
      this.respondFailure(socket, ack, error);
    }
  }

  @SubscribeMessage('message:send')
  async onMessageSend(
    @ConnectedSocket() socket: WsSocket,
    @MessageBody() payload: unknown,
    @Ack() ack?: WsAckFn<MessageSendResult>,
  ): Promise<void> {
    const principal = this.principalOf(socket, ack);
    if (!principal) return;

    if (!this.allow(`ws:message:${socket.id}`, 'message')) {
      respondError(socket, ack, 'RATE_LIMITED', 'Too many requests');
      return;
    }

    let dto: WsSendMessageDto;
    try {
      dto = await validateWsPayload(WsSendMessageDto, payload);
    } catch (error) {
      this.respondFailure(socket, ack, error);
      return;
    }

    try {
      // Same service, same authorization chain, same transaction as REST.
      // The realtime emission happens inside the service, after commit.
      const result =
        principal.kind === 'staff'
          ? await this.messages.createForStaff(principal.user, dto.conversationId, dto)
          : await this.messages.createForVisitor(
              principal.publicKey,
              principal.visitor.visitorKey,
              dto.conversationId,
              dto,
            );
      respondOk(socket, ack, result);
    } catch (error) {
      this.respondFailure(socket, ack, error);
    }
  }

  // -------------------------------------------------------------- helpers

  private principalOf<T>(socket: WsSocket, ack: WsAckFn<T>): WsPrincipal | null {
    const principal = socket.data.principal;
    if (!principal) {
      // Unreachable behind the handshake middleware, but never act for an
      // anonymous principal.
      respondError(socket, ack, 'UNAUTHORIZED', 'Not authenticated');
      return null;
    }
    return principal;
  }

  /**
   * Visitor join: re-check that the website is still active (it may have
   * been deactivated since the handshake) and that the conversation still
   * belongs to this visitor — otherwise an indistinguishable NOT_FOUND.
   */
  private async resolveVisitorThread(
    principal: Extract<WsPrincipal, { kind: 'visitor' }>,
    conversationId: string,
  ): Promise<Awaited<ReturnType<ConversationsService['resolveVisitorConversation']>>> {
    await this.websites.resolveActiveByKey(principal.publicKey);
    return this.conversations.resolveVisitorConversation(principal.visitor, conversationId);
  }

  private allow(key: string, policy: 'connect' | 'join' | 'message'): boolean {
    const { max, windowMs } = this.policies[policy];
    return this.rateLimit.hit(key, max, windowMs).allowed;
  }

  /**
   * Subscribe a staff socket to every website inbox it may legitimately read.
   * Authorization mirrors REST (`WebsiteAccessService`): ADMIN joins all
   * rooms, AGENT only rooms for its active memberships. The join is driven by
   * the principal resolved during the handshake, and because every (re)connect
   * re-runs this, memberships changed while a session was down are honored.
   */
  private async joinWebsiteRooms(
    socket: WsSocket,
    principal: Extract<WsPrincipal, { kind: 'staff' }>,
  ): Promise<void> {
    try {
      const websiteIds = await this.access.listAccessibleWebsiteIds(principal.user);
      for (const websiteId of websiteIds) {
        socket.join(ChatGateway.websiteStaffRoomOf(websiteId));
      }
    } catch (error) {
      // Never reject a connection over room bookkeeping; the worst case is a
      // socket that only hears events for conversations it explicitly joins.
      this.logger.error('Failed to join website staff rooms', String(error));
    }
  }

  private fanOut(notification: RealtimeNotification): void {
    const staffInbox = ChatGateway.websiteStaffRoomOf(notification.websiteId);
    switch (notification.event) {
      case 'conversation:new':
        // Nothing to join yet — the thread does not exist in any room. The
        // owning website's staff inbox hears about it immediately.
        this.server.to(staffInbox).emit('conversation:new', notification.payload);
        break;
      case 'message:new':
        this.server
          .to(ChatGateway.roomOf(notification.conversationId))
          .emit('message:new', notification.payload);
        // Every agent may preview the newest message, including staff who
        // never opened this thread. A socket in both rooms gets two copies —
        // clients upsert by id, so the duplicate is a no-op.
        this.server.to(staffInbox).emit('message:new', notification.payload);
        break;
      case 'conversation:updated':
        this.server
          .to(ChatGateway.roomOf(notification.conversationId))
          .emit('conversation:updated', notification.payload);
        this.server.to(staffInbox).emit('conversation:updated', notification.payload);
        break;
      case 'conversation:closed':
        this.server
          .to(ChatGateway.roomOf(notification.conversationId))
          .emit('conversation:closed', notification.payload);
        this.server.to(staffInbox).emit('conversation:closed', notification.payload);
        break;
      case 'conversation:assigned':
        // Staff-internal: never emitted into the shared conversation room where
        // the visitor's socket listens.
        this.server
          .to(ChatGateway.staffRoomOf(notification.conversationId))
          .emit('conversation:assigned', notification.payload);
        this.server.to(staffInbox).emit('conversation:assigned', notification.payload);
        break;
    }
  }

  /**
   * The framework swallows thrown handler exceptions, so every error is
   * converted into an ack (or a pushed `error` event when the client did not
   * supply an ack). Unexpected errors are logged server-side and reported as
   * INTERNAL — internals never leak to the socket.
   */
  private respondFailure<T>(
    socket: WsErrorEmitter & WsSocket,
    ack: WsAckFn<T>,
    error: unknown,
  ): void {
    if (error instanceof WsPayloadError) {
      respondError(socket, ack, 'VALIDATION', error.message);
      return;
    }

    if (error instanceof HttpException) {
      const status = error.getStatus();
      const response = error.getResponse();
      const message = typeof response === 'string' ? response : error.message;

      switch (status) {
        case 400:
          respondError(socket, ack, 'VALIDATION', message);
          return;
        case 403:
          respondError(socket, ack, 'FORBIDDEN', message);
          return;
        case 404:
          respondError(socket, ack, 'NOT_FOUND', message);
          return;
        case 409:
          respondError(
            socket,
            ack,
            error instanceof ClientMessageIdConflictException ? 'CONFLICT' : 'CONVERSATION_CLOSED',
            message,
          );
          return;
        case 429:
          respondError(socket, ack, 'RATE_LIMITED', message);
          return;
        default:
          break;
      }
    }

    this.logger.error(
      'Unhandled realtime error',
      error instanceof Error ? error.stack : String(error),
    );
    respondError(socket, ack, 'INTERNAL', 'Internal error');
  }
}
