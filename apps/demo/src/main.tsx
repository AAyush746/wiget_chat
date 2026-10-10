import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('No #root element found in the demo page');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
