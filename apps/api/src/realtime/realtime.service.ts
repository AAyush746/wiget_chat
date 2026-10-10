import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import type {
  ConversationAssignedEvent,
  ConversationClosedEvent,
  ConversationNewEvent,
  MessageNewEvent,
  PublicConversation,
} from '@chatflow/types';

/**
 * One committed change that connected clients should hear about. The
 * envelope carries the room target (conversation + owning website) so the
 * transport never has to dig it out of the payload.
 */
export type RealtimeNotification =
  | {
      event: 'message:new';
      conversationId: string;
      websiteId: string;
      payload: MessageNewEvent;
    }
  | {
      event: 'conversation:updated';
      conversationId: string;
      websiteId: string;
      payload: { conversation: PublicConversation };
    }
  | {
      event: 'conversation:closed';
      conversationId: string;
      websiteId: string;
      payload: ConversationClosedEvent;
    }
  | {
      event: 'conversation:assigned';
      conversationId: string;
      websiteId: string;
      payload: ConversationAssignedEvent;
    }
  | { event: 'conversation:new'; websiteId: string; payload: ConversationNewEvent };

/**
 * In-process bridge between application services and the Socket.IO gateway.
 *
 * Services publish only *after* their transaction commits and stay
 * socket-agnostic; the gateway subscribes and fans out to rooms. This is what
 * keeps REST and WebSocket sends on the identical persistence path and lets
 * `ConversationsModule` depend on a leaf module instead of on the gateway
 * (which depends on it) — no circular DI.
 *
 * Single-instance by design: notifications are plain in-memory events. Once
 * the API runs behind a load balancer this must become a shared bus (Redis
 * pub/sub) so instance A can reach sockets connected to instance B.
 */
@Injectable()
export class RealtimeService {
  private readonly bus = new EventEmitter();

  publishMessageNew(message: MessageNewEvent, websiteId: string): void {
    this.notify({
      event: 'message:new',
      conversationId: message.conversationId,
      websiteId,
      payload: message,
    });
  }

  publishConversationNew(payload: ConversationNewEvent): void {
    this.notify({ event: 'conversation:new', websiteId: payload.websiteId, payload });
  }

  publishConversationUpdated(conversation: PublicConversation, websiteId: string): void {
    this.notify({
      event: 'conversation:updated',
      conversationId: conversation.id,
      websiteId,
      payload: { conversation },
    });
  }

  publishConversationClosed(payload: ConversationClosedEvent, websiteId: string): void {
    this.notify({
      event: 'conversation:closed',
      conversationId: payload.conversationId,
      websiteId,
      payload,
    });
  }

  publishConversationAssigned(payload: ConversationAssignedEvent, websiteId: string): void {
    this.notify({
      event: 'conversation:assigned',
      conversationId: payload.conversationId,
      websiteId,
      payload,
    });
  }

  /** Gateway hook. Exactly one subscriber in a single-instance deployment. */
  subscribe(listener: (notification: RealtimeNotification) => void): void {
    this.bus.on('notification', listener);
  }

  private notify(notification: RealtimeNotification): void {
    this.bus.emit('notification', notification);
  }
}
