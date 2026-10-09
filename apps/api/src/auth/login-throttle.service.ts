import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface ThrottleEntry {
  failures: number;
  lockedUntil: number;
}

const MAX_TRACKED_KEYS = 10_000;

/**
 * Lightweight, single-instance brute-force protection for the login endpoint.
 * Tracks failed attempts per `${ip}:${email}` and locks the key for a while
 * once `LOGIN_MAX_ATTEMPTS` is exceeded. State is in memory on purpose: no
 * Redis for an MVP. Behind multiple instances this becomes best-effort and
 * should be moved to a shared store later.
 */
@Injectable()
export class LoginThrottleService {
  private readonly maxAttempts: number;
  private readonly lockMs: number;
  private readonly entries = new Map<string, ThrottleEntry>();

  constructor(config: ConfigService) {
    this.maxAttempts = config.get<number>('LOGIN_MAX_ATTEMPTS') ?? 5;
    this.lockMs = (config.get<number>('LOGIN_LOCK_SECONDS') ?? 300) * 1000;
  }

  isLocked(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) {
      return false;
    }

    if (entry.lockedUntil > Date.now()) {
      return true;
    }

    if (entry.lockedUntil !== 0) {
      this.entries.delete(key);
    }

    return false;
  }

  recordFailure(key: string): void {
    this.pruneIfNeeded();

    const entry = this.entries.get(key) ?? { failures: 0, lockedUntil: 0 };
    entry.failures += 1;

    if (entry.failures >= this.maxAttempts) {
      entry.lockedUntil = Date.now() + this.lockMs;
    }

    this.entries.set(key, entry);
  }

  clear(key: string): void {
    this.entries.delete(key);
  }

  private pruneIfNeeded(): void {
    if (this.entries.size < MAX_TRACKED_KEYS) {
      return;
    }

    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.lockedUntil !== 0 && entry.lockedUntil <= now) {
        this.entries.delete(key);
      }
    }
  }
}
