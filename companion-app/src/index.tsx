import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

// WINDOW SCROLL LOCK: the app is a fixed-viewport layout (100vh root with
// overflow hidden), but the DOCUMENT element can still be scrolled
// programmatically (scrollIntoView during reflow) — which clipped the title
// bar (owner reproduction: chat reopen + scopes open scrolled the page 214px).
// Locking html/body makes document scrolling impossible; inner panels keep
// their own scrollers.
if (typeof document !== 'undefined') {
    document.documentElement.style.overflow = 'hidden';
    document.documentElement.style.height = '100%';
    document.documentElement.style.margin = '0';
    document.body.style.overflow = 'hidden';
    document.body.style.height = '100%';
    document.body.style.margin = '0';
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);