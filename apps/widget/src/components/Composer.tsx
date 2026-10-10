import { useEffect, useRef, useState } from 'react';
import { MAX_MESSAGE_LENGTH } from '../lib/messages';

interface ComposerProps {
  disabled: boolean;
  busy: boolean;
  onSend: (content: string) => void;
}

export function Composer({ disabled, busy, onSend }: ComposerProps) {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const trimmed = value.trim();
  const canSend = !disabled && !busy && trimmed.length > 0 && trimmed.length <= MAX_MESSAGE_LENGTH;

  const submit = () => {
    if (!canSend) return;
    onSend(trimmed);
    setValue('');
    textareaRef.current?.focus();
  };

  useEffect(() => {
    if (!disabled) textareaRef.current?.focus();
  }, [disabled]);

  return (
    <div className="shrink-0 border-t border-slate-100 bg-white px-3 py-2.5">
      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          rows={1}
          value={value}
          disabled={disabled}
          placeholder={disabled ? 'Conversation is closed' : 'Type your message…'}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          maxLength={MAX_MESSAGE_LENGTH}
          aria-label="Message"
          className="max-h-32 min-h-[2.25rem] flex-1 resize-none rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-indigo-400 focus:bg-white focus:outline-none focus:ring-1 focus:ring-indigo-300 disabled:bg-slate-50 disabled:text-slate-400"
        />
        <button
          type="button"
          onClick={submit}
          disabled={!canSend}
          aria-label="Send message"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden>
            <path d="M3.478 2.405a.75.75 0 00-.926.94l2.432 7.905H13.5a.75.75 0 010 1.5H4.984l-2.432 7.905a.75.75 0 00.926.94 60.519 60.519 0 0018.445-8.986.75.75 0 000-1.218A60.517 60.517 0 003.478 2.405z" />
          </svg>
        </button>
      </div>
      {trimmed.length > MAX_MESSAGE_LENGTH && (
        <p className="mt-1 text-right text-[11px] text-rose-500">
          Message is too long ({trimmed.length}/{MAX_MESSAGE_LENGTH}).
        </p>
      )}
    </div>
  );
}
