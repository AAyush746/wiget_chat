import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import css from './index.css?inline';
import { WidgetApp } from './WidgetApp';

function mount(): void {
  if (document.querySelector('[data-chatflow-widget]')) {
    return;
  }

  const config = window.ChatFlowConfig;
  if (!config?.websiteId) {
    console.error('[ChatFlow] window.ChatFlowConfig.websiteId is required');
    return;
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

  createRoot(container).render(
    <StrictMode>
      <WidgetApp websiteId={config.websiteId} />
    </StrictMode>,
  );
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount, { once: true });
} else {
  mount();
}
