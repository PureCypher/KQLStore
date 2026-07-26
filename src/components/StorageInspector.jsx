import React, { useId, useState, useEffect } from 'react';
import { X, Database, AlertTriangle, Shield, Eye } from 'lucide-react';
import { CURRENT_SCHEMA_VERSION } from '../constants.js';
import { safeJsonParse } from '../lib/json.js';
import { StorageAdapter } from '../storage/adapter.js';
import { operationLog } from '../storage/opLog.js';
import { FOCUS_RING } from './a11y.jsx';

// The secondary text in this panel was text-gray-500/600 (#6b7280 / #4b5563), which
// measures 2.5-4.1:1 against the #0d0d14 and #12121a surfaces it sits on — under the
// 4.5:1 WCAG 1.4.3 asks of body text. Measured with axe in Chromium, not estimated.
// text-gray-400 is the dimmest step on the Tailwind grey ramp that clears it here.
const TABS = ['overview', 'keys', 'operations', 'data', 'danger'];

function StorageInspector({ visible, onClose, storage, onForceBackup, onHealthCheck, onPurge }) {
  const [activeTab, setActiveTab] = useState('overview');
  const [ops, setOps] = useState([]);
  const [healthResult, setHealthResult] = useState(null);
  const [healthRunning, setHealthRunning] = useState(false);
  const [rawDataKey, setRawDataKey] = useState(null);
  const [rawData, setRawData] = useState(null);
  const [rawDataLoading, setRawDataLoading] = useState(false);
  const [purgeConfirm, setPurgeConfirm] = useState('');
  const [keyList, setKeyList] = useState([]);
  const [keySizes, setKeySizes] = useState({});
  const baseId = useId();
  const panelId = `${baseId}-panel`;
  const purgeId = `${baseId}-purge`;
  const dataKeyId = `${baseId}-data-key`;

  // Refresh operation log periodically when visible
  useEffect(() => {
    if (!visible) return;
    const refresh = () => setOps(operationLog.getAll());
    refresh();
    const iv = setInterval(refresh, 1000);
    return () => clearInterval(iv);
  }, [visible]);

  // Load key list when visible
  useEffect(() => {
    if (!visible) return;
    (async () => {
      try {
        const keys = await StorageAdapter.list('kql-store:');
        setKeyList(keys);
        const sizes = {};
        for (const k of keys) {
          try {
            const val = await StorageAdapter.get(k);
            sizes[k] = val ? Math.round((val.length * 2) / 1024 * 100) / 100 : 0;
          } catch {
            sizes[k] = -1;
          }
        }
        setKeySizes(sizes);
      } catch {
        setKeyList([]);
      }
    })();
  }, [visible, storage.lastSavedTimestamp]);

  const handleViewKey = async (key) => {
    setRawDataKey(key);
    setRawDataLoading(true);
    try {
      const val = await StorageAdapter.get(key);
      if (val) {
        const parsed = safeJsonParse(val);
        setRawData(parsed.ok ? JSON.stringify(parsed.data, null, 2) : val);
      } else {
        setRawData('(empty)');
      }
    } catch (e) {
      setRawData('Error reading key: ' + e.message);
    }
    setRawDataLoading(false);
  };

  const handleHealthCheck = async () => {
    setHealthRunning(true);
    const result = await onHealthCheck();
    setHealthResult(result);
    setHealthRunning(false);
  };

  const handlePurge = async () => {
    if (purgeConfirm !== 'DELETE') return;
    await onPurge();
    setPurgeConfirm('');
    setRawDataKey(null);
    setRawData(null);
  };

  if (!visible) return null;

  const totalSizeKB = Object.values(keySizes).reduce((sum, s) => sum + (s > 0 ? s : 0), 0);
  const maxSizeKB = 5120;

  const tabStyle = (active) => ({
    background: active ? '#1a1a2e' : 'transparent',
    // #666 measured at 3.37:1 against this panel; an inactive tab is still text.
    color: active ? '#00ff88' : '#9ca3af',
    border: active ? '1px solid #2a2a3e' : '1px solid transparent',
    borderBottom: active ? '1px solid #0d0d14' : '1px solid #2a2a3e',
  });

  return (
    // A labelled region rather than an anonymous div: this panel covers the bottom half
    // of the viewport and a screen reader user needs to be able to find it, and to know
    // what it is once they land in it.
    <div role="region" aria-label="Storage inspector" className="fixed bottom-0 left-0 right-0 z-[70] font-mono text-xs" style={{ maxHeight: '50vh' }}>
      {/* Header bar */}
      <div className="flex items-center justify-between px-4 py-2" style={{ background: '#0d0d14', borderTop: '2px solid #00ff88', borderBottom: '1px solid #2a2a3e' }}>
        <div className="flex items-center gap-3">
          <Database size={14} style={{ color: '#00ff88' }} aria-hidden="true" />
          <span style={{ color: '#00ff88' }} className="font-bold">Storage Inspector</span>
          <span className="text-gray-400" aria-hidden="true">|</span>
          {/* Tabs. aria-pressed rather than role="tab": these are toggle buttons that swap
              the panel below, and claiming the tab role would promise arrow-key roving
              navigation that is not implemented. Which one is current was otherwise
              carried by background colour alone. */}
          {TABS.map(tab => (
            <button key={tab} onClick={() => setActiveTab(tab)}
              aria-pressed={activeTab === tab} aria-controls={panelId}
              className={`px-3 py-1 rounded-t text-xs capitalize ${FOCUS_RING}`} style={tabStyle(activeTab === tab)}>{tab}</button>
          ))}
        </div>
        <button onClick={onClose} className={`p-1 rounded hover:bg-white/10 ${FOCUS_RING}`}
          aria-label="Close storage inspector" title="Close"><X size={14} className="text-gray-400" aria-hidden="true" /></button>
      </div>

      {/* Content */}
      <div id={panelId} className="overflow-y-auto p-4" style={{ background: '#0d0d14', maxHeight: 'calc(50vh - 44px)' }}>

        {/* Overview Tab */}
        {activeTab === 'overview' && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="rounded-lg p-3" style={{ background: '#12121a', border: '1px solid #1e1e2e' }}>
              <div className="text-gray-400 mb-1">Status</div>
              <div style={{ color: storage.error ? '#ff4444' : '#00ff88' }} className="font-bold">
                {storage.error ? 'Error' : storage.isLoading ? 'Loading...' : 'Healthy'}
              </div>
              {storage.error && <div className="text-gray-400 mt-1 truncate" title={storage.error}>{storage.error}</div>}
            </div>
            <div className="rounded-lg p-3" style={{ background: '#12121a', border: '1px solid #1e1e2e' }}>
              <div className="text-gray-400 mb-1">Queries</div>
              <div className="text-gray-200 font-bold">{storage.stats.total}</div>
              <div className="text-gray-400">Schema v{CURRENT_SCHEMA_VERSION}</div>
            </div>
            <div className="rounded-lg p-3" style={{ background: '#12121a', border: '1px solid #1e1e2e' }}>
              <div className="text-gray-400 mb-1">Storage Used</div>
              <div className="text-gray-200 font-bold">{totalSizeKB.toFixed(1)} KB</div>
              <div className="text-gray-400">/ {maxSizeKB} KB ({(totalSizeKB / maxSizeKB * 100).toFixed(1)}%)</div>
              <div className="mt-1 h-1 rounded-full overflow-hidden" style={{ background: '#1a1a2e' }}>
                <div className="h-full rounded-full" style={{ width: Math.min(100, totalSizeKB / maxSizeKB * 100) + '%', background: totalSizeKB / maxSizeKB > 0.8 ? '#ff4444' : '#00ff88' }} />
              </div>
            </div>
            <div className="rounded-lg p-3" style={{ background: '#12121a', border: '1px solid #1e1e2e' }}>
              <div className="text-gray-400 mb-1">Last Saved</div>
              <div className="text-gray-200">{storage.lastSavedTimestamp ? new Date(storage.lastSavedTimestamp).toLocaleTimeString() : 'Never'}</div>
              <div className="text-gray-400 mt-1">Backup</div>
              <div className="text-gray-200">{storage.backupTimestamp ? new Date(storage.backupTimestamp).toLocaleTimeString() : 'Never'}</div>
            </div>
          </div>
        )}

        {/* Keys Tab */}
        {activeTab === 'keys' && (
          <div className="space-y-2">
            {keyList.length === 0 ? (
              <div className="text-gray-400 text-center py-4">No storage keys found</div>
            ) : keyList.map(k => (
              <div key={k} className="flex items-center justify-between px-3 py-2 rounded-lg"
                style={{ background: '#12121a', border: '1px solid #1e1e2e' }}>
                <div className="flex items-center gap-3">
                  <span style={{ color: '#00d4ff' }}>{k}</span>
                  <span className="text-gray-400">{keySizes[k] >= 0 ? keySizes[k].toFixed(1) + ' KB' : 'Error'}</span>
                </div>
                <button onClick={() => { setActiveTab('data'); handleViewKey(k); }}
                  aria-label={`View contents of ${k}`}
                  className={`px-2 py-1 rounded text-xs ${FOCUS_RING}`} style={{ color: '#00d4ff', border: '1px solid #2a2a3e' }}>
                  <Eye size={12} className="inline mr-1" aria-hidden="true" />View
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Operations Tab */}
        {activeTab === 'operations' && (
          <div className="space-y-1">
            {ops.length === 0 ? (
              <div className="text-gray-400 text-center py-4">No operations logged yet</div>
            ) : [...ops].reverse().map((op, i) => {
              const color = !op.success ? '#ff4444' : op.latencyMs > 200 ? '#ffcc00' : '#00ff88';
              return (
                <div key={i} className="flex items-center gap-3 px-3 py-1.5 rounded" style={{ background: '#12121a' }}>
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
                  <span className="text-gray-400 w-20 shrink-0">{new Date(op.timestamp).toLocaleTimeString()}</span>
                  <span className="w-12 shrink-0 font-bold" style={{ color }}>{op.type}</span>
                  <span className="text-gray-400 flex-1 truncate">{op.key}</span>
                  <span className="text-gray-400 w-16 text-right shrink-0">{op.latencyMs}ms</span>
                  {op.sizeBytes > 0 && <span className="text-gray-400 w-16 text-right shrink-0">{Math.round(op.sizeBytes / 1024)}KB</span>}
                  {op.error && <span className="text-red-500 truncate max-w-40">{op.error}</span>}
                </div>
              );
            })}
          </div>
        )}

        {/* Data Tab */}
        {activeTab === 'data' && (
          <div>
            <div className="flex items-center gap-2 mb-3">
              <label className="text-gray-400" htmlFor={dataKeyId}>Key:</label>
              <select id={dataKeyId} className={`px-2 py-1 rounded text-xs ${FOCUS_RING}`} style={{ background: '#1a1a2e', border: '1px solid #2a2a3e', color: '#00d4ff' }}
                value={rawDataKey || ''} onChange={(e) => e.target.value && handleViewKey(e.target.value)}>
                <option value="">Select a key...</option>
                {keyList.map(k => <option key={k} value={k}>{k}</option>)}
              </select>
            </div>
            {rawDataLoading && <div className="text-gray-400">Loading...</div>}
            {rawData && !rawDataLoading && (
              <pre className="rounded-lg p-3 overflow-auto max-h-72 text-xs leading-relaxed"
                style={{ background: '#0a0a0f', border: '1px solid #1a1a2e', color: '#98c379' }}>{rawData}</pre>
            )}
          </div>
        )}

        {/* Danger Tab */}
        {activeTab === 'danger' && (
          <div className="space-y-4">
            <div className="rounded-lg p-4" style={{ background: '#1a1010', border: '1px solid #ff444440' }}>
              {/* h3, not h4: the nearest preceding heading in the document is an h2, and
                  skipping a level is what axe reports as heading-order. */}
              <h3 className="font-bold mb-3" style={{ color: '#ff4444' }}>
                <AlertTriangle size={14} className="inline mr-2" aria-hidden="true" />Danger Zone
              </h3>
              <div className="space-y-3">
                {/* Purge */}
                <div className="flex items-center gap-3">
                  <div className="flex-1">
                    <label className="text-gray-300 mb-1 block" htmlFor={purgeId}>Purge All Storage</label>
                    <div className="text-gray-400" id={`${purgeId}-hint`}>Type DELETE to confirm</div>
                    <input id={purgeId} aria-describedby={`${purgeId}-hint`} className={`mt-1 px-2 py-1 rounded text-xs w-32 ${FOCUS_RING}`}
                      style={{ background: '#12121a', border: '1px solid #2a2a3e', color: '#ff4444' }}
                      value={purgeConfirm} onChange={(e) => setPurgeConfirm(e.target.value)} placeholder="Type DELETE" />
                  </div>
                  <button onClick={handlePurge} disabled={purgeConfirm !== 'DELETE'}
                    aria-label="Purge all storage"
                    className={`px-4 py-2 rounded-lg text-xs font-bold disabled:opacity-30 ${FOCUS_RING}`}
                    style={{ background: purgeConfirm === 'DELETE' ? '#ff4444' : '#2a1010', color: '#fff', border: '1px solid #ff4444' }}>
                    Purge
                  </button>
                </div>

                {/* Force Backup */}
                <div className="flex items-center gap-3" style={{ borderTop: '1px solid #2a2a3e', paddingTop: 12 }}>
                  <div className="flex-1">
                    <div className="text-gray-300">Force Backup Now</div>
                    <div className="text-gray-400">Write current data to backup key immediately</div>
                  </div>
                  <button onClick={onForceBackup}
                    aria-label="Force a backup now"
                    className={`px-4 py-2 rounded-lg text-xs font-bold ${FOCUS_RING}`}
                    style={{ background: '#102a10', color: '#00ff88', border: '1px solid #00ff88' }}>
                    Backup
                  </button>
                </div>

                {/* Health Check */}
                <div className="flex items-center gap-3" style={{ borderTop: '1px solid #2a2a3e', paddingTop: 12 }}>
                  <div className="flex-1">
                    <div className="text-gray-300">Run Health Check</div>
                    <div className="text-gray-400">Write/read/delete test, validate data schema</div>
                  </div>
                  <button onClick={handleHealthCheck} disabled={healthRunning}
                    aria-label="Run storage health check"
                    className={`px-4 py-2 rounded-lg text-xs font-bold ${FOCUS_RING}`}
                    style={{ background: '#101a2a', color: '#00d4ff', border: '1px solid #00d4ff' }}>
                    {healthRunning ? 'Running...' : 'Check'}
                  </button>
                </div>

                {/* Always rendered so it is a live region that gets updated rather than one
                    that gets inserted; the latter is announced far less reliably. */}
                <div role="status" aria-live="polite">
                {healthResult && (
                  <div className="mt-3 rounded-lg p-3" style={{ background: '#0a0a0f', border: '1px solid #1a1a2e' }}>
                    <div className="flex items-center gap-2 mb-2">
                      <Shield size={14} style={{ color: healthResult.ok ? '#00ff88' : '#ff4444' }} aria-hidden="true" />
                      <span style={{ color: healthResult.ok ? '#00ff88' : '#ff4444' }} className="font-bold">
                        {healthResult.ok ? 'All checks passed' : 'Issues detected'}
                      </span>
                    </div>
                    <div className="space-y-1">
                      {healthResult.details.map((d, i) => (
                        <div key={i} className="text-gray-400">{d}</div>
                      ))}
                    </div>
                    <div className="mt-2 grid grid-cols-4 gap-2 text-center">
                      <div>
                        <div className="text-gray-400">Writable</div>
                        <div style={{ color: healthResult.writable ? '#00ff88' : '#ff4444' }}>{healthResult.writable ? 'Yes' : 'No'}</div>
                      </div>
                      <div>
                        <div className="text-gray-400">Readable</div>
                        <div style={{ color: healthResult.readable ? '#00ff88' : '#ff4444' }}>{healthResult.readable ? 'Yes' : 'No'}</div>
                      </div>
                      <div>
                        <div className="text-gray-400">Data Valid</div>
                        <div style={{ color: healthResult.dataValid ? '#00ff88' : '#ff4444' }}>{healthResult.dataValid ? 'Yes' : 'No'}</div>
                      </div>
                      <div>
                        <div className="text-gray-400">Size</div>
                        <div className="text-gray-300">{healthResult.estimatedSizeKB} KB</div>
                      </div>
                    </div>
                  </div>
                )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export { StorageInspector };
