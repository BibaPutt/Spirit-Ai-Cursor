import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { OverlayErrorBoundary } from './components/OverlayErrorBoundary';
import { OpenUiTheme } from './components/OpenUiTheme';
import './i18n';
import '@openuidev/react-ui/index.css';
import './styles/globals.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root element not found');

// Forward renderer crashes to the session log. Main-side logs never show
// these — a blank box with zero log lines used to be undebuggable.
window.addEventListener('error', (e) => {
  try {
    window.spirit?.reportRendererError?.(`window-error: ${String(e.message ?? e.error)}`);
  } catch {
    /* ignore */
  }
});
window.addEventListener('unhandledrejection', (e) => {
  try {
    window.spirit?.reportRendererError?.(`unhandled-rejection: ${String(e.reason)}`);
  } catch {
    /* ignore */
  }
});

createRoot(container).render(
  <React.StrictMode>
    <OverlayErrorBoundary>
      <OpenUiTheme>
        <App />
      </OpenUiTheme>
    </OverlayErrorBoundary>
  </React.StrictMode>,
);
