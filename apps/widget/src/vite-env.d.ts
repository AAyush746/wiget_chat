/// <reference types="vite/client" />

interface ChatFlowWidgetConfig {
  websiteId: string;
  apiUrl?: string;
}

interface Window {
  ChatFlowConfig?: ChatFlowWidgetConfig;
}
