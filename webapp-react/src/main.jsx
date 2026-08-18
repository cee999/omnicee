import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import { registerServiceWorker } from './registerServiceWorker.js';
import './index.css';

// Root crash net: never leave a blank white page if the tree throws before App mounts.
class BootBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    try { console.error('[OMNICEE] boot crash:', error, info); } catch (_) {}
  }
  render() {
    if (this.state.error) {
      const msg = this.state.error?.message || String(this.state.error);
      return (
        <div style={{ minHeight: '100vh', background: '#05070a', color: '#eef2f7', padding: 24, fontFamily: 'ui-monospace, monospace' }}>
          <div style={{ maxWidth: 480, margin: '48px auto', border: '1px solid #1c232d', borderRadius: 12, padding: 20, background: '#0b0f14' }}>
            <div style={{ color: '#f0b429', fontWeight: 700, marginBottom: 8 }}>OMNICEE failed to start</div>
            <div style={{ color: '#8b9bb0', fontSize: 12, marginBottom: 16, lineHeight: 1.5 }}>{msg}</div>
            <button
              type="button"
              onClick={() => { try { window.location.reload(); } catch (_) {} }}
              style={{ background: '#1fe3a8', color: '#05070a', border: 0, padding: '10px 16px', borderRadius: 8, fontWeight: 700, cursor: 'pointer', minHeight: 44 }}
            >
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const rootEl = document.getElementById('root');
if (rootEl) {
  ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
      <BootBoundary>
        <App />
      </BootBoundary>
    </React.StrictMode>
  );
} else {
  document.body.innerHTML = '<pre style="color:#ff5470;padding:24px;font-family:monospace">OMNICEE: #root missing from index.html</pre>';
}

registerServiceWorker();
