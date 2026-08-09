import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import { registerServiceWorker } from './registerServiceWorker.js';
import { enableNotifications } from './notifications.js';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

registerServiceWorker();

// Browser notification permission must be requested from a user gesture.
// The prompt is shown only once and only when the browser has not decided yet.
if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'default') {
  const requestOnce = () => {
    window.removeEventListener('click', requestOnce);
    enableNotifications().catch(() => {});
  };
  window.addEventListener('click', requestOnce, { once: true });
}
