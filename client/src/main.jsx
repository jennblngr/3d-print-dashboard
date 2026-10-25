import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import { lang } from './i18n.js';
import { guestToken } from './lib.js';
import { checkPush } from './push.js';
import { App } from './App.jsx';

document.documentElement.lang = lang;

createRoot(document.getElementById('root')).render(<StrictMode><App /></StrictMode>);

// The service worker keeps the built app available offline: not while developing.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').then(() => !guestToken && checkPush()).catch(() => {});
  // a notification tapped while the app is open, when the window could not be sent there
  navigator.serviceWorker.addEventListener('message', e => {
    if (typeof e.data?.url === 'string') location.hash = new URL(e.data.url, location.origin).hash;
  });
}
