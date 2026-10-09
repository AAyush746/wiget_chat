import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { PublicWebsite, StaffConversation } from '@chatflow/types';
import { ConversationPane } from './ConversationPane';

const socketFacade = vi.hoisted(() => {
  const listeners = new Set<(event: unknown) => void>();
  return {
    chatSocket: {
      connect: vi.fn(),
      disconnect: vi.fn(),
      getState: () => 'disconnected' as const,
      isConnected: vi.fn(() => true),
      send: vi.fn(),
      join: vi.fn().mockResolvedValue({ ok: true }),
      leave: vi.fn().mockResolvedValue({ ok: true }),
      subscribe(cb: (event: unknown) => void): () => void {
        listeners.add(cb);
        return () => {
          listeners.delete(cb);
        };
      },
      _emit(event: unknown) {
        for (const cb of listeners) cb(event);
      },
    },
  };
});

vi.mock('../lib/socket', () => ({ chatSocket: socketFacade.chatSocket }));

const getConversationMock = vi.hoisted(() => vi.fn());
const listMessagesMock = vi.hoisted(() => vi.fn());
const sendMessageRestMock = vi.hoisted(() => vi.fn());
const closeConversationMock = vi.hoisted(() => vi.fn());

vi.mock('../lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/api')>();
  return {
    ...original,
    getConversation: getConversationMock,
    listMessages: listMessagesMock,
    sendMessageRest: sendMessageRestMock,
    closeConversation: closeConversationMock,
  };
});

const website: PublicWebsite = {
  id: 'w1',
  name: 'Site A',
  domain: 'site-a.example',
  publicKey: 'pk_1',
  isActive: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const openConversation: StaffConversation = {
  id: 'c1',
  status: 'OPEN',
  subject: null,
  createdAt: '2026-10-09T09:00:00.000Z',
  updatedAt: '2026-10-09T09:00:00.000Z',
  lastMessageAt: '2026-10-09T10:00:00.000Z',
  closedAt: null,
  visitor: {
    id: 'v1',
    name: 'Aria',
    email: 'aria@example.com',
    lastSeenAt: '2026-10-09T10:00:00.000Z',
  },
  lastMessage: null,
};

const visitorMessage = (id: string, content: string) => ({
  id,
  conversationId: 'c1',
  senderType: 'VISITOR' as const,
  senderName: 'Aria',
  content,
  clientMessageId: null,
  createdAt: '2026-10-09T10:00:00.000Z',
});

function renderPane(
  props: {
    website?: PublicWebsite | null;
    conversationId?: string | null;
    onSelectConversation?: (id: string | null) => void;
  } = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={client}>
      <ConversationPane
        website={props.website !== undefined ? props.website : website}
        conversationId={props.conversationId !== undefined ? props.conversationId : 'c1'}
        onSelectConversation={props.onSelectConversation ?? (() => {})}
      />
    </QueryClientProvider>,
  );
  return { client, ...result };
}

beforeEach(() => {
  getConversationMock.mockReset();
  listMessagesMock.mockReset();
  sendMessageRestMock.mockReset();
  closeConversationMock.mockReset();
  socketFacade.chatSocket.send.mockReset();
  socketFacade.chatSocket.join.mockReset();
  socketFacade.chatSocket.join.mockResolvedValue({ ok: true });
  socketFacade.chatSocket.leave.mockReset();
  socketFacade.chatSocket.leave.mockResolvedValue({ ok: true });
  socketFacade.chatSocket.isConnected.mockReturnValue(true);
});

describe('ConversationPane', () => {
  it('prompts for a website/conversation when nothing is selected', () => {
    renderPane({ website: null, conversationId: null });
    expect(screen.getByText('Select a website to open its inbox.')).toBeInTheDocument();
  });

  it('loads and renders message history from REST', async () => {
    getConversationMock.mockResolvedValue(openConversation);
    listMessagesMock.mockResolvedValue({
      data: [visitorMessage('m1', 'hello there')],
      nextCursor: null,
      limit: 50,
    });
    renderPane();

    expect(await screen.findByText('hello there')).toBeInTheDocument();
    expect(listMessagesMock).toHaveBeenCalledWith('w1', 'c1', { limit: 50 });
  });

  it('sends over the socket and renders the server-confirmed message', async () => {
    getConversationMock.mockResolvedValue(openConversation);
    listMessagesMock.mockResolvedValue({ data: [], nextCursor: null, limit: 50 });
    const agentReply = {
      ...visitorMessage('m9', 'replying now'),
      senderType: 'AGENT' as const,
      senderName: null,
    };
    socketFacade.chatSocket.send.mockResolvedValue({
      ok: true,
      message: agentReply,
      replay: false,
    });

    const user = userEvent.setup();
    renderPane();

    const textarea = await screen.findByLabelText('Reply');
    await user.type(textarea, 'replying now');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(socketFacade.chatSocket.send).toHaveBeenCalledOnce());
    expect(sendMessageRestMock).not.toHaveBeenCalled();
    // The textarea cleared and left exactly one bubble with the reply text.
    expect(screen.getAllByText('replying now')).toHaveLength(1);
    expect(textarea).toHaveValue('');
  });

  it('falls back to REST with the same clientMessageId when the ack is lost', async () => {
    getConversationMock.mockResolvedValue(openConversation);
    listMessagesMock.mockResolvedValue({ data: [], nextCursor: null, limit: 50 });
    socketFacade.chatSocket.send.mockResolvedValue(null); // ack dropped
    sendMessageRestMock.mockResolvedValue({
      message: {
        ...visitorMessage('m10', 'resilient message'),
        senderType: 'AGENT',
        senderName: null,
      },
      replay: false,
    });

    const user = userEvent.setup();
    renderPane();

    const textarea = await screen.findByLabelText('Reply');
    await user.type(textarea, 'resilient message');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('resilient message')).toBeInTheDocument();

    const socketPayload = socketFacade.chatSocket.send.mock.calls[0]![0]!;
    const restPayload = sendMessageRestMock.mock.calls[0]![2] as { clientMessageId: string };
    expect(restPayload.clientMessageId).toBe(socketPayload.clientMessageId);
  });

  it('shows the server-insisted closed state and disables the composer', async () => {
    getConversationMock.mockResolvedValue({
      ...openConversation,
      status: 'CLOSED',
      closedAt: '2026-10-09T11:00:00.000Z',
    });
    listMessagesMock.mockResolvedValue({ data: [], nextCursor: null, limit: 50 });

    const { container } = renderPane();

    // Wait for the conversation query to land so the composer adopts the
    // server-insisted CLOSED state (read-only, placeholder, disabled).
    await screen.findByRole('button', { name: 'Closed' });
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea).toBeDisabled();
    expect(screen.getByPlaceholderText('This conversation is closed.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Closed' })).toBeDisabled();
  });

  it('renders deactivated websites read-only', async () => {
    getConversationMock.mockResolvedValue(openConversation);
    listMessagesMock.mockResolvedValue({ data: [], nextCursor: null, limit: 50 });

    const { container } = renderPane({ website: { ...website, isActive: false } });

    await screen.findByText(/this website is deactivated/i);
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea).toBeDisabled();
  });

  it('paginates older messages by merging into the loaded state', async () => {
    getConversationMock.mockResolvedValue(openConversation);
    listMessagesMock
      .mockResolvedValueOnce({
        data: [visitorMessage('m2', 'newest')],
        nextCursor: 'cursor-1',
        limit: 50,
      })
      .mockResolvedValueOnce({
        data: [visitorMessage('m1', 'oldest')],
        nextCursor: null,
        limit: 50,
      });

    const user = userEvent.setup();
    renderPane();

    await screen.findByText('newest');
    await user.click(screen.getByRole('button', { name: 'Load older messages' }));

    expect(await screen.findByText('oldest')).toBeInTheDocument();
    expect(listMessagesMock).toHaveBeenLastCalledWith('w1', 'c1', {
      before: 'cursor-1',
      limit: 50,
    });
  });
});
