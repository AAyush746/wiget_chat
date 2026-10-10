const DEFAULT_API_PORT = 4000;
const DEFAULT_JWT_EXPIRES_IN = '1d';
const DEFAULT_BCRYPT_ROUNDS = 12;
const DEFAULT_LOGIN_MAX_ATTEMPTS = 5;
const DEFAULT_LOGIN_LOCK_SECONDS = 300;
const MIN_JWT_SECRET_LENGTH = 32;

/**
 * Validates the environment once at bootstrap so the API fails fast on
 * misconfiguration instead of starting with an unusable network, database or
 * authentication configuration. Returns the normalized config consumed by
 * `ConfigService` (numeric values are coerced here).
 */
export function validateEnv(config: Record<string, unknown>): Record<string, unknown> {
  const errors: string[] = [];

  const databaseUrl = config.DATABASE_URL;
  if (typeof databaseUrl !== 'string' || !/^postgres(ql)?:\/\/\S+$/.test(databaseUrl)) {
    errors.push('DATABASE_URL must be a postgresql:// connection string');
  }

  const rawPort = config.API_PORT ?? DEFAULT_API_PORT;
  const apiPort = typeof rawPort === 'number' ? rawPort : Number(rawPort);
  if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535) {
    errors.push(`API_PORT must be an integer between 1 and 65535 (received "${String(rawPort)}")`);
  }

  const jwtSecret = config.JWT_SECRET;
  if (typeof jwtSecret !== 'string' || jwtSecret.length < MIN_JWT_SECRET_LENGTH) {
    errors.push(`JWT_SECRET must be a string of at least ${MIN_JWT_SECRET_LENGTH} characters`);
  }

  const rawExpiresIn = config.JWT_EXPIRES_IN ?? DEFAULT_JWT_EXPIRES_IN;
  // Require an explicit unit so a bare number is never mistaken for milliseconds.
  if (typeof rawExpiresIn !== 'string' || !/^\d+(ms|s|m|h|d|w|y)$/.test(rawExpiresIn.trim())) {
    errors.push(
      `JWT_EXPIRES_IN must be a duration with a unit, e.g. "15m", "1h" or "1d" (received "${String(rawExpiresIn)}")`,
    );
  }

  const bcryptRounds = toInteger(config.BCRYPT_ROUNDS ?? DEFAULT_BCRYPT_ROUNDS);
  if (!Number.isInteger(bcryptRounds) || bcryptRounds < 10 || bcryptRounds > 15) {
    errors.push(
      `BCRYPT_ROUNDS must be an integer between 10 and 15 (received "${String(config.BCRYPT_ROUNDS)}")`,
    );
  }

  const loginMaxAttempts = toInteger(config.LOGIN_MAX_ATTEMPTS ?? DEFAULT_LOGIN_MAX_ATTEMPTS);
  if (!Number.isInteger(loginMaxAttempts) || loginMaxAttempts < 1) {
    errors.push(
      `LOGIN_MAX_ATTEMPTS must be a positive integer (received "${String(config.LOGIN_MAX_ATTEMPTS)}")`,
    );
  }

  const loginLockSeconds = toInteger(config.LOGIN_LOCK_SECONDS ?? DEFAULT_LOGIN_LOCK_SECONDS);
  if (!Number.isInteger(loginLockSeconds) || loginLockSeconds < 1) {
    errors.push(
      `LOGIN_LOCK_SECONDS must be a positive integer (received "${String(config.LOGIN_LOCK_SECONDS)}")`,
    );
  }

  // Optional: public widget API rate limits (in-memory, single instance).
  const publicRateLimits: Record<string, number> = {};
  for (const key of [
    'PUBLIC_RATE_LIMIT_WINDOW_MS',
    'PUBLIC_RATE_LIMIT_READ_MAX',
    'PUBLIC_RATE_LIMIT_INIT_MAX',
    'PUBLIC_RATE_LIMIT_CREATE_MAX',
    'PUBLIC_RATE_LIMIT_MESSAGE_MAX',
    // WebSocket handshake/join/message limits (per IP or per socket).
    'WS_RATE_LIMIT_WINDOW_MS',
    'WS_RATE_LIMIT_CONNECT_MAX',
    'WS_RATE_LIMIT_JOIN_MAX',
    'WS_RATE_LIMIT_MESSAGE_MAX',
  ]) {
    const raw = config[key];
    if (raw === undefined) continue;
    const value = toInteger(raw);
    if (!Number.isInteger(value) || value < 1) {
      errors.push(`${key} must be a positive integer (received "${String(raw)}")`);
    } else {
      publicRateLimits[key] = value;
    }
  }

  // Optional: browser-origin allowlist for the REST API (comma-separated).
  // The visitor widget and demo storefront call the API cross-origin and need
  // to be listed here. An origin must be an absolute http(s) URL without a
  // path. When unset, a development-default list is applied at bootstrap.
  const corsOrigins = config.CORS_ORIGINS;
  if (corsOrigins !== undefined) {
    if (typeof corsOrigins !== 'string' || !corsOrigins.trim()) {
      errors.push('CORS_ORIGINS must be a comma-separated list of origins when provided');
    } else {
      for (const raw of corsOrigins.split(',')) {
        const origin = raw.trim();
        let parsed: URL | null = null;
        try {
          parsed = new URL(origin);
        } catch {
          parsed = null;
        }
        const ok =
          parsed !== null &&
          (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
          parsed.origin === origin;
        if (!ok) {
          errors.push(
            `CORS_ORIGINS contains an invalid origin "${origin}" (expected e.g. https://app.example.com)`,
          );
        }
      }
    }
  }

  // Optional: AI assistant provider and tuning (Phase 10). Defaults to the
  // deterministic 'mock' provider so a misconfigured deployment can never
  // spuriously call a paid API; opt in to 'openai' or 'groq' explicitly. When
  // AI_PROVIDER is unset, a configured GROQ_API_KEY selects the free Groq
  // backend automatically.
  const aiProvider = config.AI_PROVIDER;
  if (
    aiProvider !== undefined &&
    aiProvider !== 'mock' &&
    aiProvider !== 'openai' &&
    aiProvider !== 'groq'
  ) {
    errors.push('AI_PROVIDER must be "mock", "openai" or "groq" when provided');
  }
  const groqApiKey = config.GROQ_API_KEY;
  if (aiProvider === 'groq' && (typeof groqApiKey !== 'string' || !groqApiKey.trim())) {
    errors.push('GROQ_API_KEY is required when AI_PROVIDER=groq');
  }
  if (config.GROQ_MODEL !== undefined && typeof config.GROQ_MODEL !== 'string') {
    errors.push('GROQ_MODEL must be a string when provided');
  }
  if (config.GROQ_BASE_URL !== undefined) {
    if (
      typeof config.GROQ_BASE_URL !== 'string' ||
      !/^https?:\/\/\S+$/.test(config.GROQ_BASE_URL)
    ) {
      errors.push('GROQ_BASE_URL must be an http(s) URL when provided');
    }
  }
  const aiMaxFaqContext = toInteger(config.AI_MAX_FAQ_CONTEXT ?? 50);
  if (!Number.isInteger(aiMaxFaqContext) || aiMaxFaqContext < 1 || aiMaxFaqContext > 500) {
    errors.push('AI_MAX_FAQ_CONTEXT must be an integer between 1 and 500');
  }
  if (aiProvider === 'openai') {
    const apiKey = config.OPENAI_API_KEY;
    if (typeof apiKey !== 'string' || !apiKey.trim()) {
      errors.push('OPENAI_API_KEY is required when AI_PROVIDER=openai');
    }
    if (config.OPENAI_MODEL !== undefined && typeof config.OPENAI_MODEL !== 'string') {
      errors.push('OPENAI_MODEL must be a string when provided');
    }
    const baseUrl = config.OPENAI_BASE_URL;
    if (baseUrl !== undefined) {
      if (typeof baseUrl !== 'string' || !/^https?:\/\/\S+$/.test(baseUrl)) {
        errors.push('OPENAI_BASE_URL must be an http(s) URL when provided');
      }
    }
  }

  const aiIntervalMs = toInteger(config.AI_WORKER_INTERVAL_MS ?? 1500);
  if (!Number.isInteger(aiIntervalMs) || aiIntervalMs < 100 || aiIntervalMs > 600_000) {
    errors.push(`AI_WORKER_INTERVAL_MS must be an integer between 100 and 600000`);
  }

  const aiJobMaxAttempts = toInteger(config.AI_JOB_MAX_ATTEMPTS ?? 3);
  if (!Number.isInteger(aiJobMaxAttempts) || aiJobMaxAttempts < 1 || aiJobMaxAttempts > 10) {
    errors.push(`AI_JOB_MAX_ATTEMPTS must be an integer between 1 and 10`);
  }

  const aiMaxReplyLength = toInteger(config.AI_MAX_REPLY_LENGTH ?? 2000);
  if (!Number.isInteger(aiMaxReplyLength) || aiMaxReplyLength < 1 || aiMaxReplyLength > 4000) {
    errors.push(`AI_MAX_REPLY_LENGTH must be an integer between 1 and 4000`);
  }

  const aiDailyWebsiteLimit = toInteger(config.AI_DAILY_WEBSITE_LIMIT ?? 500);
  if (!Number.isInteger(aiDailyWebsiteLimit) || aiDailyWebsiteLimit < 1) {
    errors.push(`AI_DAILY_WEBSITE_LIMIT must be a positive integer`);
  }

  const aiLeaseMs = toInteger(config.AI_JOB_LEASE_MS ?? 120_000);
  if (!Number.isInteger(aiLeaseMs) || aiLeaseMs < 1000) {
    errors.push(`AI_JOB_LEASE_MS must be an integer of at least 1000`);
  }

  const aiRequestTimeoutMs = toInteger(config.AI_REQUEST_TIMEOUT_MS ?? 20_000);
  if (
    !Number.isInteger(aiRequestTimeoutMs) ||
    aiRequestTimeoutMs < 1000 ||
    aiRequestTimeoutMs > 120_000
  ) {
    errors.push(`AI_REQUEST_TIMEOUT_MS must be an integer between 1000 and 120000`);
  }

  // Optional: only used by the admin bootstrap seed.
  const adminEmail = config.ADMIN_EMAIL;
  if (
    adminEmail !== undefined &&
    (typeof adminEmail !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(adminEmail))
  ) {
    errors.push('ADMIN_EMAIL must be a valid email address when provided');
  }
  const adminPassword = config.ADMIN_PASSWORD;
  if (
    adminPassword !== undefined &&
    (typeof adminPassword !== 'string' || adminPassword.length < 8)
  ) {
    errors.push('ADMIN_PASSWORD must be at least 8 characters when provided');
  }

  if (errors.length > 0) {
    throw new Error(`Invalid environment configuration:\n - ${errors.join('\n - ')}`);
  }

  return {
    ...config,
    ...publicRateLimits,
    API_PORT: apiPort,
    JWT_EXPIRES_IN: (rawExpiresIn as string).trim(),
    BCRYPT_ROUNDS: bcryptRounds,
    LOGIN_MAX_ATTEMPTS: loginMaxAttempts,
    LOGIN_LOCK_SECONDS: loginLockSeconds,
    AI_WORKER_INTERVAL_MS: aiIntervalMs,
    AI_JOB_MAX_ATTEMPTS: aiJobMaxAttempts,
    AI_MAX_REPLY_LENGTH: aiMaxReplyLength,
    AI_MAX_FAQ_CONTEXT: aiMaxFaqContext,
    AI_DAILY_WEBSITE_LIMIT: aiDailyWebsiteLimit,
    AI_JOB_LEASE_MS: aiLeaseMs,
    AI_REQUEST_TIMEOUT_MS: aiRequestTimeoutMs,
  };
}

function toInteger(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}
