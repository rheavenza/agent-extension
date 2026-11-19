import React from 'react';
import ReactDOM from 'react-dom/client';
import '@/assets/style.css';
import App from './App';
import ErrorBoundary from '@/components/ErrorBoundary';

// Errors outside React (unhandled promise rejections etc.) show up as a dismissable banner.
function showGlobalError(msg: string) {
  console.error('[agent]', msg);
  let el = document.getElementById('global-error');
  if (!el) {
    el = document.createElement('div');
    el.id = 'global-error';
    el.className =
      'fixed inset-x-0 top-0 z-50 max-h-40 overflow-auto whitespace-pre-wrap break-all bg-red-600 p-2 text-xs text-white';
    el.title = 'Click to dismiss';
    el.onclick = () => el?.remove();
    document.body.appendChild(el);
  }
  el.textContent = `Error: ${msg} (click to dismiss)`;
}
window.addEventListener('error', (e) => showGlobalError(e.error?.stack ?? e.message));
window.addEventListener('unhandledrejection', (e) =>
  showGlobalError(e.reason instanceof Error ? (e.reason.stack ?? e.reason.message) : String(e.reason)),
);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
