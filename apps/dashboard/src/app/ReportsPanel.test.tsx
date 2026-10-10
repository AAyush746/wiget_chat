import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { PublicWebsite, ReportOverview } from '@chatflow/types';
import { ReportsPanel } from './ReportsPanel';
import { ApiError } from '../lib/api';

const getReportOverviewMock = vi.hoisted(() => vi.fn());
const getReportConversationsMock = vi.hoisted(() => vi.fn());

vi.mock('../lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/api')>();
  return {
    ...original,
    getReportOverview: getReportOverviewMock,
    getReportConversations: getReportConversationsMock,
  };
});

const site: PublicWebsite = {
  id: 'w1',
  name: 'Site A',
  domain: 'site-a.example',
  publicKey: 'pk_1',
  isActive: true,
  aiEnabled: false,
  aiFallbackMessage: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const overview: ReportOverview = {
  summary: {
    from: '2026-09-10T00:00:00.000Z',
    to: '2026-10-10T00:00:00.000Z',
    conversationsCreated: 42,
    conversationsClosed: 30,
    open: 9,
    pending: 3,
    closed: 30,
    aiHandled: 21,
    handedOff: 8,
    visitorMessages: 120,
    agentMessages: 64,
    aiMessages: 55,
    avgFirstResponseMs: 90_000,
    avgResolutionMs: 7_200_000,
    aiHandlingRate: 0.5,
    handoffRate: 0.1905,
  },
  timeseries: {
    from: '2026-09-10T00:00:00.000Z',
    to: '2026-10-10T00:00:00.000Z',
    bucket: 'day',
    points: [
      {
        bucket: '2026-10-09T00:00:00.000Z',
        conversationsCreated: 2,
        conversationsClosed: 1,
        visitorMessages: 3,
        agentMessages: 2,
        aiMessages: 1,
      },
    ],
  },
  agents: [
    {
      userId: 'u1',
      name: 'Alice',
      email: 'alice@example.com',
      assigned: 12,
      resolved: 10,
      currentlyOpen: 2,
      reassignedAway: 1,
      agentMessages: 40,
      avgFirstResponseMs: 65_000,
    },
  ],
};

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ReportsPanel website={site} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getReportOverviewMock.mockReset();
  getReportConversationsMock.mockReset();
  getReportOverviewMock.mockResolvedValue(overview);
  getReportConversationsMock.mockResolvedValue({
    from: overview.summary.from,
    to: overview.summary.to,
    total: 0,
    data: [],
  });
});

describe('ReportsPanel', () => {
  it('renders the headline KPIs', async () => {
    renderPanel();

    expect(await screen.findByText('42')).toBeInTheDocument();
    expect(screen.getByText('Conversations')).toBeInTheDocument();
    expect(screen.getByText('1m 30s')).toBeInTheDocument(); // avg first response
    expect(screen.getByText('50.0%')).toBeInTheDocument(); // AI handling rate
  });

  it('renders the agent performance table', async () => {
    renderPanel();

    expect(await screen.findByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument(); // assigned
    expect(screen.getByText('10')).toBeInTheDocument(); // resolved
  });

  it('labels the volume chart with its bucket', async () => {
    renderPanel();

    expect(await screen.findByRole('img', { name: 'Conversations per day' })).toBeInTheDocument();
  });

  it('re-queries when the reporting period changes', async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText('42');

    const before = getReportOverviewMock.mock.calls.length;
    await user.click(screen.getByRole('button', { name: '7 days' }));

    await waitFor(() => expect(getReportOverviewMock.mock.calls.length).toBeGreaterThan(before));
    const lastCall = getReportOverviewMock.mock.calls.at(-1)?.[1] as { from: string };
    const spanDays = (Date.now() - new Date(lastCall.from).getTime()) / 86_400_000;
    expect(spanDays).toBeGreaterThan(6);
    expect(spanDays).toBeLessThan(8);
  });

  it('explains a permission failure', async () => {
    getReportOverviewMock.mockRejectedValue(new ApiError(403, 'Forbidden'));
    renderPanel();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'You do not have access to reports for this website.',
    );
  });
});
