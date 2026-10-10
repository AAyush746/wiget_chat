import type {
  ChatMessage,
  CursorPage,
  MessageSendResult,
  Paginated,
  PublicConversation,
  PublicVisitor,
} from '@chatflow/types';

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }
  get isConflict(): boolean {
    return this.status === 409;
  }
  get isRateLimited(): boolean {
    return this.status === 429;
  }
  get isNetwork(): boolean {
    return this.status === 0;
  }
}

interface VisitorApiConfig {
  apiUrl: string;
  publicKey: string;
}

/**
 * Typed REST client for the public (unauthenticated) visitor widget API.
 *
 * The visitor is identified by its opaque `visitorKey`, which the server
 * scopes to `publicKey`. The server remains authoritative for tenant and
 * conversation ownership — this client never sends websiteId/visitorId/
 * senderType, and any client-supplied identity fields would be rejected with
 * a 400 by the backend's whitelist validation.
 */
export class VisitorApi {
  constructor(private readonly config: VisitorApiConfig) {}

  initVisitor(body: { name?: string; email?: string } = {}): Promise<PublicVisitor> {
    return this.request<PublicVisitor>('/visitor', { method: 'POST', body });
  }

  getVisitor(visitorKey: string): Promise<PublicVisitor> {
    return this.request<PublicVisitor>(`/visitor/${encodeURIComponent(visitorKey)}`);
  }

  listConversations(visitorKey: string): Promise<Paginated<PublicConversation>> {
    return this.request<Paginated<PublicConversation>>(
      `/visitor/${encodeURIComponent(visitorKey)}/conversations`,
    );
  }

  getConversation(visitorKey: string, conversationId: string): Promise<PublicConversation> {
    return this.request<PublicConversation>(
      `/visitor/${encodeURIComponent(visitorKey)}/conversations/${encodeURIComponent(conversationId)}`,
    );
  }

  createConversation(
    visitorKey: string,
    body: { subject?: string } = {},
  ): Promise<PublicConversation> {
    return this.request<PublicConversation>('/conversations', {
      method: 'POST',
      body: { visitorKey, subject: body.subject },
    });
  }

  listMessages(
    visitorKey: string,
    conversationId: string,
    params: { before?: string; limit?: number } = {},
  ): Promise<CursorPage<ChatMessage>> {
    const search = new URLSearchParams();
    if (params.before) search.set('before', params.before);
    if (params.limit) search.set('limit', String(params.limit));
    const qs = search.toString();
    return this.request<CursorPage<ChatMessage>>(
      `/visitor/${encodeURIComponent(visitorKey)}/conversations/${encodeURIComponent(conversationId)}/messages${qs ? `?${qs}` : ''}`,
    );
  }

  sendMessage(
    visitorKey: string,
    conversationId: string,
    body: { content: string; clientMessageId: string },
  ): Promise<MessageSendResult> {
    return this.request<MessageSendResult>(
      `/visitor/${encodeURIComponent(visitorKey)}/conversations/${encodeURIComponent(conversationId)}/messages`,
      { method: 'POST', body },
    );
  }

  // ------------------------------------------------------------ internals

  private url(path: string): string {
    return `${this.config.apiUrl}/api/public/websites/${encodeURIComponent(this.config.publicKey)}${path}`;
  }

  private async request<T>(
    path: string,
    options: { method?: 'GET' | 'POST'; body?: unknown } = {},
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(this.url(path), {
        method: options.method ?? 'GET',
        headers: options.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
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
}

export function createVisitorApi(config: VisitorApiConfig): VisitorApi {
  return new VisitorApi(config);
}
