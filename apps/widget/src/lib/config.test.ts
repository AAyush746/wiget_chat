import { afterEach, describe, expect, it } from 'vitest';
import {
  describeConfigError,
  isValidPublicKey,
  resolveConfig,
  type ResolvedConfig,
} from './config';

const VALID_KEY = 'Ak9x_vLp2Mq7zQw1eRnt8Yb0';

function stubCurrentScript(dataset: Record<string, string>): void {
  const el = document.createElement('script');
  for (const [key, value] of Object.entries(dataset)) {
    el.dataset[key] = value;
  }
  Object.defineProperty(document, 'currentScript', { configurable: true, value: el });
}

afterEach(() => {
  delete window.ChatFlowConfig;
  Object.defineProperty(document, 'currentScript', { configurable: true, value: null });
});

describe('isValidPublicKey', () => {
  it('accepts the public-key charset and length bounds', () => {
    expect(isValidPublicKey(VALID_KEY)).toBe(true);
    expect(isValidPublicKey('a'.repeat(16))).toBe(true);
    expect(isValidPublicKey('a'.repeat(128))).toBe(true);
  });

  it('rejects short, missing, or obviously non-public values', () => {
    expect(isValidPublicKey('short')).toBe(false);
    expect(isValidPublicKey('a'.repeat(129))).toBe(false);
    expect(isValidPublicKey('')).toBe(false);
    expect(isValidPublicKey(undefined)).toBe(false);
    expect(isValidPublicKey(null)).toBe(false);
  });
});

describe('resolveConfig', () => {
  it('reads from data attributes on the loader script (highest priority)', () => {
    stubCurrentScript({
      websiteKey: VALID_KEY,
      apiUrl: 'https://api.example.com/',
    });
    expect(resolveConfig()).toEqual({
      publicKey: VALID_KEY,
      apiUrl: 'https://api.example.com',
    });
  });

  it('falls back to window.ChatFlowConfig when no script attributes exist', () => {
    Object.defineProperty(document, 'currentScript', { configurable: true, value: null });
    window.ChatFlowConfig = { publicKey: VALID_KEY, apiUrl: 'https://widget.example.com' };
    expect(resolveConfig()).toEqual({
      publicKey: VALID_KEY,
      apiUrl: 'https://widget.example.com',
    });
  });

  it('prefers script attributes over window.ChatFlowConfig', () => {
    stubCurrentScript({ websiteKey: VALID_KEY });
    window.ChatFlowConfig = { publicKey: 'config-key-value', apiUrl: 'https://window.example.com' };
    const config = resolveConfig();
    expect(config.publicKey).toBe(VALID_KEY);
    expect(config.apiUrl).toBe('https://window.example.com');
  });

  it('normalizes whitespace and trailing slashes', () => {
    stubCurrentScript({
      websiteKey: `  ${VALID_KEY}  `,
      apiUrl: ' http://localhost:4000/// ',
    });
    const config = resolveConfig();
    expect(config.publicKey).toBe(VALID_KEY);
    expect(config.apiUrl).toBe('http://localhost:4000');
  });

  it('defaults the API url to the local dev origin', () => {
    stubCurrentScript({ websiteKey: VALID_KEY });
    expect(resolveConfig().apiUrl).toBe('http://localhost:4000');
  });
});

describe('describeConfigError', () => {
  const ok: ResolvedConfig = { publicKey: VALID_KEY, apiUrl: 'http://localhost:4000' };

  it('accepts a fully configured widget', () => {
    expect(describeConfigError(ok)).toBeNull();
  });

  it('flags a missing website key', () => {
    expect(describeConfigError({ publicKey: '', apiUrl: 'http://localhost:4000' })).toContain(
      'no website key',
    );
  });

  it('flags an invalid website key', () => {
    expect(
      describeConfigError({ publicKey: 'website-id', apiUrl: 'http://localhost:4000' }),
    ).toContain('looks invalid');
  });

  it('flags a malformed api url', () => {
    expect(describeConfigError({ publicKey: VALID_KEY, apiUrl: 'ftp://example.com' })).toContain(
      'apiUrl',
    );
  });
});
