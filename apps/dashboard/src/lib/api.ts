import type {
  FaqEntry,
  CreateFaqInput,
  UpdateFaqInput,
  AiAgentStatus,
  AuthResponse,
  AuthUser,
  ChatMessage,
  ConversationAssignmentEntry,
  CursorPage,
  MessageSendResult,
  Paginated,
  PublicUser,
  PublicWebsite,
  ReportConversations,
  ReportOverview,
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
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
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

  if (response.status === 204) {
    return undefined as T;
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

// ------------------------------------------------------------ assignments

/** The calling staff member takes an unassigned conversation. */
export function claimConversation(
  websiteId: string,
  conversationId: string,
): Promise<StaffConversation> {
  return request<StaffConversation>(
    `/api/websites/${websiteId}/conversations/${conversationId}/claim`,
    { method: 'POST', body: {} },
  );
}

/** Assign — or reassign when already held — to an eligible agent. */
export function assignConversation(
  websiteId: string,
  conversationId: string,
  userId: string,
): Promise<StaffConversation> {
  return request<StaffConversation>(
    `/api/websites/${websiteId}/conversations/${conversationId}/assign`,
    { method: 'POST', body: { userId } },
  );
}

/** Append-only assignment history for the conversation. */
export function listAssignments(
  websiteId: string,
  conversationId: string,
): Promise<ConversationAssignmentEntry[]> {
  return request<ConversationAssignmentEntry[]>(
    `/api/websites/${websiteId}/conversations/${conversationId}/assignments`,
  );
}

/** Staff who may be assigned work on this website. */
export function listAssignableAgents(websiteId: string): Promise<PublicUser[]> {
  return request<PublicUser[]>(`/api/websites/${websiteId}/assignable`);
}

export function updateWebsiteAi(
  websiteId: string,
  settings: { aiEnabled?: boolean; aiFallbackMessage?: string | null },
): Promise<PublicWebsite> {
  return request<PublicWebsite>(`/api/websites/${websiteId}/ai`, {
    method: 'PATCH',
    body: settings,
  });
}

/** The AI agent's connection state plus the deployment's model backend. */
export function getAiAgentStatus(websiteId: string): Promise<AiAgentStatus> {
  return request<AiAgentStatus>(`/api/websites/${websiteId}/ai`);
}

export function listFaqs(websiteId: string): Promise<FaqEntry[]> {
  return request<FaqEntry[]>(`/api/websites/${websiteId}/faqs`);
}

export function createFaq(websiteId: string, input: CreateFaqInput): Promise<FaqEntry> {
  return request<FaqEntry>(`/api/websites/${websiteId}/faqs`, {
    method: 'POST',
    body: input,
  });
}

export function updateFaq(
  websiteId: string,
  faqId: string,
  input: UpdateFaqInput,
): Promise<FaqEntry> {
  return request<FaqEntry>(`/api/websites/${websiteId}/faqs/${faqId}`, {
    method: 'PATCH',
    body: input,
  });
}

export function deleteFaq(websiteId: string, faqId: string): Promise<void> {
  return request<void>(`/api/websites/${websiteId}/faqs/${faqId}`, {
    method: 'DELETE',
  });
}

// ------------------------------------------------------------------ reporting

export interface ReportQuery {
  from?: string;
  to?: string;
  bucket?: 'hour' | 'day' | 'week';
  limit?: number;
}

function reportQueryString(query: ReportQuery): string {
  const params = new URLSearchParams();
  if (query.from) params.set('from', query.from);
  if (query.to) params.set('to', query.to);
  if (query.bucket) params.set('bucket', query.bucket);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

/** Headline KPIs, volume-over-time series and the agent table in one call. */
export function getReportOverview(
  websiteId: string,
  query: ReportQuery = {},
): Promise<ReportOverview> {
  return request<ReportOverview>(
    `/api/websites/${websiteId}/reports/overview${reportQueryString(query)}`,
  );
}

export function getReportConversations(
  websiteId: string,
  query: ReportQuery = {},
): Promise<ReportConversations> {
  return request<ReportConversations>(
    `/api/websites/${websiteId}/reports/conversations${reportQueryString(query)}`,
  );
}

/**
 * Downloads the CSV through an authenticated fetch rather than a bare link:
 * the endpoint requires the bearer token, so a plain `<a href>` would be
 * redirected to the login page instead of downloading.
 */
export async function downloadReportCsv(websiteId: string, query: ReportQuery = {}): Promise<void> {
  const token = tokenStorage.get();
  const response = await fetch(
    `/api/websites/${websiteId}/reports/export.csv${reportQueryString(query)}`,
    { headers: token ? { Authorization: `Bearer ${token}` } : {} },
  );

  if (!response.ok) {
    throw new ApiError(response.status, 'Could not export the report');
  }

  const blob = await response.blob();
  const disposition = response.headers.get('Content-Disposition') ?? '';
  const match = /filename="?([^";]+)"?/.exec(disposition);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = match?.[1] ?? 'chatflow-report.csv';
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
