import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AuthUser } from '@chatflow/types';
import { ApiError, fetchMe, listAccessibleWebsites } from '../lib/api';
import { chatSocket, type SocketStatus } from '../lib/socket';
import { useSocketStatus } from '../hooks/useChatSocket';
import { preferences, tokenStorage } from '../lib/storage';
import { RealtimeSync } from './RealtimeSync';
import { WebsiteList } from './WebsiteList';
import { Inbox } from './Inbox';
import { ConversationPane } from './ConversationPane';

interface DashboardShellProps {
  onLogout: () => void;
}

export function DashboardShell({ onLogout }: DashboardShellProps) {
  const status = useSocketStatus();

  const meQuery = useQuery({
    queryKey: ['me'],
    queryFn: fetchMe,
    retry: false,
    staleTime: Infinity,
  });
  const websitesQuery = useQuery({
    queryKey: ['websites'],
    queryFn: listAccessibleWebsites,
    retry: 1,
  });

  // A 401 anywhere means the session is gone: bounce to the login screen.
  useEffect(() => {
    if (meQuery.error instanceof ApiError && meQuery.error.isAuthentication) {
      onLogout();
    }
  }, [meQuery.error, onLogout]);

  // One authenticated socket per session, created on mount and torn down on
  // unmount/logout. Safe under StrictMode double-mounts.
  useEffect(() => {
    const token = tokenStorage.get();
    if (token) {
      chatSocket.connect(token);
    }
    return () => chatSocket.disconnect();
  }, []);

  const [websiteId, setWebsiteId] = useState<string | null>(() => preferences.getWebsiteId());
  const [conversationId, setConversationId] = useState<string | null>(() =>
    preferences.getConversationId(),
  );

  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  const websites = websitesQuery.data ?? [];
  const website = websites.find((w) => w.id === websiteId) ?? null;

  const selectWebsite = (id: string | null) => {
    setWebsiteId(id);
    preferences.setWebsiteId(id);
    setConversationId(null);
    preferences.setConversationId(null);
  };

  const selectConversation = (id: string | null) => {
    setConversationId(id);
    preferences.setConversationId(id);
  };

  return (
    <div className="flex h-screen flex-col bg-slate-100 text-slate-900">
      <header className="flex shrink-0 items-center justify-between border-b border-slate-200 bg-white px-4 py-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">ChatFlow</span>
          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-slate-500">
            staff dashboard
          </span>
        </div>
        <div className="flex items-center gap-3">
          <ConnectionBadge status={status} />
          <span className="hidden text-sm text-slate-600 sm:inline">
            {meQuery.data ? displayName(meQuery.data) : '…'}
          </span>
          <button
            type="button"
            onClick={onLogout}
            className="text-sm font-medium text-slate-500 hover:text-slate-900"
          >
            Log out
          </button>
        </div>
      </header>

      {!online && (
        <div className="shrink-0 bg-rose-50 px-4 py-1 text-center text-xs text-rose-600">
          You're offline. Reconnecting…
        </div>
      )}

      <div className="min-h-0 flex-1 p-px">
        {websitesQuery.isLoading ? (
          <LoadingPanel label="Loading websites…" />
        ) : websitesQuery.isError ? (
          <ErrorPanel
            title="Could not load websites"
            detail={websitesQuery.error.message}
            onRetry={() => void websitesQuery.refetch()}
          />
        ) : (
          <div className="grid h-full min-h-0 gap-px bg-slate-200 lg:grid-cols-[220px_360px_minmax(0,1fr)]">
            <section className="min-h-0 overflow-y-auto bg-white" aria-label="Websites">
              <WebsiteList
                websites={websites}
                selectedId={website?.id ?? null}
                onSelect={selectWebsite}
              />
            </section>
            <section className="min-h-0 overflow-y-auto bg-white" aria-label="Inbox">
              <Inbox
                websiteId={website?.id ?? null}
                selectedConversationId={conversationId}
                onSelect={selectConversation}
              />
            </section>
            <section className="min-h-0 overflow-hidden bg-white" aria-label="Conversation">
              <ConversationPane
                website={website}
                conversationId={conversationId}
                onSelectConversation={selectConversation}
              />
            </section>
          </div>
        )}
      </div>

      <RealtimeSync websiteId={website?.id ?? null} />
    </div>
  );
}

function displayName(user: AuthUser): string {
  return user.name ?? user.email;
}

function ConnectionBadge({ status }: { status: SocketStatus }) {
  const label =
    status === 'connected' ? 'Connected' : status === 'connecting' ? 'Connecting…' : 'Disconnected';
  const dot =
    status === 'connected'
      ? 'bg-emerald-500'
      : status === 'connecting'
        ? 'animate-pulse bg-amber-500'
        : 'bg-slate-300';
  return (
    <span className="flex items-center gap-1.5 text-xs text-slate-500">
      <span className={`size-2 rounded-full ${dot}`} aria-hidden="true" />
      {label}
    </span>
  );
}

export function LoadingPanel({ label }: { label: string }) {
  return (
    <div className="flex h-full min-h-[12rem] items-center justify-center text-sm text-slate-500">
      {label}
    </div>
  );
}

export function ErrorPanel({
  title,
  detail,
  onRetry,
}: {
  title: string;
  detail?: string;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex h-full min-h-[12rem] flex-col items-center justify-center gap-3 p-4 text-center"
    >
      <p className="text-sm font-medium text-slate-800">{title}</p>
      {detail && <p className="max-w-md text-sm text-slate-500">{detail}</p>}
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Retry
        </button>
      )}
    </div>
  );
}
