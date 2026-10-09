import type {
  AuthResponse,
  AuthUser,
  ChatMessage,
  CursorPage,
  MessageSendResult,
  Paginated,
  PublicWebsite,
  StaffConversation,
} from '@chatflow/types';
import { tokenStorage } from './storage';

/**
 * Typed REST client for the Phase 3-6 staff APIs. Authorization is the
 * existing bearer JWT; the backend's global guards remain the security
 * boundary — this client never filters or shape-checks tenants.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }

  get isAuthentication(): boolean {
    return this.status === 401;
  }
  get isForbidden(): boolean {
    return this.status === 403;
  }
  get isConflict(): boolean {
    return this.status === 409;
  }
  get isRateLimited(): boolean {
    return this.status === 429;
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH';
  body?: unknown;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const token = tokenStorage.get();
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? 'GET',
      headers:
        options.body !== undefined ? { ...headers, 'Content-Type': 'application/json' } : headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the server');
  }

  if (!response.ok) {
    let message = `Request failed with status ${response.status}`;
    try {
      const body = (await response.json()) as { message?: string | string[] };
      if (Array.isArray(body.message)) message = body.message.join(', ');
      else if (body.message) message = body.message;
    } catch {
      // Non-JSON error body; fall back to the generic message.
    }
    throw new ApiError(response.status, message);
  }

  return (await response.json()) as T;
}

// ---------------------------------------------------------------- auth

export function login(email: string, password: string): Promise<AuthResponse> {
  return request<AuthResponse>('/api/auth/login', { method: 'POST', body: { email, password } });
}

export function fetchMe(): Promise<AuthUser> {
  return request<AuthUser>('/api/auth/me');
}

// -------------------------------------------------------------- websites

/** The websites the current staff user may reach (backend-derived). */
export function listAccessibleWebsites(): Promise<PublicWebsite[]> {
  return request<PublicWebsite[]>('/api/me/websites');
}

// ---------------------------------------------------------- conversations

export interface ConversationListParams {
  status?: 'OPEN' | 'PENDING' | 'CLOSED';
  page?: number;
  limit?: number;
}

export function listConversations(
  websiteId: string,
  params: ConversationListParams = {},
): Promise<Paginated<StaffConversation>> {
  const search = new URLSearchParams();
  if (params.status) search.set('status', params.status);
  if (params.page) search.set('page', String(params.page));
  if (params.limit) search.set('limit', String(params.limit));
  const qs = search.toString();
  return request<Paginated<StaffConversation>>(
    `/api/websites/${websiteId}/conversations${qs ? `?${qs}` : ''}`,
  );
}

export function getConversation(
  websiteId: string,
  conversationId: string,
): Promise<StaffConversation> {
  return request<StaffConversation>(`/api/websites/${websiteId}/conversations/${conversationId}`);
}

// -------------------------------------------------------------- messages

export function listMessages(
  websiteId: string,
  conversationId: string,
  params: { before?: string; limit?: number } = {},
): Promise<CursorPage<ChatMessage>> {
  const search = new URLSearchParams();
  if (params.before) search.set('before', params.before);
  if (params.limit) search.set('limit', String(params.limit));
  const qs = search.toString();
  return request<CursorPage<ChatMessage>>(
    `/api/websites/${websiteId}/conversations/${conversationId}/messages${qs ? `?${qs}` : ''}`,
  );
}

/** REST fallback for message sends when the socket is unavailable. */
export function sendMessageRest(
  websiteId: string,
  conversationId: string,
  body: { content: string; clientMessageId: string },
): Promise<MessageSendResult> {
  return request<MessageSendResult>(
    `/api/websites/${websiteId}/conversations/${conversationId}/messages`,
    {
      method: 'POST',
      body,
    },
  );
}

// ----------------------------------------------------------------- close

export function closeConversation(
  websiteId: string,
  conversationId: string,
): Promise<StaffConversation> {
  return request<StaffConversation>(
    `/api/websites/${websiteId}/conversations/${conversationId}/close`,
    {
      method: 'POST',
      body: {},
    },
  );
}
