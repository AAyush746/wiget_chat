const TOKEN_KEY = 'chatflow.dashboard.token';
const PREF_KEY = 'chatflow.dashboard.prefs';

interface DashboardPrefs {
  websiteId?: string;
  conversationId?: string;
}

function readPrefs(): DashboardPrefs {
  try {
    const raw = window.localStorage.getItem(PREF_KEY);
    return raw ? (JSON.parse(raw) as DashboardPrefs) : {};
  } catch {
    return {};
  }
}

function writePrefs(prefs: DashboardPrefs): void {
  try {
    window.localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
  } catch {
    // Storage unavailable (private mode / quota): preferences are cosmetic.
  }
}

/**
 * Session token persistence.
 *
 * Security trade-off (MVP, documented): the JWT lives in `localStorage`, so a
 * script-injection (XSS) in this app could read it. The backend contract is
 * bearer-token only (no cookie infrastructure exists), so the alternative is
 * in-memory storage that would log the user out on every refresh — directly
 * contradicting the dashboard's refresh-recovery requirement. The token is
 * never logged, rendered, or placed in a URL; it rides only the
 * `Authorization` header and the Socket.IO handshake `auth` object.
 */
export const tokenStorage = {
  get(): string | null {
    try {
      return window.localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set(token: string): void {
    try {
      window.localStorage.setItem(TOKEN_KEY, token);
    } catch {
      // Storage unavailable: session continues in memory only.
    }
  },
  remove(): void {
    try {
      window.localStorage.removeItem(TOKEN_KEY);
    } catch {
      // no-op
    }
  },
};

/** Non-sensitive UI preferences (selected website/conversation), optional. */
export const preferences = {
  getWebsiteId(): string | null {
    return readPrefs().websiteId ?? null;
  },
  setWebsiteId(websiteId: string | null): void {
    writePrefs({ ...readPrefs(), websiteId: websiteId ?? undefined });
  },
  getConversationId(): string | null {
    return readPrefs().conversationId ?? null;
  },
  setConversationId(conversationId: string | null): void {
    writePrefs({ ...readPrefs(), conversationId: conversationId ?? undefined });
  },
};
