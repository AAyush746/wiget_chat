import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { AuthUser, PublicWebsite } from '@chatflow/types';
import { DashboardShell } from './DashboardShell';
import { preferences, tokenStorage } from '../lib/storage';

const socketFacade = vi.hoisted(() => {
  return {
    chatSocket: {
      connect: vi.fn(),
      disconnect: vi.fn(),
      getState: () => 'disconnected' as const,
      isConnected: vi.fn(() => false),
      subscribe: vi.fn(() => () => {}),
    },
  };
});

vi.mock('../lib/socket', () => ({ chatSocket: socketFacade.chatSocket }));

const fetchMeMock = vi.hoisted(() => vi.fn());
const listAccessibleWebsitesMock = vi.hoisted(() => vi.fn());
const listConversationsMock = vi.hoisted(() => vi.fn());
const getAiAgentStatusMock = vi.hoisted(() => vi.fn());
const listFaqsMock = vi.hoisted(() => vi.fn());
const getReportOverviewMock = vi.hoisted(() => vi.fn());
const getReportConversationsMock = vi.hoisted(() => vi.fn());

vi.mock('../lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/api')>();
  return {
    ...original,
    fetchMe: fetchMeMock,
    listAccessibleWebsites: listAccessibleWebsitesMock,
    listConversations: listConversationsMock,
    getAiAgentStatus: getAiAgentStatusMock,
    listFaqs: listFaqsMock,
    getReportOverview: getReportOverviewMock,
    getReportConversations: getReportConversationsMock,
  };
});

const agent: AuthUser = { id: 'u1', email: 'agent@example.com', name: 'Agent One', role: 'AGENT' };
const admin: AuthUser = { id: 'u2', email: 'admin@example.com', name: 'Admin One', role: 'ADMIN' };

const siteA: PublicWebsite = {
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

function renderShell(onLogout = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    client,
    onLogout,
    ...render(
      <QueryClientProvider client={client}>
        <DashboardShell onLogout={onLogout} />
      </QueryClientProvider>,
    ),
  };
}

beforeEach(() => {
  window.localStorage.clear();
  tokenStorage.set('token-1');
  fetchMeMock.mockReset();
  listAccessibleWebsitesMock.mockReset();
  listConversationsMock.mockReset();
  getAiAgentStatusMock.mockReset();
  listFaqsMock.mockReset();
  getReportOverviewMock.mockReset();
  getReportConversationsMock.mockReset();
  socketFacade.chatSocket.connect.mockReset();
});

describe('DashboardShell', () => {
  it('renders only the websites the backend authorized for the agent', async () => {
    fetchMeMock.mockResolvedValue(agent);
    listAccessibleWebsitesMock.mockResolvedValue([siteA]);
    listConversationsMock.mockResolvedValue({ data: [], total: 0, page: 1, limit: 20 });

    renderShell();

    expect(await screen.findByText(agent.name ?? agent.email)).toBeInTheDocument();
    expect(screen.getByText('Site A')).toBeInTheDocument();
    expect(screen.queryByText('Site B (secret)')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /AI Agent/ })).not.toBeInTheDocument();
  });

  it('opens exactly one socket for the session using the stored token', async () => {
    fetchMeMock.mockResolvedValue(agent);
    listAccessibleWebsitesMock.mockResolvedValue([siteA]);
    listConversationsMock.mockResolvedValue({ data: [], total: 0, page: 1, limit: 20 });

    renderShell();
    await screen.findByText('Site A');

    expect(socketFacade.chatSocket.connect).toHaveBeenCalledWith('token-1');
  });

  it('logs out when the session is no longer authenticated', async () => {
    const { ApiError } = await import('../lib/api');
    fetchMeMock.mockRejectedValue(new ApiError(401, 'Unauthorized'));
    listAccessibleWebsitesMock.mockResolvedValue([siteA]);
    const { onLogout } = renderShell();

    await waitFor(() => expect(onLogout).toHaveBeenCalled());
  });

  it('shows an empty state when the agent has no websites', async () => {
    fetchMeMock.mockResolvedValue(agent);
    listAccessibleWebsitesMock.mockResolvedValue([]);
    listConversationsMock.mockResolvedValue({ data: [], total: 0, page: 1, limit: 20 });

    renderShell();

    expect(await screen.findByText('No websites available.')).toBeInTheDocument();
  });

  it('switches to the Reports view for the selected website', async () => {
    fetchMeMock.mockResolvedValue(agent);
    listAccessibleWebsitesMock.mockResolvedValue([siteA]);
    listConversationsMock.mockResolvedValue({ data: [], total: 0, page: 1, limit: 20 });
    preferences.setWebsiteId('w1');
    getReportOverviewMock.mockResolvedValue({
      summary: {
        from: '2026-09-10T00:00:00.000Z',
        to: '2026-10-10T00:00:00.000Z',
        conversationsCreated: 7,
        conversationsClosed: 2,
        open: 5,
        pending: 0,
        closed: 2,
        aiHandled: 3,
        handedOff: 1,
        visitorMessages: 10,
        agentMessages: 4,
        aiMessages: 6,
        avgFirstResponseMs: 1000,
        avgResolutionMs: null,
        aiHandlingRate: 0.4286,
        handoffRate: 0.1429,
      },
      timeseries: { from: '', to: '', bucket: 'day', points: [] },
      agents: [],
    });
    getReportConversationsMock.mockResolvedValue({
      from: '',
      to: '',
      total: 0,
      data: [],
    });

    const user = userEvent.setup();
    renderShell();

    await user.click(await screen.findByRole('button', { name: 'Reports' }));

    expect(await screen.findByRole('region', { name: 'Reports' })).toBeInTheDocument();
    expect(await screen.findByText('7')).toBeInTheDocument();
    expect(getReportOverviewMock).toHaveBeenCalledWith('w1', expect.anything());
  });

  it('lets an admin open the Connect Agent panel for the selected website', async () => {
    fetchMeMock.mockResolvedValue(admin);
    listAccessibleWebsitesMock.mockResolvedValue([{ ...siteA, aiEnabled: true }]);
    listConversationsMock.mockResolvedValue({ data: [], total: 0, page: 1, limit: 20 });
    getAiAgentStatusMock.mockResolvedValue({
      aiEnabled: true,
      aiFallbackMessage: null,
      provider: 'mock',
      model: 'offline-mock',
      ready: true,
      description: 'Offline keyword mock',
    });
    listFaqsMock.mockResolvedValue([]);
    preferences.setWebsiteId('w1');

    const user = userEvent.setup();
    renderShell();

    await user.click(await screen.findByRole('button', { name: /AI Agent/ }));

    expect(await screen.findByRole('dialog', { name: 'AI Agent' })).toBeInTheDocument();
    expect(await screen.findByText('Connected')).toBeInTheDocument();
  });
});
