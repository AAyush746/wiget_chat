import type { ChatMessage, PublicConversation, PublicVisitor } from '@chatflow/types';
import type { PendingMessage } from './messages';
import { clearPending, markPendingError, mergeHistory, upsertMessage } from './messages';
import type { SocketStatus } from './socket';

export type WidgetPhase = 'booting' | 'ready' | 'error';

export interface WidgetState {
  phase: WidgetPhase;
  bootError: string | null;
  /** Bumped on user retry so the boot effect can re-run. */
  retryToken: number;
  visitor: PublicVisitor | null;
  conversation: PublicConversation | null;
  conversationId: string | null;
  messages: ChatMessage[];
  nextCursor: string | null;
  loadingHistory: boolean;
  loadingOlder: boolean;
  pending: PendingMessage[];
  socketStatus: SocketStatus;
  showPanel: boolean;
}

export type WidgetAction =
  | { type: 'boot:start' }
  | { type: 'boot:retry' }
  | { type: 'boot:fail'; error: string }
  | { type: 'identity'; visitor: PublicVisitor }
  | { type: 'conversation:set'; conversation: PublicConversation }
  | { type: 'chat:start'; conversation: PublicConversation }
  | { type: 'history:start' }
  | { type: 'history:loaded'; messages: ChatMessage[]; nextCursor: string | null }
  | { type: 'history:older-start' }
  | { type: 'history:older-loaded'; messages: ChatMessage[]; nextCursor: string | null }
  | { type: 'message:received'; message: ChatMessage }
  | { type: 'pending:add'; pending: PendingMessage }
  | { type: 'pending:resolve'; clientMessageId: string; message: ChatMessage }
  | { type: 'pending:fail'; clientMessageId: string; error: string }
  | { type: 'pending:retry'; clientMessageId: string }
  | { type: 'ready' }
  | { type: 'conversation:updated'; conversation: PublicConversation }
  | { type: 'conversation:closed'; closedAt: string }
  | { type: 'socket:status'; status: SocketStatus }
  | { type: 'panel:set'; open: boolean };

export const initialWidgetState: WidgetState = {
  phase: 'booting',
  bootError: null,
  retryToken: 0,
  visitor: null,
  conversation: null,
  conversationId: null,
  messages: [],
  nextCursor: null,
  loadingHistory: false,
  loadingOlder: false,
  pending: [],
  socketStatus: 'disconnected',
  showPanel: false,
};

export function widgetReducer(state: WidgetState, action: WidgetAction): WidgetState {
  switch (action.type) {
    case 'boot:start':
      return { ...state, phase: 'booting', bootError: null };
    case 'boot:retry':
      return { ...state, retryToken: state.retryToken + 1 };
    case 'boot:fail':
      return { ...state, phase: 'error', bootError: action.error };

    case 'identity':
      return { ...state, visitor: action.visitor };
    case 'conversation:set':
      return {
        ...state,
        conversation: action.conversation,
        conversationId: action.conversation.id,
      };
    case 'chat:start':
      // Open a fresh thread: new conversation, empty history, no pending sends.
      return {
        ...state,
        conversation: action.conversation,
        conversationId: action.conversation.id,
        messages: [],
        nextCursor: null,
        pending: [],
        loadingHistory: false,
      };

    case 'history:start':
      return { ...state, loadingHistory: true };
    case 'history:loaded':
      return {
        ...state,
        loadingHistory: false,
        messages: action.messages,
        nextCursor: action.nextCursor,
      };
    case 'history:older-start':
      return { ...state, loadingOlder: true };
    case 'history:older-loaded':
      return {
        ...state,
        loadingOlder: false,
        messages: mergeHistory(state.messages, action.messages),
        nextCursor: action.nextCursor,
      };

    case 'message:received': {
      const { message } = action;
      if (message.conversationId !== state.conversationId) return state;
      const pending = message.clientMessageId
        ? clearPending(state.pending, message.clientMessageId)
        : state.pending;
      return { ...state, messages: upsertMessage(state.messages, message), pending };
    }

    case 'pending:add': {
      if (state.pending.some((p) => p.clientMessageId === action.pending.clientMessageId)) {
        return state;
      }
      return { ...state, pending: [...state.pending, action.pending] };
    }
    case 'pending:resolve':
      return {
        ...state,
        messages: upsertMessage(state.messages, action.message),
        pending: clearPending(state.pending, action.clientMessageId),
      };
    case 'pending:fail':
      return {
        ...state,
        pending: markPendingError(state.pending, action.clientMessageId, action.error),
      };
    case 'pending:retry':
      return {
        ...state,
        pending: state.pending.map((p) =>
          p.clientMessageId === action.clientMessageId
            ? { ...p, status: 'sending', error: null }
            : p,
        ),
      };

    case 'ready':
      return { ...state, phase: 'ready' };
    case 'conversation:updated':
      if (action.conversation.id !== state.conversationId) return state;
      return { ...state, conversation: action.conversation };
    case 'conversation:closed': {
      if (!state.conversation || state.conversation.id !== state.conversationId) return state;
      return {
        ...state,
        conversation: {
          ...state.conversation,
          status: 'CLOSED',
          closedAt: action.closedAt,
        },
      };
    }

    case 'socket:status':
      return { ...state, socketStatus: action.status };
    case 'panel:set':
      return { ...state, showPanel: action.open };

    default:
      return state;
  }
}
