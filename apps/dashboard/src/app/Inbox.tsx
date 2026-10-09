import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { ConversationStatus, StaffConversation } from '@chatflow/types';
import { listConversations } from '../lib/api';
import { previewOf, timeAgo, visitorLabel } from '../lib/format';
import { ErrorPanel, LoadingPanel } from './DashboardShell';

const PAGE_SIZE = 20;

type Filter = ConversationStatus | 'ALL';

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'ALL', label: 'All' },
  { value: 'OPEN', label: 'Open' },
  { value: 'PENDING', label: 'Pending' },
  { value: 'CLOSED', label: 'Closed' },
];

const STATUS_BADGE: Record<ConversationStatus, string> = {
  OPEN: 'bg-emerald-50 text-emerald-700',
  PENDING: 'bg-amber-50 text-amber-700',
  CLOSED: 'bg-slate-100 text-slate-500',
};

interface InboxProps {
  websiteId: string | null;
  selectedConversationId: string | null;
  onSelect: (id: string | null) => void;
}

export function Inbox({ websiteId, selectedConversationId, onSelect }: InboxProps) {
  const [filter, setFilter] = useState<Filter>('ALL');
  const [page, setPage] = useState(1);

  useEffect(() => {
    setPage(1);
  }, [websiteId, filter]);

  const conversationsQuery = useQuery({
    queryKey: ['conversations', websiteId, filter, page],
    queryFn: () =>
      listConversations(websiteId as string, {
        status: filter === 'ALL' ? undefined : filter,
        page,
        limit: PAGE_SIZE,
      }),
    enabled: websiteId !== null,
    placeholderData: keepPreviousData,
  });

  if (!websiteId) {
    return <Empty placeholder="Select a website to view its inbox." />;
  }

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-slate-200 px-3 py-2">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Inbox</h2>
          <span className="text-xs text-slate-400">
            {conversationsQuery.data ? `${conversationsQuery.data.total} conversation(s)` : '…'}
          </span>
        </div>
        <div role="group" aria-label="Filter by status" className="mt-2 flex gap-1">
          {FILTERS.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              onClick={() => setFilter(value)}
              aria-pressed={filter === value}
              className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                filter === value
                  ? 'bg-slate-900 text-white'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {conversationsQuery.isLoading ? (
          <LoadingPanel label="Loading conversations…" />
        ) : conversationsQuery.isError ? (
          <ErrorPanel
            title="Could not load conversations"
            detail={conversationsQuery.error.message}
            onRetry={() => void conversationsQuery.refetch()}
          />
        ) : conversationsQuery.data && conversationsQuery.data.data.length === 0 ? (
          <Empty placeholder="No conversations here yet." />
        ) : (
          <ul className="divide-y divide-slate-100">
            {(conversationsQuery.data?.data ?? []).map((row) => (
              <InboxRow
                key={row.id}
                row={row}
                selected={row.id === selectedConversationId}
                onSelect={() => onSelect(row.id)}
              />
            ))}
          </ul>
        )}
      </div>

      <Pager
        page={page}
        onPage={setPage}
        hasMore={(conversationsQuery.data?.total ?? 0) > page * PAGE_SIZE}
      />
    </div>
  );
}

function InboxRow({
  row,
  selected,
  onSelect,
}: {
  row: StaffConversation;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className={`block w-full px-3 py-2.5 text-left ${selected ? 'bg-slate-50 ring-1 ring-inset ring-slate-200' : 'hover:bg-slate-50'}`}
      >
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-sm font-semibold text-slate-800">
            {visitorLabel(row.visitor)}
          </span>
          <time
            className="shrink-0 text-xs text-slate-400"
            dateTime={row.lastMessageAt ?? row.createdAt}
          >
            {timeAgo(row.lastMessageAt ?? row.createdAt)}
          </time>
        </div>
        <p className="mt-0.5 truncate text-sm text-slate-500">{previewOf(row.lastMessage)}</p>
        <div className="mt-1.5">
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${STATUS_BADGE[row.status]}`}
          >
            {row.status}
          </span>
        </div>
      </button>
    </li>
  );
}

function Pager({
  page,
  onPage,
  hasMore,
}: {
  page: number;
  onPage: (page: number) => void;
  hasMore: boolean;
}) {
  return (
    <div className="flex shrink-0 items-center justify-between border-t border-slate-200 px-3 py-2 text-sm">
      <button
        type="button"
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
        className="rounded-md px-2 py-1 text-slate-600 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
      >
        Previous
      </button>
      <span className="text-xs text-slate-400">Page {page}</span>
      <button
        type="button"
        disabled={!hasMore}
        onClick={() => onPage(page + 1)}
        className="rounded-md px-2 py-1 text-slate-600 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
      >
        Next
      </button>
    </div>
  );
}

function Empty({ placeholder }: { placeholder: string }) {
  return (
    <div className="flex min-h-[8rem] items-center justify-center p-4 text-center text-sm text-slate-400">
      {placeholder}
    </div>
  );
}
