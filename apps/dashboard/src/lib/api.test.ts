import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  assignConversation,
  claimConversation,
  closeConversation,
  listAssignableAgents,
  listAssignments,
  listConversations,
  login,
  sendMessageRest,
} from './api';
import { tokenStorage } from './storage';

const fetchMock = vi.hoisted(() => vi.fn());

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  window.localStorage.clear();
  tokenStorage.set('token-1');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('ApiError', () => {
  it('exposes convenience predicates', () => {
    expect(new ApiError(401, '').isAuthentication).toBe(true);
    expect(new ApiError(403, '').isForbidden).toBe(true);
    expect(new ApiError(409, '').isConflict).toBe(true);
    expect(new ApiError(429, '').isRateLimited).toBe(true);
    expect(new ApiError(404, '').isAuthentication).toBe(false);
  });
});

describe('request pipeline', () => {
  it('attaches the bearer token and parses JSON', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, [{ id: 'w1' }]));

    const { listAccessibleWebsites } = await import('./api');
    const body = await listAccessibleWebsites();

    expect(fetchMock).toHaveBeenCalledWith('/api/me/websites', {
      method: 'GET',
      headers: expect.objectContaining({
        Authorization: 'Bearer token-1',
        Accept: 'application/json',
      }),
      body: undefined,
    });
    expect(body).toEqual([{ id: 'w1' }]);
  });

  it('maps non-2xx responses to ApiError with the joined server message', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { message: ['Unauthorized'] }));
    const { fetchMe } = await import('./api');

    const error = await fetchMe().catch((err) => err);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);
    expect((error as ApiError).message).toBe('Unauthorized');
  });

  it('maps network failures to status 0', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('network down'));
    const { fetchMe } = await import('./api');

    const error = await fetchMe().catch((err) => err);
    expect((error as ApiError).status).toBe(0);
  });

  it('builds conversation list query params', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: [], total: 0, page: 1, limit: 20 }));
    await listConversations('w1', { status: 'OPEN', page: 2, limit: 20 });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/websites/w1/conversations?status=OPEN&page=2&limit=20',
      expect.anything(),
    );
  });
});

describe('endpoints', () => {
  it('posts login credentials without an auth token', async () => {
    tokenStorage.remove();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { accessToken: 'abc', user: {} }));

    await login('agent@example.com', 'secret');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/login',
      expect.objectContaining({
        method: 'POST',
        headers: expect.not.objectContaining({ Authorization: expect.anything() }),
      }),
    );
  });

  it('sends the clientMessageId through the REST fallback', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { message: {}, replay: true }));
    await sendMessageRest('w1', 'c1', { content: 'hi', clientMessageId: 'key-1' });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ content: 'hi', clientMessageId: 'key-1' });
  });

  it('posts the close action', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
    await closeConversation('w1', 'c1');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/websites/w1/conversations/c1/close',
      expect.anything(),
    );
  });

  it('posts the claim action without a body payload', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
    await claimConversation('w1', 'c1');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/websites/w1/conversations/c1/claim',
      expect.objectContaining({ method: 'POST', body: '{}' }),
    );
  });

  it('posts the assign action with the target userId', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
    await assignConversation('w1', 'c1', 'u9');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/websites/w1/conversations/c1/assign',
      expect.objectContaining({ method: 'POST', body: '{"userId":"u9"}' }),
    );
  });

  it('fetches the assignment history as a plain list', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, []));
    const history = await listAssignments('w1', 'c1');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/websites/w1/conversations/c1/assignments',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(history).toEqual([]);
  });

  it('fetches the assignable agents for a website', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, [{ id: 'u9', name: 'Bryn' }]));
    const agents = await listAssignableAgents('w1');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/websites/w1/assignable',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(agents).toEqual([{ id: 'u9', name: 'Bryn' }]);
  });
});
