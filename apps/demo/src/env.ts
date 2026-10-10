export interface DemoEnv {
  websiteKey: string;
  apiUrl: string;
  hasWebsiteKey: boolean;
}

const KEY_PLACEHOLDER = '%VITE_DEMO_WEBSITE_KEY%';
const URL_PLACEHOLDER = '%VITE_API_URL%';

/**
 * Read the demo configuration injected into index.html (window.ChatFlowDemo)
 * and/or baked in via import.meta.env. The index.html script leaves the raw
 * Vite placeholders in place when the corresponding env var was not set, so
 * those are treated as "not configured".
 */
export function readDemoEnv(viteEnv: ImportMetaEnv): DemoEnv {
  const inline = window.ChatFlowDemo;
  const inlineKey =
    inline?.websiteKey && inline.websiteKey !== KEY_PLACEHOLDER ? inline.websiteKey : '';
  const inlineUrl = inline?.apiUrl && inline.apiUrl !== URL_PLACEHOLDER ? inline.apiUrl : '';

  const websiteKey = inlineKey || String(viteEnv.VITE_DEMO_WEBSITE_KEY ?? '');
  const apiUrl = inlineUrl || String(viteEnv.VITE_API_URL ?? '') || 'http://localhost:4000';

  return { websiteKey, apiUrl, hasWebsiteKey: Boolean(websiteKey) };
}
