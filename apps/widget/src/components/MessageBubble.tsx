import type { ChatMessage, PublicConversation } from '@chatflow/types';
import { formatMessageTime } from '../lib/format';

interface MessageBubbleProps {
  message: ChatMessage;
  isOwn: boolean;
}

export function MessageBubble({ message, isOwn }: MessageBubbleProps) {
  if (message.senderType === 'SYSTEM') {
    return (
      <div className="flex justify-center px-4">
        <p className="max-w-[85%] rounded-lg bg-slate-100 px-3 py-1 text-center text-[11px] font-medium text-slate-500">
          {message.content}
        </p>
      </div>
    );
  }

  const showName =
    !isOwn &&
    (message.senderType === 'AGENT' || message.senderType === 'AI') &&
    !!message.senderName;
  return (
    <div className={`flex ${isOwn ? 'justify-end' : 'justify-start'} px-4`}>
      <div
        className={`max-w-[82%] rounded-2xl px-3.5 py-2 text-sm shadow-sm ${
          isOwn
            ? 'rounded-br-md bg-indigo-600 text-white'
            : 'rounded-bl-md bg-slate-100 text-slate-800'
        }`}
      >
        {showName && (
          <p className="mb-0.5 text-[11px] font-semibold text-indigo-500">{message.senderName}</p>
        )}
        <p className="whitespace-pre-wrap break-words leading-relaxed">{message.content}</p>
        <p className={`mt-1 text-[10px] ${isOwn ? 'text-indigo-200' : 'text-slate-400'}`}>
          {formatMessageTime(message.createdAt)}
        </p>
      </div>
    </div>
  );
}

interface PendingBubbleProps {
  content: string;
  createdAt: string;
  status: 'sending' | 'error';
  error: string | null;
  onRetry?: () => void;
}

export function PendingBubble({ content, createdAt, status, error, onRetry }: PendingBubbleProps) {
  return (
    <div className="flex justify-end px-4">
      <div
        className={`max-w-[82%] rounded-2xl rounded-br-md px-3.5 py-2 text-sm shadow-sm ${
          status === 'error'
            ? 'border border-rose-300 bg-rose-50 text-rose-800'
            : 'bg-indigo-100 text-indigo-900'
        }`}
      >
        <p className="whitespace-pre-wrap break-words leading-relaxed">{content}</p>
        <div className="mt-1 flex items-center gap-2 text-[10px] text-slate-500">
          {status === 'sending' ? (
            <>
              <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-indigo-400 border-t-transparent" />
              <span className="italic">Sending…</span>
            </>
          ) : (
            <>
              <span className="font-medium text-rose-500">Not sent</span>
              {error && <span className="italic">{error}</span>}
              {onRetry && (
                <button
                  type="button"
                  onClick={onRetry}
                  className="rounded-md border border-rose-300 bg-white px-1.5 py-0.5 text-[10px] font-semibold text-rose-600 transition hover:bg-rose-100"
                >
                  Retry
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function ClosedNotice({
  conversation,
  onStartNew,
}: {
  conversation: PublicConversation;
  onStartNew: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-5 py-4 text-center">
      <p className="text-sm font-medium text-slate-600">
        This conversation is closed on{' '}
        {formatMessageTime(conversation.closedAt ?? conversation.updatedAt)}.
      </p>
      <p className="text-xs text-slate-400">You can still read the history below.</p>
      <button
        type="button"
        onClick={onStartNew}
        className="mt-1 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-indigo-500"
      >
        Start a new conversation
      </button>
    </div>
  );
}
