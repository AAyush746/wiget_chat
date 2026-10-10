export interface ResolvedConfig {
  publicKey: string;
  apiUrl: string;
}

const PUBLIC_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export function isValidPublicKey(value: string | undefined | null): value is string {
  return typeof value === 'string' && PUBLIC_KEY_PATTERN.test(value);
}

/**
 * Resolve the widget configuration from (highest priority first):
 *   1. `data-website-key` / `data-api-url` attributes on the loader script
 *      element (`document.currentScript`),
 *   2. `window.ChatFlowConfig` ({ publicKey, apiUrl }),
 *   3. `VITE_API_URL` baked in at build time.
 *
 * The public widget API authenticates with the website `publicKey`, never a
 * staff JWT — nothing confidential is ever embedded in the page.
 */
export function resolveConfig(): ResolvedConfig {
  const script = document.currentScript as HTMLScriptElement | null;
  const attrKey = script?.dataset.websiteKey;
  const attrUrl = script?.dataset.apiUrl;

  const global = window.ChatFlowConfig;
  const publicKey = attrKey || global?.publicKey || global?.websiteId || '';
  const apiUrl = attrUrl || global?.apiUrl || apiUrlDefault();

  return {
    publicKey: publicKey.trim(),
    apiUrl: apiUrl.trim().replace(/\/+$/, ''),
  };
}

export function describeConfigError(config: ResolvedConfig): string | null {
  if (!config.publicKey) {
    return 'ChatFlow: no website key. Add data-website-key="PUBLIC_WEBSITE_KEY" to the widget <script> tag, or set window.ChatFlowConfig.publicKey before it loads.';
  }
  if (!isValidPublicKey(config.publicKey)) {
    return 'ChatFlow: the website key looks invalid (expect 16-128 characters of [A-Za-z0-9_-]). Did you pass the public key instead of a website id?';
  }
  if (!/^https?:\/\//.test(config.apiUrl)) {
    return 'ChatFlow: apiUrl must be an http(s) URL, got "' + config.apiUrl + '".';
  }
  return null;
}

function apiUrlDefault(): string {
  const fromEnv = import.meta.env.VITE_API_URL;
  return typeof fromEnv === 'string' && fromEnv ? fromEnv : 'http://localhost:4000';
}
