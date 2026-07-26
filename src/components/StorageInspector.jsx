import React, { useState, useEffect } from 'react';
import { X, Database, AlertTriangle, Shield, Eye } from 'lucide-react';
import { CURRENT_SCHEMA_VERSION } from '../constants.js';
import { safeJsonParse } from '../lib/json.js';
import { StorageAdapter } from '../storage/adapter.js';
import { operationLog } from '../storage/opLog.js';

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
    color: active ? '#00ff88' : '#666',
    border: active ? '1px solid #2a2a3e' : '1px solid transparent',
    borderBottom: active ? '1px solid #0d0d14' : '1px solid #2a2a3e',
  });

  return (
    <div className="fixed bottom-0 left-0 right-0 z-[70] font-mono text-xs" style={{ maxHeight: '50vh' }}>
      {/* Header bar */}
      <div className="flex items-center justify-between px-4 py-2" style={{ background: '#0d0d14', borderTop: '2px solid #00ff88', borderBottom: '1px solid #2a2a3e' }}>
        <div className="flex items-center gap-3">
          <Database size={14} style={{ color: '#00ff88' }} />
          <span style={{ color: '#00ff88' }} className="font-bold">Storage Inspector</span>
          <span className="text-gray-600">|</span>
          {/* Tabs */}
          {['overview', 'keys', 'operations', 'data', 'danger'].map(tab => (
            <button key={tab} onClick={() => setActiveTab(tab)}
              className="px-3 py-1 rounded-t text-xs capitalize" style={tabStyle(activeTab === tab)}>{tab}</button>
          ))}
        </div>
        <button onClick={onClose} className="p-1 rounded hover:bg-white/10"><X size={14} className="text-gray-400" /></button>
      </div>

      {/* Content */}
      <div className="overflow-y-auto p-4" style={{ background: '#0d0d14', maxHeight: 'calc(50vh - 44px)' }}>

        {/* Overview Tab */}
        {activeTab === 'overview' && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="rounded-lg p-3" style={{ background: '#12121a', border: '1px solid #1e1e2e' }}>
              <div className="text-gray-500 mb-1">Status</div>
              <div style={{ color: storage.error ? '#ff4444' : '#00ff88' }} className="font-bold">
                {storage.error ? 'Error' : storage.isLoading ? 'Loading...' : 'Healthy'}
              </div>
              {storage.error && <div className="text-gray-600 mt-1 truncate" title={storage.error}>{storage.error}</div>}
            </div>
            <div className="rounded-lg p-3" style={{ background: '#12121a', border: '1px solid #1e1e2e' }}>
              <div className="text-gray-500 mb-1">Queries</div>
              <div className="text-gray-200 font-bold">{storage.stats.total}</div>
              <div className="text-gray-600">Schema v{CURRENT_SCHEMA_VERSION}</div>
            </div>
            <div className="rounded-lg p-3" style={{ background: '#12121a', border: '1px solid #1e1e2e' }}>
              <div className="text-gray-500 mb-1">Storage Used</div>
              <div className="text-gray-200 font-bold">{totalSizeKB.toFixed(1)} KB</div>
              <div className="text-gray-600">/ {maxSizeKB} KB ({(totalSizeKB / maxSizeKB * 100).toFixed(1)}%)</div>
              <div className="mt-1 h-1 rounded-full overflow-hidden" style={{ background: '#1a1a2e' }}>
                <div className="h-full rounded-full" style={{ width: Math.min(100, totalSizeKB / maxSizeKB * 100) + '%', background: totalSizeKB / maxSizeKB > 0.8 ? '#ff4444' : '#00ff88' }} />
              </div>
            </div>
            <div className="rounded-lg p-3" style={{ background: '#12121a', border: '1px solid #1e1e2e' }}>
              <div className="text-gray-500 mb-1">Last Saved</div>
              <div className="text-gray-200">{storage.lastSavedTimestamp ? new Date(storage.lastSavedTimestamp).toLocaleTimeString() : 'Never'}</div>
              <div className="text-gray-500 mt-1">Backup</div>
              <div className="text-gray-200">{storage.backupTimestamp ? new Date(storage.backupTimestamp).toLocaleTimeString() : 'Never'}</div>
            </div>
          </div>
        )}

        {/* Keys Tab */}
        {activeTab === 'keys' && (
          <div className="space-y-2">
            {keyList.length === 0 ? (
              <div className="text-gray-500 text-center py-4">No storage keys found</div>
            ) : keyList.map(k => (
              <div key={k} className="flex items-center justify-between px-3 py-2 rounded-lg"
                style={{ background: '#12121a', border: '1px solid #1e1e2e' }}>
                <div className="flex items-center gap-3">
                  <span style={{ color: '#00d4ff' }}>{k}</span>
                  <span className="text-gray-600">{keySizes[k] >= 0 ? keySizes[k].toFixed(1) + ' KB' : 'Error'}</span>
                </div>
                <button onClick={() => { setActiveTab('data'); handleViewKey(k); }}
                  className="px-2 py-1 rounded text-xs" style={{ color: '#00d4ff', border: '1px solid #2a2a3e' }}>
                  <Eye size={12} className="inline mr-1" />View
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Operations Tab */}
        {activeTab === 'operations' && (
          <div className="space-y-1">
            {ops.length === 0 ? (
              <div className="text-gray-500 text-center py-4">No operations logged yet</div>
            ) : [...ops].reverse().map((op, i) => {
              const color = !op.success ? '#ff4444' : op.latencyMs > 200 ? '#ffcc00' : '#00ff88';
              return (
                <div key={i} className="flex items-center gap-3 px-3 py-1.5 rounded" style={{ background: '#12121a' }}>
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
                  <span className="text-gray-600 w-20 shrink-0">{new Date(op.timestamp).toLocaleTimeString()}</span>
                  <span className="w-12 shrink-0 font-bold" style={{ color }}>{op.type}</span>
                  <span className="text-gray-400 flex-1 truncate">{op.key}</span>
                  <span className="text-gray-500 w-16 text-right shrink-0">{op.latencyMs}ms</span>
                  {op.sizeBytes > 0 && <span className="text-gray-600 w-16 text-right shrink-0">{Math.round(op.sizeBytes / 1024)}KB</span>}
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
              <span className="text-gray-500">Key:</span>
              <select className="px-2 py-1 rounded text-xs" style={{ background: '#1a1a2e', border: '1px solid #2a2a3e', color: '#00d4ff' }}
                value={rawDataKey || ''} onChange={(e) => e.target.value && handleViewKey(e.target.value)}>
                <option value="">Select a key...</option>
                {keyList.map(k => <option key={k} value={k}>{k}</option>)}
              </select>
            </div>
            {rawDataLoading && <div className="text-gray-500">Loading...</div>}
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
              <h4 className="font-bold mb-3" style={{ color: '#ff4444' }}>
                <AlertTriangle size={14} className="inline mr-2" />Danger Zone
              </h4>
              <div className="space-y-3">
                {/* Purge */}
                <div className="flex items-center gap-3">
                  <div className="flex-1">
                    <div className="text-gray-300 mb-1">Purge All Storage</div>
                    <div className="text-gray-600">Type DELETE to confirm</div>
                    <input className="mt-1 px-2 py-1 rounded text-xs w-32"
                      style={{ background: '#12121a', border: '1px solid #2a2a3e', color: '#ff4444' }}
                      value={purgeConfirm} onChange={(e) => setPurgeConfirm(e.target.value)} placeholder="Type DELETE" />
                  </div>
                  <button onClick={handlePurge} disabled={purgeConfirm !== 'DELETE'}
                    className="px-4 py-2 rounded-lg text-xs font-bold disabled:opacity-30"
                    style={{ background: purgeConfirm === 'DELETE' ? '#ff4444' : '#2a1010', color: '#fff', border: '1px solid #ff4444' }}>
                    Purge
                  </button>
                </div>

                {/* Force Backup */}
                <div className="flex items-center gap-3" style={{ borderTop: '1px solid #2a2a3e', paddingTop: 12 }}>
                  <div className="flex-1">
                    <div className="text-gray-300">Force Backup Now</div>
                    <div className="text-gray-600">Write current data to backup key immediately</div>
                  </div>
                  <button onClick={onForceBackup}
                    className="px-4 py-2 rounded-lg text-xs font-bold"
                    style={{ background: '#102a10', color: '#00ff88', border: '1px solid #00ff88' }}>
                    Backup
                  </button>
                </div>

                {/* Health Check */}
                <div className="flex items-center gap-3" style={{ borderTop: '1px solid #2a2a3e', paddingTop: 12 }}>
                  <div className="flex-1">
                    <div className="text-gray-300">Run Health Check</div>
                    <div className="text-gray-600">Write/read/delete test, validate data schema</div>
                  </div>
                  <button onClick={handleHealthCheck} disabled={healthRunning}
                    className="px-4 py-2 rounded-lg text-xs font-bold"
                    style={{ background: '#101a2a', color: '#00d4ff', border: '1px solid #00d4ff' }}>
                    {healthRunning ? 'Running...' : 'Check'}
                  </button>
                </div>

                {healthResult && (
                  <div className="mt-3 rounded-lg p-3" style={{ background: '#0a0a0f', border: '1px solid #1a1a2e' }}>
                    <div className="flex items-center gap-2 mb-2">
                      <Shield size={14} style={{ color: healthResult.ok ? '#00ff88' : '#ff4444' }} />
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
                        <div className="text-gray-600">Writable</div>
                        <div style={{ color: healthResult.writable ? '#00ff88' : '#ff4444' }}>{healthResult.writable ? 'Yes' : 'No'}</div>
                      </div>
                      <div>
                        <div className="text-gray-600">Readable</div>
                        <div style={{ color: healthResult.readable ? '#00ff88' : '#ff4444' }}>{healthResult.readable ? 'Yes' : 'No'}</div>
                      </div>
                      <div>
                        <div className="text-gray-600">Data Valid</div>
                        <div style={{ color: healthResult.dataValid ? '#00ff88' : '#ff4444' }}>{healthResult.dataValid ? 'Yes' : 'No'}</div>
                      </div>
                      <div>
                        <div className="text-gray-600">Size</div>
                        <div className="text-gray-300">{healthResult.estimatedSizeKB} KB</div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// Table Selector Component

export { StorageInspector };
