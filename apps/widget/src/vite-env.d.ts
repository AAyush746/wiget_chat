/// <reference types="vite/client" />

interface ChatFlowWidgetConfig {
  /**
   * The website's public key (not the internal website id). This is the only
   * identifier the public widget API accepts. Safe to embed on a page — it is
   * not a secret and is not an authentication boundary.
   */
  publicKey?: string;
  /** Absolute API origin, e.g. `http://localhost:4000`. */
  apiUrl?: string;
  /** @deprecated Use `publicKey`. */
  websiteId?: string;
}

interface Window {
  ChatFlowConfig?: ChatFlowWidgetConfig;
}
