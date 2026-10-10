import type { PublicConversation } from '@chatflow/types';
import type { ThreadEntry } from '../lib/messages';
import type { SocketStatus } from '../lib/socket';
import type { WidgetPhase } from '../lib/state';
import { Composer } from './Composer';
import { ClosedNotice } from './MessageBubble';
import { Thread } from './Thread';

interface PanelProps {
  phase: WidgetPhase;
  bootError: string | null;
  socketStatus: SocketStatus;
  conversation: PublicConversation | null;
  entries: ThreadEntry[];
  nextCursor: string | null;
  loadingHistory: boolean;
  loadingOlder: boolean;
  pendingSending: boolean;
  onRetryBoot: () => void;
  onLoadOlder: () => void;
  onSend: (content: string) => void;
  onRetryPending: (clientMessageId: string) => void;
  onStartNew: () => void;
  onClose: () => void;
}

const statusMeta: Record<SocketStatus, { label: string; dot: string }> = {
  connected: { label: 'Online', dot: 'bg-emerald-500' },
  connecting: { label: 'Connecting…', dot: 'bg-amber-400' },
  disconnected: { label: 'Reconnecting…', dot: 'bg-slate-300' },
};

export function Panel(props: PanelProps) {
  const { phase, socketStatus, conversation } = props;
  const status = statusMeta[socketStatus];
  const isClosed = conversation?.status === 'CLOSED';

  return (
    <div
      id="chatflow-panel"
      role="dialog"
      aria-label="ChatFlow support"
      onKeyDown={(event) => {
        if (event.key === 'Escape') props.onClose();
      }}
      className="chatflow-panel flex h-[min(34rem,calc(100dvh-7.5rem))] w-[22.5rem] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white text-slate-800 shadow-2xl shadow-slate-400/30"
    >
      <header className="flex shrink-0 items-center gap-2.5 border-b border-slate-100 bg-white px-4 py-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-indigo-600 text-sm font-bold text-white">
          CF
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-slate-800">ChatFlow Support</p>
          <p className="flex items-center gap-1.5 text-[11px] text-slate-500">
            <span className={`inline-block h-1.5 w-1.5 rounded-full ${status.dot}`} />
            {status.label}
          </p>
        </div>
        <button
          type="button"
          aria-label="Close chat"
          onClick={props.onClose}
          className="flex h-8 w-8 items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
        >
          <svg
            viewBox="0 0 24 24"
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </header>

      {phase === 'error' ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <p className="text-2xl" aria-hidden>
            ⚠️
          </p>
          <p className="text-sm font-medium text-slate-700">We couldn't start the chat.</p>
          <p className="max-w-[18rem] text-xs text-slate-500">{props.bootError}</p>
          <button
            type="button"
            onClick={props.onRetryBoot}
            className="mt-1 rounded-lg bg-indigo-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-indigo-500"
          >
            Try again
          </button>
        </div>
      ) : (
        <Thread
          entries={props.entries}
          nextCursor={props.nextCursor}
          isLoading={props.loadingHistory}
          loadingOlder={props.loadingOlder}
          onLoadOlder={props.onLoadOlder}
          onRetry={props.onRetryPending}
        />
      )}

      {phase !== 'error' && isClosed && (
        <div className="shrink-0 px-3 pb-1">
          <ClosedNotice
            conversation={conversation as PublicConversation}
            onStartNew={props.onStartNew}
          />
        </div>
      )}

      {phase !== 'error' && (
        <Composer
          disabled={phase !== 'ready' || isClosed}
          busy={props.pendingSending}
          onSend={props.onSend}
        />
      )}
    </div>
  );
}
