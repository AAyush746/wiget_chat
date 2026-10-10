import { useMemo, useState } from 'react';
import { useMutation, useQuery, type UseQueryResult } from '@tanstack/react-query';
import type {
  PublicWebsite,
  ReportConversations,
  ReportOverview,
  ReportTimeseriesPoint,
} from '@chatflow/types';
import { ApiError, downloadReportCsv, getReportConversations, getReportOverview } from '../lib/api';

type RangeKey = '7d' | '30d' | '90d';

const RANGES: Array<{ key: RangeKey; label: string; days: number }> = [
  { key: '7d', label: '7 days', days: 7 },
  { key: '30d', label: '30 days', days: 30 },
  { key: '90d', label: '90 days', days: 90 },
];

/**
 * Reporting surface. Deliberately chart-library-free: the volume series is a
 * plain CSS bar chart, which keeps the dashboard bundle small and renders
 * correctly in jsdom-based tests without a canvas shim.
 */
export function ReportsPanel({ website }: { website: PublicWebsite }) {
  const [range, setRange] = useState<RangeKey>('30d');
  const [error, setError] = useState<string | null>(null);

  const days = RANGES.find((r) => r.key === range)?.days ?? 30;
  const from = useMemo(() => new Date(Date.now() - days * 864e5).toISOString(), [days]);

  const overviewQuery = useQuery({
    queryKey: ['report-overview', website.id, range],
    queryFn: () => getReportOverview(website.id, { from }),
  });

  const rowsQuery = useQuery({
    queryKey: ['report-conversations', website.id, range],
    queryFn: () => getReportConversations(website.id, { from, limit: 25 }),
    enabled: overviewQuery.isSuccess,
  });

  const exportCsv = useMutation({
    mutationFn: () => downloadReportCsv(website.id, { from }),
    onSuccess: () => setError(null),
    onError: () => setError('Could not export the report as CSV.'),
  });

  const overview = overviewQuery.data;
  const isLoading = overviewQuery.isLoading;
  const loadError = overviewQuery.isError ? describe(overviewQuery.error) : null;

  return (
    <section aria-label="Reports" className="flex-1 overflow-y-auto bg-slate-50 p-4">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-800">Reports</h2>
          <p className="text-xs text-slate-500">
            {website.name} · activity from {from.slice(0, 10)} to today
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div
            role="group"
            aria-label="Reporting period"
            className="flex rounded-md border border-slate-300"
          >
            {RANGES.map((option) => (
              <button
                key={option.key}
                type="button"
                aria-pressed={range === option.key}
                onClick={() => setRange(option.key)}
                className={`px-2.5 py-1 text-xs font-medium ${
                  range === option.key
                    ? 'rounded-l-md bg-slate-900 text-white'
                    : 'text-slate-600 hover:bg-slate-50'
                } ${option === RANGES[RANGES.length - 1] ? 'rounded-r-md' : ''}`}
              >
                {option.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            disabled={exportCsv.isPending || isLoading}
            onClick={() => exportCsv.mutate()}
            className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-white disabled:opacity-40"
          >
            {exportCsv.isPending ? 'Exporting…' : 'Export CSV'}
          </button>
        </div>
      </header>

      {error && (
        <p
          role="alert"
          className="mb-3 rounded-md border border-rose-100 bg-rose-50 px-3 py-2 text-xs text-rose-600"
        >
          {error}
        </p>
      )}
      {loadError && (
        <p
          role="alert"
          className="rounded-md border border-rose-100 bg-rose-50 px-3 py-2 text-sm text-rose-600"
        >
          {loadError}
        </p>
      )}

      {isLoading && <p className="text-sm text-slate-500">Loading report…</p>}

      {overview && (
        <div className="space-y-4">
          <KpiGrid summary={overview.summary} />

          <section
            aria-label="Conversation volume"
            className="rounded-lg border border-slate-200 bg-white p-3"
          >
            <h3 className="text-sm font-medium text-slate-800">Conversation volume</h3>
            <VolumeChart points={overview.timeseries.points} bucket={overview.timeseries.bucket} />
          </section>

          <AgentTable rows={overview.agents} />

          <ConversationTable query={rowsQuery} />
        </div>
      )}
    </section>
  );
}

function KpiGrid({ summary }: { summary: ReportOverview['summary'] }) {
  const cards: Array<{ label: string; value: string; hint?: string }> = [
    {
      label: 'Conversations',
      value: String(summary.conversationsCreated),
      hint: `${summary.conversationsClosed} closed`,
    },
    { label: 'Currently open', value: String(summary.open), hint: `${summary.pending} pending` },
    {
      label: 'Avg first response',
      value: formatDuration(summary.avgFirstResponseMs),
      hint: 'visitor → human',
    },
    {
      label: 'Avg resolution',
      value: formatDuration(summary.avgResolutionMs),
      hint: 'created → closed',
    },
    {
      label: 'AI handled',
      value: percent(summary.aiHandlingRate),
      hint: `${summary.aiMessages} AI messages`,
    },
    {
      label: 'Handed off',
      value: percent(summary.handoffRate),
      hint: `${summary.handedOff} escalated`,
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      {cards.map((card) => (
        <div key={card.label} className="rounded-lg border border-slate-200 bg-white p-3">
          <p className="text-xs text-slate-500">{card.label}</p>
          <p className="mt-1 text-lg font-semibold text-slate-800">{card.value}</p>
          {card.hint && <p className="text-[11px] text-slate-400">{card.hint}</p>}
        </div>
      ))}
    </div>
  );
}

function VolumeChart({ points, bucket }: { points: ReportTimeseriesPoint[]; bucket: string }) {
  // An empty stretch is normal (a quiet day), so the series renders gaps rather
  // than pretending the axis starts at the first non-zero bucket.
  const visible = points.slice(-60);
  const max = Math.max(1, ...visible.map((p) => p.conversationsCreated));

  if (visible.length === 0) {
    return <p className="mt-2 text-xs text-slate-400">No activity in this period.</p>;
  }

  return (
    <div className="mt-3">
      <div
        className="flex h-28 items-end gap-px"
        role="img"
        aria-label={`Conversations per ${bucket}`}
      >
        {visible.map((point) => {
          const height = Math.round((point.conversationsCreated / max) * 100);
          const label = `${point.bucket.slice(0, 10)}: ${point.conversationsCreated} conversations`;
          return (
            <div
              key={point.bucket}
              title={label}
              className="min-w-[3px] flex-1 rounded-t bg-indigo-400"
              style={{ height: `${Math.max(height, point.conversationsCreated > 0 ? 4 : 1)}%` }}
            >
              <span className="sr-only">{label}</span>
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-slate-400">
        <span>{visible[0]?.bucket.slice(0, 10)}</span>
        <span>{visible[visible.length - 1]?.bucket.slice(0, 10)}</span>
      </div>
    </div>
  );
}

function AgentTable({ rows }: { rows: ReportOverview['agents'] }) {
  return (
    <section
      aria-label="Agent performance"
      className="rounded-lg border border-slate-200 bg-white p-3"
    >
      <h3 className="text-sm font-medium text-slate-800">Agent performance</h3>
      {rows.length === 0 ? (
        <p className="mt-2 text-xs text-slate-400">No assignments in this period.</p>
      ) : (
        <table className="mt-2 w-full text-left text-xs">
          <thead className="text-slate-400">
            <tr>
              <th scope="col" className="py-1">
                Agent
              </th>
              <th scope="col" className="py-1 text-right">
                Assigned
              </th>
              <th scope="col" className="py-1 text-right">
                Resolved
              </th>
              <th scope="col" className="py-1 text-right">
                Open
              </th>
              <th scope="col" className="py-1 text-right">
                Reassigned away
              </th>
              <th scope="col" className="py-1 text-right">
                Avg first reply
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.userId} className="border-t border-slate-100">
                <th scope="row" className="py-1.5 font-medium text-slate-700">
                  {row.name}
                </th>
                <td className="py-1.5 text-right text-slate-600">{row.assigned}</td>
                <td className="py-1.5 text-right text-slate-600">{row.resolved}</td>
                <td className="py-1.5 text-right text-slate-600">{row.currentlyOpen}</td>
                <td className="py-1.5 text-right text-slate-600">{row.reassignedAway}</td>
                <td className="py-1.5 text-right text-slate-600">
                  {formatDuration(row.avgFirstResponseMs)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function ConversationTable({ query }: { query: UseQueryResult<ReportConversations, Error> }) {
  const rows = query.data?.data ?? [];
  if (query.isLoading) {
    return <p className="text-xs text-slate-400">Loading conversations…</p>;
  }
  if (rows.length === 0) {
    return (
      <section
        aria-label="Recent conversations"
        className="rounded-lg border border-slate-200 bg-white p-3"
      >
        <p className="text-xs text-slate-400">No conversations in this period.</p>
      </section>
    );
  }
  return (
    <section
      aria-label="Recent conversations"
      className="rounded-lg border border-slate-200 bg-white p-3"
    >
      <h3 className="text-sm font-medium text-slate-800">Recent conversations</h3>
      <table className="mt-2 w-full text-left text-xs">
        <thead className="text-slate-400">
          <tr>
            <th scope="col" className="py-1">
              Started
            </th>
            <th scope="col" className="py-1">
              Visitor
            </th>
            <th scope="col" className="py-1">
              Agent
            </th>
            <th scope="col" className="py-1">
              Status
            </th>
            <th scope="col" className="py-1 text-right">
              Messages
            </th>
            <th scope="col" className="py-1 text-right">
              First reply
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-t border-slate-100">
              <td className="py-1.5 text-slate-600">
                {row.createdAt.slice(0, 16).replace('T', ' ')}
              </td>
              <td className="py-1.5 text-slate-700">
                {row.visitorName ?? row.visitorEmail ?? 'Visitor'}
              </td>
              <td className="py-1.5 text-slate-600">{row.assignedAgentName ?? '—'}</td>
              <td className="py-1.5 text-slate-600">{row.status}</td>
              <td className="py-1.5 text-right text-slate-600">{row.messageCount}</td>
              <td className="py-1.5 text-right text-slate-600">
                {formatDuration(row.firstResponseMs)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function percent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function describe(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.isForbidden) return 'You do not have access to reports for this website.';
    if (error.status === 404) return 'That website no longer exists.';
    return error.message;
  }
  return 'Could not load the report.';
}
