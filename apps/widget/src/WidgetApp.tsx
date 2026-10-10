import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { PublicConversation } from '@chatflow/types';
import { Launcher } from './components/Launcher';
import { Panel } from './components/Panel';
import { createVisitorApi, type VisitorApi } from './lib/api';
import { describeConfigError, type ResolvedConfig } from './lib/config';
import {
  HISTORY_LIMIT,
  createPending,
  mergeThread,
  sendMessage,
  wsFailure,
  type PendingMessage,
  type RestTransport,
} from './lib/messages';
import { visitorSocket } from './lib/socket';
import { initialWidgetState, widgetReducer } from './lib/state';
import {
  clearStoredVisitor,
  loadStoredConversationId,
  loadStoredVisitor,
  saveStoredConversationId,
  saveStoredVisitor,
} from './lib/storage';

interface Session {
  api: VisitorApi;
  visitorKey: string;
}

function restTransport(api: VisitorApi, visitorKey: string, conversationId: string): RestTransport {
  return {
    send: (payload) => api.sendMessage(visitorKey, conversationId, payload),
  };
}

export function WidgetApp({ config }: { config: ResolvedConfig }) {
  const [state, dispatch] = useReducer(widgetReducer, initialWidgetState);
  const [unread, setUnread] = useState(0);

  const sessionRef = useRef<Session | null>(null);
  const stateRef = useRef(state);
  const panelRef = useRef(state.showPanel);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  useEffect(() => {
    panelRef.current = state.showPanel;
    if (state.showPanel) setUnread(0);
  }, [state.showPanel]);

  // ------------------------------------------------------- realtime subscription
  const refreshConversation = useCallback(async () => {
    const session = sessionRef.current;
    const current = stateRef.current;
    if (!session || !current.conversationId) return;
    try {
      const conversation = await session.api.getConversation(
        session.visitorKey,
        current.conversationId,
      );
      dispatch({ type: 'conversation:set', conversation });
    } catch {
      // Transient; the socket reconnect loop will retry the resync.
    }
  }, []);

  const resync = useCallback(async () => {
    const session = sessionRef.current;
    const current = stateRef.current;
    if (!session || !current.conversationId) return;
    try {
      const conversation = await session.api.getConversation(
        session.visitorKey,
        current.conversationId,
      );
      dispatch({ type: 'conversation:set', conversation });
      const page = await session.api.listMessages(session.visitorKey, current.conversationId, {
        limit: HISTORY_LIMIT,
      });
      dispatch({ type: 'history:loaded', messages: page.data, nextCursor: page.nextCursor });
    } catch {
      // Transient; the socket reconnect loop will retry the resync.
    }
  }, []);

  const resyncRef = useRef(resync);
  resyncRef.current = resync;

  useEffect(() => {
    const unsubscribe = visitorSocket.subscribe((event) => {
      switch (event.type) {
        case 'status':
          dispatch({ type: 'socket:status', status: event.status });
          break;
        case 'reconnected':
          void resyncRef.current();
          break;
        case 'message:new':
          dispatch({ type: 'message:received', message: event.payload.message });
          if (!panelRef.current && event.payload.message.senderType === 'AGENT') {
            setUnread((count) => count + 1);
          }
          break;
        case 'conversation:updated':
          dispatch({ type: 'conversation:updated', conversation: event.payload.conversation });
          break;
        case 'conversation:closed':
          dispatch({ type: 'conversation:closed', closedAt: event.payload.closedAt });
          break;
        case 'error':
          break;
      }
    });
    return unsubscribe;
  }, []);

  // ------------------------------------------------------------ boot (identity)
  useEffect(() => {
    const cfgError = describeConfigError(config);
    if (cfgError) {
      dispatch({ type: 'boot:fail', error: cfgError });
      return;
    }

    let cancelled = false;
    void (async () => {
      dispatch({ type: 'boot:start' });
      const api = createVisitorApi({ apiUrl: config.apiUrl, publicKey: config.publicKey });
      try {
        // 1. Restore the visitor identity (or initialize a new one). The stored
        //    key is only trusted after the server re-validates it.
        let visitor = loadStoredVisitor(config.publicKey);
        if (visitor) {
          try {
            visitor = await api.getVisitor(visitor.visitorKey);
            saveStoredVisitor(config.publicKey, visitor);
          } catch {
            clearStoredVisitor(config.publicKey);
            visitor = null;
          }
        }
        if (!visitor) {
          visitor = await api.initVisitor({});
          saveStoredVisitor(config.publicKey, visitor);
        }

        // 2. Resume the last conversation, or start a new one.
        let conversation: PublicConversation | null = null;
        const storedId = loadStoredConversationId(config.publicKey);
        if (storedId) {
          try {
            conversation = await api.getConversation(visitor.visitorKey, storedId);
          } catch {
            conversation = null;
          }
        }
        if (!conversation) {
          conversation = await api.createConversation(visitor.visitorKey, {});
          saveStoredConversationId(config.publicKey, conversation.id);
        }

        if (cancelled) return;
        sessionRef.current = { api, visitorKey: visitor.visitorKey };
        dispatch({ type: 'identity', visitor });
        dispatch({ type: 'conversation:set', conversation });

        // 3. Load authoritative message history from REST (never localStorage).
        dispatch({ type: 'history:start' });
        const page = await api.listMessages(visitor.visitorKey, conversation.id, {
          limit: HISTORY_LIMIT,
        });
        if (cancelled) return;
        dispatch({ type: 'history:loaded', messages: page.data, nextCursor: page.nextCursor });
        dispatch({ type: 'ready' });
      } catch (error) {
        if (cancelled) return;
        dispatch({
          type: 'boot:fail',
          error:
            error instanceof Error && error.message
              ? error.message
              : 'Unable to reach the chat service.',
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [config, state.retryToken]);

  // --------------------------------------------------- socket connect / join room
  useEffect(() => {
    if (state.phase !== 'ready' || !state.visitor) return;
    if (!visitorSocket.isConnected() && visitorSocket.getState() !== 'connecting') {
      visitorSocket.connect(config.apiUrl, {
        publicKey: config.publicKey,
        visitorKey: state.visitor.visitorKey,
      });
    }
  }, [state.phase, state.visitor, config.apiUrl, config.publicKey]);

  useEffect(() => {
    if (state.phase !== 'ready' || !state.conversationId || !visitorSocket.isConnected()) return;
    void visitorSocket.join(state.conversationId).catch(() => {
      // Non-critical: the send/leave paths tolerate a missing room membership.
    });
  }, [state.phase, state.conversationId, state.socketStatus]);

  useEffect(() => {
    const conversationId = stateRef.current.conversationId;
    return () => {
      if (conversationId) {
        void visitorSocket.leave(conversationId).catch(() => {});
      }
      visitorSocket.disconnect();
    };
  }, []);

  // ------------------------------------------------------------- message sending
  const runSend = useCallback(
    async (pending: PendingMessage) => {
      const session = sessionRef.current;
      if (!session) return;
      dispatch({ type: 'pending:add', pending });
      const outcome = await sendMessage(
        {
          conversationId: pending.conversationId,
          content: pending.content,
          clientMessageId: pending.clientMessageId,
        },
        {
          socket: {
            canSend: () => visitorSocket.isConnected(),
            send: async (payload) => {
              const ack = await visitorSocket.send(payload);
              if (ack === null) {
                return null; // ack lost → REST retry with the same clientMessageId
              }
              return ack.ok
                ? { status: 'ok' as const, message: ack }
                : { status: 'refused' as const, failure: wsFailure(ack.error) };
            },
          },
          rest: restTransport(session.api, session.visitorKey, pending.conversationId),
        },
      );
      if (outcome.result) {
        dispatch({
          type: 'pending:resolve',
          clientMessageId: pending.clientMessageId,
          message: outcome.result.message,
        });
        return;
      }
      if (outcome.failure) {
        if (outcome.failure.code === 'CONVERSATION_CLOSED') {
          void refreshConversation();
        }
        dispatch({
          type: 'pending:fail',
          clientMessageId: pending.clientMessageId,
          error: outcome.failure.message,
        });
      }
    },
    [refreshConversation],
  );

  const handleSend = useCallback(
    (content: string) => {
      const current = stateRef.current;
      if (!current.conversation || current.conversation.status === 'CLOSED') return;
      void runSend(createPending(content, current.conversation.id));
    },
    [runSend],
  );

  const handleRetry = useCallback(
    (clientMessageId: string) => {
      const current = stateRef.current;
      const pending = current.pending.find((p) => p.clientMessageId === clientMessageId);
      if (!pending) return;
      dispatch({ type: 'pending:retry', clientMessageId });
      void runSend(pending);
    },
    [runSend],
  );

  const handleLoadOlder = useCallback(async () => {
    const session = sessionRef.current;
    const current = stateRef.current;
    if (!session || !current.conversationId || !current.nextCursor || current.loadingOlder) return;
    dispatch({ type: 'history:older-start' });
    try {
      const page = await session.api.listMessages(session.visitorKey, current.conversationId, {
        before: current.nextCursor,
        limit: HISTORY_LIMIT,
      });
      dispatch({ type: 'history:older-loaded', messages: page.data, nextCursor: page.nextCursor });
    } catch {
      // Keep the previous cursor so the user can try again.
      dispatch({ type: 'history:older-loaded', messages: [], nextCursor: current.nextCursor });
    }
  }, []);

  const handleStartNew = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) return;
    const previousId = stateRef.current.conversationId;
    try {
      const conversation = await session.api.createConversation(session.visitorKey, {});
      if (previousId) {
        void visitorSocket.leave(previousId).catch(() => {});
      }
      saveStoredConversationId(config.publicKey, conversation.id);
      dispatch({ type: 'chat:start', conversation });
      dispatch({ type: 'history:start' });
      const page = await session.api.listMessages(session.visitorKey, conversation.id, {
        limit: HISTORY_LIMIT,
      });
      dispatch({ type: 'history:loaded', messages: page.data, nextCursor: page.nextCursor });
    } catch {
      // A failed new-conversation request leaves the current thread intact.
    }
  }, [config.publicKey]);

  const handleRetryBoot = useCallback(() => dispatch({ type: 'boot:retry' }), []);

  const handleTogglePanel = useCallback(() => {
    const next = !stateRef.current.showPanel;
    dispatch({ type: 'panel:set', open: next });
  }, []);

  // -------------------------------------------------------------------- render
  const entries = useMemo(
    () => mergeThread(state.messages, state.pending),
    [state.messages, state.pending],
  );
  const pendingSending = state.pending.some((p) => p.status === 'sending');

  return (
    <div className="chatflow-root fixed bottom-4 right-4 z-[2147483647] flex flex-col items-end gap-3">
      {state.showPanel && (
        <Panel
          phase={state.phase}
          bootError={state.bootError}
          socketStatus={state.socketStatus}
          conversation={state.conversation}
          entries={entries}
          nextCursor={state.nextCursor}
          loadingHistory={state.loadingHistory}
          loadingOlder={state.loadingOlder}
          pendingSending={pendingSending}
          onRetryBoot={handleRetryBoot}
          onLoadOlder={() => void handleLoadOlder()}
          onSend={handleSend}
          onRetryPending={handleRetry}
          onStartNew={() => void handleStartNew()}
          onClose={() => dispatch({ type: 'panel:set', open: false })}
        />
      )}
      <Launcher open={state.showPanel} unread={unread} onToggle={handleTogglePanel} />
    </div>
  );
}
