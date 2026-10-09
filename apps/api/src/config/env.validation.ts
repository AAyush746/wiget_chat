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
          parsed !== null && (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
          parsed.origin === origin;
        if (!ok) {
          errors.push(
            `CORS_ORIGINS contains an invalid origin "${origin}" (expected e.g. https://app.example.com)`,
          );
        }
      }
    }
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
  };
}

function toInteger(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}
