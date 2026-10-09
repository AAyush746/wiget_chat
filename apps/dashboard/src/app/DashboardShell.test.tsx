import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { AuthUser, PublicWebsite } from '@chatflow/types';
import { DashboardShell } from './DashboardShell';
import { tokenStorage } from '../lib/storage';

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

vi.mock('../lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/api')>();
  return {
    ...original,
    fetchMe: fetchMeMock,
    listAccessibleWebsites: listAccessibleWebsitesMock,
    listConversations: listConversationsMock,
  };
});

const agent: AuthUser = { id: 'u1', email: 'agent@example.com', name: 'Agent One', role: 'AGENT' };

const siteA: PublicWebsite = {
  id: 'w1',
  name: 'Site A',
  domain: 'site-a.example',
  publicKey: 'pk_1',
  isActive: true,
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
});
