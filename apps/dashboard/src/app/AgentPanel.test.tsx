import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { AiAgentStatus, FaqEntry, PublicWebsite } from '@chatflow/types';
import { AgentPanel } from './AgentPanel';
import { ApiError } from '../lib/api';

const getAiAgentStatusMock = vi.hoisted(() => vi.fn());
const updateWebsiteAiMock = vi.hoisted(() => vi.fn());
const listFaqsMock = vi.hoisted(() => vi.fn());
const createFaqMock = vi.hoisted(() => vi.fn());
const updateFaqMock = vi.hoisted(() => vi.fn());
const deleteFaqMock = vi.hoisted(() => vi.fn());

vi.mock('../lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/api')>();
  return {
    ...original,
    getAiAgentStatus: getAiAgentStatusMock,
    updateWebsiteAi: updateWebsiteAiMock,
    listFaqs: listFaqsMock,
    createFaq: createFaqMock,
    updateFaq: updateFaqMock,
    deleteFaq: deleteFaqMock,
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

const status: AiAgentStatus = {
  aiEnabled: false,
  aiFallbackMessage: null,
  provider: 'mock',
  model: 'offline-mock',
  ready: true,
  description: 'Offline keyword mock (no API key configured)',
};

const faq: FaqEntry = {
  id: 'f1',
  websiteId: 'w1',
  question: 'Do you ship internationally?',
  answer: 'Yes, to most countries.',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function renderPanel(onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AgentPanel website={site} onClose={onClose} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getAiAgentStatusMock.mockReset();
  updateWebsiteAiMock.mockReset();
  listFaqsMock.mockReset();
  createFaqMock.mockReset();
  updateFaqMock.mockReset();
  deleteFaqMock.mockReset();
  getAiAgentStatusMock.mockResolvedValue(status);
  listFaqsMock.mockResolvedValue([]);
});

describe('AgentPanel', () => {
  it('shows the connection state, model, and limitations', async () => {
    renderPanel();

    expect(await screen.findByText('Not connected')).toBeInTheDocument();
    expect(screen.getByText('mock · offline-mock')).toBeInTheDocument();
    expect(screen.getByText(/Cannot read:/)).toBeInTheDocument();
  });

  it('connects the agent', async () => {
    updateWebsiteAiMock.mockResolvedValue({ ...site, aiEnabled: true, aiFallbackMessage: 'Hi!' });
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole('button', { name: 'Connect agent' }));

    await waitFor(() =>
      expect(updateWebsiteAiMock).toHaveBeenCalledWith('w1', { aiEnabled: true }),
    );
    expect(await screen.findByText('Connected')).toBeInTheDocument();
  });

  it('saves a trimmed escalation reply', async () => {
    updateWebsiteAiMock.mockResolvedValue({
      ...site,
      aiFallbackMessage: 'We will reply by email.',
    });
    const user = userEvent.setup();
    renderPanel();

    const textarea = await screen.findByLabelText('Escalation reply');
    await user.type(textarea, '  We will reply by email.  ');
    await user.click(screen.getByRole('button', { name: 'Save reply' }));

    await waitFor(() =>
      expect(updateWebsiteAiMock).toHaveBeenCalledWith('w1', {
        aiFallbackMessage: 'We will reply by email.',
      }),
    );
  });

  it('adds a FAQ to the knowledge base', async () => {
    createFaqMock.mockResolvedValue(faq);
    const user = userEvent.setup();
    renderPanel();

    await user.type(await screen.findByLabelText('FAQ question'), faq.question);
    await user.type(screen.getByLabelText('FAQ answer'), faq.answer);
    await user.click(screen.getByRole('button', { name: 'Add FAQ' }));

    await waitFor(() =>
      expect(createFaqMock).toHaveBeenCalledWith('w1', {
        question: faq.question,
        answer: faq.answer,
      }),
    );
  });

  it('surfaces a friendly message when the caller is not an admin', async () => {
    getAiAgentStatusMock.mockRejectedValue(new ApiError(403, 'Forbidden'));
    renderPanel();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Only admins can manage the AI agent.',
    );
  });
});
