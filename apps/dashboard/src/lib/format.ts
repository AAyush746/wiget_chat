import type { ChatMessage } from '@chatflow/types';

/** Display label for a visitor (used in message threads and inbox rows). */
export function visitorLabel(visitor: { id: string; name: string | null }): string {
  return visitor.name ?? `Visitor ${visitor.id.slice(0, 8)}`;
}

/** Inbox preview: who said what, for the newest message in a conversation. */
export function previewOf(message: ChatMessage | null): string {
  if (!message) {
    return 'No messages yet';
  }
  const author = message.senderType === 'AGENT' ? 'You' : (message.senderName ?? 'Visitor');
  return `${author}: ${message.content}`;
}

function isInvalidDate(d: Date): boolean {
  return Number.isNaN(d.getTime());
}

/** Timestamp for a bubble: time today, date + time otherwise. */
export function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (isInvalidDate(d)) {
    return '';
  }
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const sameDay = d.toDateString() === new Date().toDateString();
  if (sameDay) {
    return time;
  }
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`;
}

/** Relative time for inbox rows ("just now", "5m ago", "2d ago", …). */
export function timeAgo(iso: string): string {
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) {
    return '';
  }
  const deltaMs = Date.now() - at;
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) {
    return 'just now';
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  if (days < 7) {
    return `${days}d ago`;
  }
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
