import type { ThreadEntry } from '../lib/messages';
import { MessageBubble, PendingBubble } from './MessageBubble';

export interface ThreadProps {
  entries: ThreadEntry[];
  nextCursor: string | null;
  isLoading: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  onRetry: (clientMessageId: string) => void;
}

export function Thread({
  entries,
  nextCursor,
  isLoading,
  loadingOlder,
  onLoadOlder,
  onRetry,
}: ThreadProps) {
  if (isLoading) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-slate-400">
        <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-slate-300 border-t-indigo-500" />
        <p className="text-xs">Loading conversation…</p>
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-8 text-center">
        <div
          className="flex h-12 w-12 items-center justify-center rounded-full bg-indigo-50 text-xl"
          role="img"
          aria-label="Chat"
        >
          💬
        </div>
        <div>
          <p className="text-sm font-semibold text-slate-700">Welcome! 👋</p>
          <p className="mt-1 max-w-[16rem] text-xs leading-relaxed text-slate-500">
            Ask us anything about your order, delivery or products. A support agent will reply here
            in real time.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-3 overflow-y-auto py-4 scrollbar-thin">
      {nextCursor && (
        <div className="flex justify-center px-4">
          <button
            type="button"
            onClick={onLoadOlder}
            disabled={loadingOlder}
            className="rounded-full border border-slate-200 bg-white px-3 py-1 text-[11px] font-medium text-slate-500 transition hover:bg-slate-50 disabled:opacity-50"
          >
            {loadingOlder ? 'Loading…' : 'Load older messages'}
          </button>
        </div>
      )}
      {entries.map((entry) =>
        entry.kind === 'pending' ? (
          <PendingBubble
            key={`pending:${entry.pending.clientMessageId}`}
            content={entry.pending.content}
            createdAt={entry.pending.createdAt}
            status={entry.pending.status}
            error={entry.pending.error}
            onRetry={
              entry.pending.status === 'error'
                ? () => onRetry(entry.pending.clientMessageId)
                : undefined
            }
          />
        ) : (
          <MessageBubble
            key={entry.message.id}
            message={entry.message}
            isOwn={entry.message.senderType === 'VISITOR'}
          />
        ),
      )}
    </div>
  );
}
