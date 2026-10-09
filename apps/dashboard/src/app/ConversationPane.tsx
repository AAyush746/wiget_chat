import { useEffect, useRef, useState, type FormEvent } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ChatMessage,
  ConversationStatus,
  MessageSendResult,
  PublicWebsite,
  StaffConversation,
} from '@chatflow/types';
import { closeConversation, getConversation, listMessages, sendMessageRest } from '../lib/api';
import { formatTimestamp, visitorLabel } from '../lib/format';
import {
  HISTORY_LIMIT,
  MAX_MESSAGE_LENGTH,
  mergeOlderPage,
  sendMessage,
  stateFromPage,
  upsertMessage,
  wsFailure,
  type MessagesState,
  type SendFailure,
} from '../lib/messages';
import { chatSocket } from '../lib/socket';
import { useChatSocketEvents } from '../hooks/useChatSocket';
import { ErrorPanel, LoadingPanel } from './DashboardShell';

interface ConversationPaneProps {
  website: PublicWebsite | null;
  conversationId: string | null;
  onSelectConversation: (id: string | null) => void;
}

export function ConversationPane({
  website,
  conversationId,
  onSelectConversation,
}: ConversationPaneProps) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (website === null || conversationId === null) {
      return;
    }
    void chatSocket.join(conversationId).catch(() => {
      // Transport may be down; REST remains authoritative while offline.
    });
    return () => {
      void chatSocket.leave(conversationId).catch(() => {});
    };
  }, [website, conversationId]);

  // After a reconnect the room membership and message history are stale:
  // rejoin and let REST recompute authoritative state.
  useChatSocketEvents((event) => {
    if (event.type !== 'reconnected' || website === null || conversationId === null) {
      return;
    }
    void chatSocket.join(conversationId).catch(() => {});
    queryClient.resetQueries({ queryKey: ['messages', website.id, conversationId] });
    queryClient.invalidateQueries({ queryKey: ['conversation', website.id, conversationId] });
    queryClient.invalidateQueries({ queryKey: ['conversations', website.id] });
  });

  if (website === null) {
    return <Placeholder text="Select a website to open its inbox." />;
  }
  if (conversationId === null) {
    return <Placeholder text="Select a conversation to view and reply." />;
  }
  return (
    <ConversationBody
      key={`${website.id}:${conversationId}`}
      website={website}
      conversationId={conversationId}
      onBack={() => onSelectConversation(null)}
    />
  );
}

function ConversationBody({
  website,
  conversationId,
  onBack,
}: {
  website: PublicWebsite;
  conversationId: string;
  onBack: () => void;
}) {
  const queryClient = useQueryClient();

  const conversationQuery = useQuery({
    queryKey: ['conversation', website.id, conversationId],
    queryFn: () => getConversation(website.id, conversationId),
  });
  const messagesQuery = useQuery({
    queryKey: ['messages', website.id, conversationId],
    queryFn: async () =>
      stateFromPage(await listMessages(website.id, conversationId, { limit: HISTORY_LIMIT })),
    placeholderData: keepPreviousData,
  });

  const conversation = conversationQuery.data;

  const readOnly = !website.isActive || conversation?.status === 'CLOSED';

  return (
    <div className="flex h-full flex-col">
      <ConversationHeader
        website={website}
        conversationQuery={conversationQuery}
        onBack={onBack}
        onClose={() => {
          queryClient.invalidateQueries({ queryKey: ['conversation', website.id, conversationId] });
          queryClient.invalidateQueries({ queryKey: ['conversations', website.id] });
        }}
      />

      {!website.isActive && (
        <div className="shrink-0 bg-amber-50 px-4 py-1.5 text-center text-xs text-amber-700">
          This website is deactivated — the conversation is read-only.
        </div>
      )}

      <MessageList websiteId={website.id} conversationId={conversationId} query={messagesQuery} />

      <Composer
        website={website}
        conversationId={conversationId}
        disabled={readOnly}
        onSent={(result) => {
          queryClient.setQueryData<MessagesState>(
            ['messages', website.id, conversationId],
            (state) => (state ? upsertMessage(state, result.message) : state),
          );
        }}
      />
    </div>
  );
}

// -------------------------------------------------------------- header

function ConversationHeader({
  website,
  conversationQuery,
  onBack,
  onClose,
}: {
  website: PublicWebsite;
  conversationQuery: ReturnType<typeof useQuery<StaffConversation>>;
  onBack: () => void;
  onClose: () => void;
}) {
  const [closing, setClosing] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);
  const conversation = conversationQuery.data;

  const closeConversation = async () => {
    if (!conversation || conversation.status === 'CLOSED' || closing) {
      return;
    }
    if (
      !window.confirm(
        'Close this conversation? The visitor will no longer be able to send messages to it.',
      )
    ) {
      return;
    }
    setClosing(true);
    setCloseError(null);
    try {
      await closeConversationREST(website.id, conversation.id);
      onClose();
    } catch (err) {
      setCloseError(
        err instanceof Error && err.message ? err.message : 'Could not close the conversation.',
      );
    } finally {
      setClosing(false);
    }
  };

  return (
    <header className="shrink-0 border-b border-slate-200 px-4 py-2.5">
      {conversationQuery.isLoading ? (
        <div className="text-sm text-slate-500">Loading conversation…</div>
      ) : conversationQuery.isError ? (
        <div role="alert" className="flex items-center justify-between gap-2">
          <p className="text-sm text-rose-600">{conversationQuery.error.message}</p>
          <button
            type="button"
            onClick={() => void conversationQuery.refetch()}
            className="text-sm font-medium text-slate-600 hover:text-slate-900"
          >
            Retry
          </button>
        </div>
      ) : conversation ? (
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onBack}
                className="text-sm text-slate-400 hover:text-slate-700"
                aria-label="Back to inbox"
              >
                ←
              </button>
              <h2 className="truncate text-sm font-semibold text-slate-800">
                {visitorLabel(conversation.visitor)}
              </h2>
              <StatusBadge status={conversation.status} closedAt={conversation.closedAt} />
            </div>
            {conversation.visitor.email && (
              <p className="mt-0.5 truncate pl-6 text-xs text-slate-400">
                {conversation.visitor.email}
              </p>
            )}
          </div>
          <button
            type="button"
            disabled={conversation.status === 'CLOSED' || closing || !website.isActive}
            onClick={closeConversation}
            className="shrink-0 rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {closing ? 'Closing…' : conversation.status === 'CLOSED' ? 'Closed' : 'Close'}
          </button>
        </div>
      ) : null}

      {closeError && (
        <p role="alert" className="mt-1 text-xs text-rose-600">
          {closeError}
        </p>
      )}
    </header>
  );
}

// Placeholder for close API result reuse.
async function closeConversationREST(websiteId: string, conversationId: string): Promise<void> {
  await closeConversation(websiteId, conversationId);
}

function StatusBadge({
  status,
  closedAt,
}: {
  status: ConversationStatus;
  closedAt: string | null;
}) {
  const styles: Record<ConversationStatus, string> = {
    OPEN: 'bg-emerald-50 text-emerald-700',
    PENDING: 'bg-amber-50 text-amber-700',
    CLOSED: 'bg-slate-100 text-slate-500',
  };
  const label = status === 'CLOSED' && closedAt ? `Closed ${formatTimestamp(closedAt)}` : status;
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${styles[status]}`}
    >
      {label}
    </span>
  );
}

// ---------------------------------------------------------------- messages

function MessageList({
  websiteId,
  conversationId,
  query,
}: {
  websiteId: string;
  conversationId: string;
  query: ReturnType<typeof useQuery<MessagesState>>;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const [olderBusy, setOlderBusy] = useState(false);
  const queryClient = useQueryClient();

  const handleScroll = () => {
    const el = listRef.current;
    if (!el) {
      return;
    }
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  const messages = dedupe(query.data?.messages ?? []);
  const nextCursor = query.data?.nextCursor ?? null;
  const hasOlder = nextCursor !== null;

  useEffect(() => {
    const el = listRef.current;
    if (el && pinnedRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages.length]);

  const loadOlder = async () => {
    if (!hasOlder || olderBusy) {
      return;
    }
    setOlderBusy(true);
    try {
      const page = await listMessages(websiteId, conversationId, {
        before: nextCursor,
        limit: HISTORY_LIMIT,
      });
      queryClient.setQueryData<MessagesState>(['messages', websiteId, conversationId], (state) =>
        state ? mergeOlderPage(state, page) : state,
      );
    } finally {
      setOlderBusy(false);
    }
  };

  return (
    <div
      ref={listRef}
      onScroll={handleScroll}
      role="log"
      aria-live="polite"
      aria-label="Messages"
      className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
    >
      {query.isLoading ? (
        <LoadingPanel label="Loading messages…" />
      ) : query.isError ? (
        <ErrorPanel
          title="Could not load messages"
          detail={query.error.message}
          onRetry={() => void query.refetch()}
        />
      ) : null}
      <OlderButton hasOlder={hasOlder} busy={olderBusy} onClick={loadOlder} />
      <ol className="space-y-3">
        {messages.map((message) => (
          <MessageBubble key={message.id} message={message} />
        ))}
      </ol>
      {!query.isLoading && !query.isError && messages.length === 0 && (
        <p className="py-6 text-center text-sm text-slate-400">No messages yet.</p>
      )}
    </div>
  );
}

function OlderButton({
  hasOlder,
  busy,
  onClick,
}: {
  hasOlder: boolean;
  busy: boolean;
  onClick: () => void;
}) {
  if (!hasOlder) {
    return null;
  }
  return (
    <div className="mb-2 flex justify-center">
      <button
        type="button"
        disabled={busy}
        onClick={onClick}
        className="rounded-md border border-slate-200 px-2.5 py-1 text-xs text-slate-500 hover:bg-slate-50 disabled:opacity-50"
      >
        {busy ? 'Loading…' : 'Load older messages'}
      </button>
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.senderType === 'SYSTEM') {
    return (
      <li className="flex justify-center">
        <p className="text-center text-xs text-slate-400">{message.content}</p>
      </li>
    );
  }
  const isAgent = message.senderType === 'AGENT';
  return (
    <li className={isAgent ? 'flex justify-end' : 'flex justify-start'}>
      <div
        className={`max-w-[80%] rounded-lg px-3 py-2 text-sm shadow-sm ${
          isAgent
            ? 'rounded-br-sm bg-indigo-600 text-white'
            : 'rounded-bl-sm bg-white text-slate-800 ring-1 ring-slate-200'
        }`}
      >
        <p className="whitespace-pre-wrap break-words">{message.content}</p>
        <div
          className={`mt-1 flex items-center justify-end gap-1.5 text-[10px] ${
            isAgent ? 'text-indigo-200' : 'text-slate-400'
          }`}
        >
          <span>{isAgent ? 'Agent' : (message.senderName ?? 'Visitor')}</span>
          <span>{formatTimestamp(message.createdAt)}</span>
        </div>
      </div>
    </li>
  );
}

/** Defensive: a cache hiccup can never render the same message twice. */
function dedupe(messages: ChatMessage[]): ChatMessage[] {
  const byId = new Map<string, ChatMessage>();
  for (const message of messages) {
    if (!byId.has(message.id)) {
      byId.set(message.id, message);
    }
  }
  return [...byId.values()];
}

// --------------------------------------------------------------- composer

function Composer({
  website,
  conversationId,
  disabled,
  onSent,
}: {
  website: PublicWebsite;
  conversationId: string;
  disabled: boolean;
  onSent: (result: MessageSendResult) => void;
}) {
  const [text, setText] = useState('');
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<SendFailure | null>(null);
  const queryClient = useQueryClient();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const content = text.trim();
    if (!content || pending || disabled) {
      return;
    }
    setPending(true);
    setFailure(null);
    const outcome = await sendMessage(
      { websiteId: website.id, conversationId, content },
      {
        socket: {
          canSend: () => chatSocket.isConnected(),
          send: async (payload) => {
            const ack = await chatSocket.send(payload);
            if (ack === null) {
              return null; // ack lost → REST retry with the same clientMessageId
            }
            return ack.ok
              ? { status: 'ok' as const, message: ack }
              : { status: 'refused' as const, failure: wsFailure(ack.error) };
          },
        },
        rest: {
          send: (payload) =>
            sendMessageRest(website.id, payload.conversationId, {
              content: payload.content,
              clientMessageId: payload.clientMessageId,
            }),
        },
      },
    );
    setPending(false);

    if (outcome.result) {
      setText('');
      onSent(outcome.result);
      return;
    }
    const failure = outcome.failure;
    setFailure(failure);
    if (
      failure &&
      (failure.code === 'CONVERSATION_CLOSED' ||
        failure.code === 'FORBIDDEN' ||
        failure.code === 'NOT_FOUND')
    ) {
      queryClient.invalidateQueries({ queryKey: ['conversation', website.id, conversationId] });
      queryClient.invalidateQueries({ queryKey: ['conversations', website.id] });
    }
  };

  const canSend = text.trim().length > 0 && !pending && !disabled;

  return (
    <form
      onSubmit={submit}
      className="shrink-0 border-t border-slate-200 p-3"
      aria-disabled={disabled}
    >
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            submit(event);
          }
        }}
        disabled={disabled || pending}
        maxLength={MAX_MESSAGE_LENGTH}
        rows={2}
        aria-label="Reply"
        placeholder={
          disabled
            ? conversationClosedPlaceholder(website, disabled)
            : 'Type a reply… (Enter to send)'
        }
        className="block w-full resize-none rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400"
      />
      <div className="mt-2 flex items-center justify-between gap-2">
        {failure ? (
          <p role="alert" className="text-xs text-rose-600">
            {failure.message}
          </p>
        ) : (
          <span className="text-xs text-slate-400">
            {pending ? 'Sending…' : `${MAX_MESSAGE_LENGTH - text.length} characters left`}
          </span>
        )}
        <button
          type="submit"
          disabled={!canSend || pending}
          className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {pending ? 'Sending…' : 'Send'}
        </button>
      </div>
    </form>
  );
}

function conversationClosedPlaceholder(website: PublicWebsite, disabled: boolean): string {
  if (!website.isActive) {
    return 'Read-only — this website is deactivated.';
  }
  return 'This conversation is closed.';
}

function Placeholder({ text }: { text: string }) {
  return (
    <div className="flex h-full items-center justify-center p-6 text-center text-sm text-slate-400">
      {text}
    </div>
  );
}
