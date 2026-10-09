import { Injectable } from '@nestjs/common';

interface WindowEntry {
  count: number;
  windowStart: number;
}

const MAX_TRACKED_KEYS = 50_000;

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
}

/**
 * Lightweight fixed-window request counter for the public widget API.
 *
 * SINGLE-INSTANCE ONLY: state lives in this process. With more than one API
 * instance the effective limit becomes `limit x instances`, and restarting a
 * node resets its counters. That is an acceptable MVP trade-off (no Redis);
 * move to a shared store (Redis/Postgres) before horizontal scaling.
 */
@Injectable()
export class RateLimitService {
  private readonly windows = new Map<string, WindowEntry>();

  hit(key: string, limit: number, windowMs: number): RateLimitDecision {
    this.pruneIfNeeded();

    const now = Date.now();
    const entry = this.windows.get(key);

    if (!entry || now - entry.windowStart >= windowMs) {
      this.windows.set(key, { count: 1, windowStart: now });
      return { allowed: limit >= 1, remaining: Math.max(0, limit - 1) };
    }

    entry.count += 1;
    return { allowed: entry.count <= limit, remaining: Math.max(0, limit - entry.count) };
  }

  private pruneIfNeeded(): void {
    if (this.windows.size < MAX_TRACKED_KEYS) {
      return;
    }

    const now = Date.now();
    for (const [key, entry] of this.windows) {
      if (now - entry.windowStart >= 60_000) {
        this.windows.delete(key);
      }
    }
  }
}
