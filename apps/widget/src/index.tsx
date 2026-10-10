import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { StrictMode } from 'react';
import css from './index.css?inline';
import { WidgetApp } from './WidgetApp';
import { resolveConfig, describeConfigError } from './lib/config';

const MOUNT_ATTR = 'data-chatflow-widget';

let mountedRoot: Root | null = null;

/**
 * Embedding entry point. The built bundle is a classic IIFE executed from a
 * <script data-website-key="..." src="..."> tag (or window.ChatFlowConfig), so
 * `document.currentScript` is available for attribute-based configuration.
 *
 * Guarantees:
 * - single instance (module-level guard + DOM marker),
 * - configuration is validated and fails loudly during development,
 * - widget styles are isolated from the host page via a shadow root,
 * - no React required on the host page and no credentials embedded.
 */
export function mountWidget(): boolean {
  if (mountedRoot || document.querySelector(`[${MOUNT_ATTR}]`)) {
    return false;
  }

  const config = resolveConfig();
  const configError = describeConfigError(config);
  if (configError) {
    console.error(
      `[ChatFlow] ${configError}\n` +
        'Embed like: <script src="/widget.js" data-website-key="PUBLIC_WEBSITE_KEY" async></script>',
    );
    return false;
  }

  const host = document.createElement('div');
  host.dataset.chatflowWidget = '';

  const shadowRoot = host.attachShadow({ mode: 'open' });

  const styleElement = document.createElement('style');
  styleElement.textContent = css;
  shadowRoot.appendChild(styleElement);

  const container = document.createElement('div');
  shadowRoot.appendChild(container);

  document.body.appendChild(host);

  mountedRoot = createRoot(container);
  mountedRoot.render(
    <StrictMode>
      <WidgetApp config={config} />
    </StrictMode>,
  );
  return true;
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountWidget, { once: true });
  } else {
    mountWidget();
  }
}

// Exposed for embedding hosts and for tests.
(window as Window & { ChatFlowWidget?: { mountWidget: () => boolean } }).ChatFlowWidget = {
  mountWidget,
};
