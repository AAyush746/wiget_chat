import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AiAgentStatus, AiProviderName } from '@chatflow/types';
import {
  AI_MAX_REPLY_LENGTH,
  AI_PROVIDER_NAMES,
  AI_REQUEST_TIMEOUT_MS,
  DEFAULT_GROQ_BASE_URL,
  DEFAULT_GROQ_MODEL,
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_OPENAI_MODEL,
} from './ai.constants';

export interface GenerateRequest {
  systemPrompt: string;
  userMessage: string;
  conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
  websiteFaqs?: Array<{ question: string; answer: string }>;
}

export interface GenerateResponse {
  content: string;
  tokens?: number;
}

export interface AiProvider {
  generate(req: GenerateRequest): Promise<GenerateResponse>;
}

/**
 * Deterministic, dependency-free responder. It is the default so a
 * misconfigured deployment can never spuriously call a paid API, and it is
 * what backs the "offline" agent when no model key is present. It only ever
 * echoes an FAQ answer; with no FAQ it declines, which the worker treats as an
 * escalation.
 */
@Injectable()
export class MockAiProvider implements AiProvider {
  private readonly logger = new Logger(MockAiProvider.name);

  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    const content = this.buildReply(req);
    this.logger.debug(`Mock AI reply: ${content}`);
    return { content };
  }

  private buildReply(req: GenerateRequest): string {
    const faqs = req.websiteFaqs ?? [];
    const top = faqs[0];
    if (top) {
      return `Based on our FAQ: ${top.answer.substring(0, AI_MAX_REPLY_LENGTH)}`;
    }
    return `Thanks for reaching out. A human agent will assist with: "${req.userMessage.substring(0, 100)}"`;
  }
}

interface CompatibleProviderOptions {
  /** Human-readable backend name, used only for log lines. */
  name: string;
  apiKey: string;
  baseUrl: string;
  model: string;
}

/**
 * A real model backend speaking the OpenAI `/chat/completions` wire format.
 * Both Groq (free tier) and OpenAI use this identical contract, so one
 * implementation serves both — only the key, base URL and model differ.
 */
export class OpenAiCompatibleProvider implements AiProvider {
  private readonly logger = new Logger('AiProvider');

  constructor(private readonly opts: CompatibleProviderOptions) {}

  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    const { name, apiKey, baseUrl, model } = this.opts;
    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: req.systemPrompt },
      ...(req.conversationHistory ?? []),
      { role: 'user', content: req.userMessage },
    ];

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), AI_REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.2,
          max_tokens: Math.min(500, AI_MAX_REPLY_LENGTH),
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const err = await res.text().catch(() => '');
        throw new Error(`${name} API error ${res.status}: ${err}`);
      }

      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content?.trim() ?? '';
      if (!content) {
        throw new Error(`Empty response from ${name}`);
      }
      return { content: content.substring(0, AI_MAX_REPLY_LENGTH) };
    } catch (err) {
      this.logger.error(`${name} generation failed`, err as Error);
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** Resolved provider state for a given environment; never includes the key. */
export interface ResolvedProviderConfig {
  name: AiProviderName;
  model: string;
  ready: boolean;
  description: string;
}

function isProviderName(value: unknown): value is AiProviderName {
  return typeof value === 'string' && (AI_PROVIDER_NAMES as readonly string[]).includes(value);
}

/**
 * Decides which backend is active from configuration, in this order:
 * an explicit `AI_PROVIDER`, else a present Groq key (the free option), else a
 * present OpenAI key, else the offline mock. `ready` is false only when a
 * remote provider was selected without its key — the dashboard surfaces this
 * so staff know the agent would fall back to the offline responder.
 */
export function resolveProviderConfig(config: ConfigService): ResolvedProviderConfig {
  const explicit = config.get<string>('AI_PROVIDER');
  const groqKey = (config.get<string>('GROQ_API_KEY') ?? '').trim();
  const openaiKey = (config.get<string>('OPENAI_API_KEY') ?? '').trim();

  let name: AiProviderName;
  if (isProviderName(explicit)) {
    name = explicit;
  } else if (groqKey) {
    name = 'groq';
  } else if (openaiKey) {
    name = 'openai';
  } else {
    name = 'mock';
  }

  if (name === 'groq') {
    return {
      name,
      model: config.get<string>('GROQ_MODEL') ?? DEFAULT_GROQ_MODEL,
      ready: Boolean(groqKey),
      description: 'Groq free tier (OpenAI-compatible)',
    };
  }
  if (name === 'openai') {
    return {
      name,
      model: config.get<string>('OPENAI_MODEL') ?? DEFAULT_OPENAI_MODEL,
      ready: Boolean(openaiKey),
      description: 'OpenAI (paid API)',
    };
  }
  return {
    name: 'mock',
    model: 'built-in',
    ready: true,
    description: 'Offline deterministic replies (no external model)',
  };
}

/** Builds the concrete provider implied by the environment. */
export function createProvider(config: ConfigService): AiProvider {
  const resolved = resolveProviderConfig(config);

  if (resolved.name === 'groq') {
    return new OpenAiCompatibleProvider({
      name: 'Groq',
      apiKey: (config.get<string>('GROQ_API_KEY') ?? '').trim(),
      baseUrl: config.get<string>('GROQ_BASE_URL') ?? DEFAULT_GROQ_BASE_URL,
      model: resolved.model,
    });
  }
  if (resolved.name === 'openai') {
    return new OpenAiCompatibleProvider({
      name: 'OpenAI',
      apiKey: (config.get<string>('OPENAI_API_KEY') ?? '').trim(),
      baseUrl: config.get<string>('OPENAI_BASE_URL') ?? DEFAULT_OPENAI_BASE_URL,
      model: resolved.model,
    });
  }
  return new MockAiProvider();
}

/** The public (key-free) status the dashboard's Connect Agent panel reads. */
export function describeProvider(
  config: ConfigService,
): Omit<AiAgentStatus, 'aiEnabled' | 'aiFallbackMessage'> {
  const resolved = resolveProviderConfig(config);
  return {
    provider: resolved.name,
    model: resolved.model,
    ready: resolved.ready,
    description: resolved.description,
  };
}
