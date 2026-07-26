import React from 'react';
import { FOCUS_RING } from './a11y.jsx';

/**
 * Without a boundary, one malformed stored record turns a render-time throw into a blank
 * page — and the Storage Inspector's purge control lives inside the crashed tree, so the
 * only recovery is devtools. The fallback deliberately offers export-then-purge so a user
 * can rescue their data and get the app back without leaving the page.
 */
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('KQLStore crashed:', error, info?.componentStack);
  }

  handleExport = () => {
    try {
      const raw = localStorage.getItem('kql-store:data') ?? '{}';
      const blob = new Blob([raw], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `kqlstore-recovery-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Revoke on the next turn: revoking in the same tick can cancel the download.
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch {
      window.alert('Could not read local storage. Copy it manually from devtools.');
    }
  };

  handlePurge = () => {
    if (!window.confirm('Delete the local cache and reload? Queries stored on the server are not affected.')) return;
    try {
      localStorage.removeItem('kql-store:data');
      localStorage.removeItem('kql-store:backup');
    } finally {
      window.location.reload();
    }
  };

  render() {
    if (!this.state.error) return this.props.children;

    const btn = {
      padding: '8px 14px',
      borderRadius: 8,
      border: '1px solid #2a2a3e',
      background: '#1a1a2e',
      color: '#e0e0e0',
      fontFamily: 'inherit',
      fontSize: 13,
      cursor: 'pointer',
    };

    return (
      <div style={{
        minHeight: '100vh', background: '#0a0a0f', color: '#e0e0e0', display: 'flex',
        alignItems: 'center', justifyContent: 'center', padding: 24,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      }}>
        {/* role=alert so the failure is announced: this replaces the entire app, and
            without it a screen reader user is left on a page that simply stopped. */}
        <div role="alert" style={{
          maxWidth: 640, background: '#12121a', border: '1px solid #ff4444',
          borderRadius: 12, padding: 28,
        }}>
          <div style={{ color: '#ff4444', fontSize: 16, marginBottom: 10 }}>KQL Store failed to render</div>
          <p style={{ color: '#aaa', fontSize: 13, lineHeight: 1.6, margin: '0 0 16px' }}>
            This is usually a malformed record in the local cache. Your queries on the server are
            untouched. Export the cache if you want a copy, then purge it and reload.
          </p>
          <pre style={{
            background: '#0a0a0f', border: '1px solid #2a2a3e', borderRadius: 8, padding: 12,
            fontSize: 12, color: '#ff6b6b', overflowX: 'auto', margin: '0 0 18px',
          }}>{String(this.state.error?.message || this.state.error)}</pre>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button className={FOCUS_RING} style={btn} onClick={this.handleExport}>Export local cache</button>
            <button className={FOCUS_RING} style={{ ...btn, borderColor: '#ff4444', color: '#ff6b6b' }} onClick={this.handlePurge}>
              Purge cache and reload
            </button>
            <button className={FOCUS_RING} style={btn} onClick={() => window.location.reload()}>Reload</button>
          </div>
        </div>
      </div>
    );
  }
}

export { ErrorBoundary };
