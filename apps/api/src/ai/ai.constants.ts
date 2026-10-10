import type { AiProviderName } from '@chatflow/types';

/**
 * Tuning knobs for the AI worker. These read `process.env` at import time and
 * fall back to safe defaults; the resolved values are also validated and
 * normalized once at bootstrap in `config/env.validation.ts`.
 *
 * Secrets and provider selection are read at *runtime* through `ConfigService`
 * (see `ai.provider.ts`) so `.env` loading order can never change behaviour.
 */
export const AI_JOB_MAX_ATTEMPTS = Number(process.env.AI_JOB_MAX_ATTEMPTS ?? 3);
export const AI_JOB_LEASE_MS = Number(process.env.AI_JOB_LEASE_MS ?? 120_000);
export const AI_WORKER_INTERVAL_MS = Number(process.env.AI_WORKER_INTERVAL_MS ?? 1500);
export const AI_REQUEST_TIMEOUT_MS = Number(process.env.AI_REQUEST_TIMEOUT_MS ?? 20_000);
export const AI_MAX_REPLY_LENGTH = Number(process.env.AI_MAX_REPLY_LENGTH ?? 2000);
export const AI_DAILY_WEBSITE_LIMIT = Number(process.env.AI_DAILY_WEBSITE_LIMIT ?? 500);
/** Most FAQ entries fed to the model as grounding context (scope cap). */
export const AI_MAX_FAQ_CONTEXT = Number(process.env.AI_MAX_FAQ_CONTEXT ?? 50);

/**
 * The one token the model is instructed to emit — and nothing else — when a
 * question is not covered by the allowed knowledge. Its presence is what turns
 * a reply into a human handoff, so it is the contract between the prompt and
 * `AiService`. It is intentionally not something a visitor would ever type.
 */
export const AI_HANDOFF_SENTINEL = '[[HANDOFF]]';

/**
 * Acknowledgement used when a website has no custom escalation reply configured.
 * Shared so the connect flow (which seeds it on enable) and the worker's
 * acknowledgement path can never drift apart.
 */
export const AI_DEFAULT_FALLBACK_MESSAGE =
  'Thanks for your message! A member of our team will be with you shortly.';

export const AI_PROVIDER_NAMES: readonly AiProviderName[] = ['mock', 'openai', 'groq'];

export const DEFAULT_GROQ_MODEL = 'qwen/qwen3.8-27b';
export const DEFAULT_GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
export const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';
export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
