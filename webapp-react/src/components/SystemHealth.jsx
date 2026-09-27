"""System health and diagnostics display components."""

export function SystemHealthCard({ status }) {
  if (!status) return null;

  const healthColor = status.online ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200';
  const textColor = status.online ? 'text-green-700' : 'text-red-700';

  return (
    <div className={`p-4 rounded-lg border ${healthColor}`}>
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-semibold text-lg">System Status</h3>
        <div className={`inline-flex items-center gap-2 px-3 py-1 rounded-full ${textColor} bg-white border`}>
          <div className={`w-2 h-2 rounded-full ${status.online ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`} />
          <span className="text-sm font-medium">{status.online ? 'Online' : 'Offline'}</span>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Engine Stats */}
        <div className="bg-white rounded p-3 border border-gray-100">
          <div className="text-xs text-gray-600 font-medium uppercase mb-1">Engine</div>
          <div className="text-sm font-mono">
            <div className="text-lg font-bold text-blue-600">{status.engine.cycles_completed}</div>
            <div className="text-xs text-gray-600">cycles @ {status.engine.avg_cycle_ms}ms avg</div>
          </div>
          {status.engine.error_rate_pct > 0 && (
            <div className="text-xs mt-1 text-red-600">⚠ {status.engine.error_rate_pct.toFixed(1)}% errors</div>
          )}
        </div>

        {/* Resources */}
        <div className="bg-white rounded p-3 border border-gray-100">
          <div className="text-xs text-gray-600 font-medium uppercase mb-1">Resources</div>
          <div className="text-sm font-mono">
            <div className="text-xs text-gray-700">Memory: <span className="font-bold">{status.resources.memory_mb.toFixed(0)}MB</span></div>
            <div className="text-xs text-gray-700">CPU: <span className="font-bold">{status.resources.cpu_percent.toFixed(1)}%</span></div>
            <div className="text-xs text-gray-700">Up: <span className="font-bold">{Math.floor(status.resources.uptime_sec / 3600)}h</span></div>
          </div>
        </div>

        {/* Feeds */}
        <div className="bg-white rounded p-3 border border-gray-100">
          <div className="text-xs text-gray-600 font-medium uppercase mb-1">Feeds</div>
          <div className="text-sm font-mono">
            <div className="text-xs text-gray-700">Healthy: <span className="font-bold text-green-600">{status.feeds.healthy}</span></div>
            {status.feeds.unhealthy > 0 && (
              <div className="text-xs text-red-600 font-bold">Unhealthy: {status.feeds.unhealthy}</div>
            )}
            {status.feeds.any_stale && <div className="text-xs text-yellow-600">⚠ Stale data</div>}
          </div>
        </div>

        {/* Persistence */}
        <div className="bg-white rounded p-3 border border-gray-100">
          <div className="text-xs text-gray-600 font-medium uppercase mb-1">Persistence</div>
          <div className="text-sm font-mono">
            <div className={`text-xs font-bold ${status.persistence.connected ? 'text-green-600' : 'text-orange-600'}`}>
              {status.persistence.connected ? '✓ Connected' : '○ Offline'}
            </div>
            <div className="text-xs text-gray-700 mt-1">Signals today: {status.persistence.signals_today}</div>
          </div>
        </div>
      </div>

      {/* Alerts */}
      {(status.alerts.critical > 0 || status.alerts.warnings > 0) && (
        <div className="mt-4 pt-4 border-t border-gray-200">
          {status.alerts.critical > 0 && (
            <div className="mb-2 p-2 bg-red-100 border border-red-300 rounded text-xs text-red-800">
              <strong className="block mb-1">⚠ Critical Issues ({status.alerts.critical}):</strong>
              {status.alerts.issues.slice(0, status.alerts.critical).map((issue, i) => (
                <div key={i} className="ml-2">• {issue}</div>
              ))}
            </div>
          )}
          {status.alerts.warnings > 0 && (
            <div className="p-2 bg-yellow-100 border border-yellow-300 rounded text-xs text-yellow-800">
              <strong className="block mb-1">ℹ Warnings ({status.alerts.warnings})</strong>
            </div>
          )}
        </div>
      )}

      <div className="mt-4 pt-4 border-t border-gray-200 text-xs text-gray-600">
        <div>Mode: <strong>{status.config.mode}</strong></div>
        <div>Symbols: {status.config.symbols.length} active</div>
        <div>Timeframes: {status.config.timeframes.join(', ')}</div>
      </div>
    </div>
  );
}

export function DiagnosticsPanel({ diagnostics }) {
  if (!diagnostics) return null;

  return (
    <div className="p-4 rounded-lg border border-gray-200 bg-gray-50">
      <h3 className="font-semibold text-lg mb-4">Live Diagnostics</h3>

      <div className="space-y-3">
        {/* Cycles */}
        <div>
          <div className="text-xs font-medium text-gray-700 uppercase mb-1">Processing Cycles</div>
          <div className="text-sm font-mono text-gray-900">
            Completed: <strong>{diagnostics.cycles_completed}</strong>
            {diagnostics.last_cycle_duration_ms > 0 && (
              <> | Avg: <strong>{diagnostics.avg_cycle_duration_ms.toFixed(1)}ms</strong> | Last: <strong>{diagnostics.last_cycle_duration_ms.toFixed(1)}ms</strong></>
            )}
            {diagnostics.cycle_error_rate > 0 && (
              <> | Error Rate: <span className="text-red-600"><strong>{diagnostics.cycle_error_rate.toFixed(1)}%</strong></span></>
            )}
          </div>
        </div>

        {/* Feed Status */}
        {diagnostics.feeds_healthy > 0 || diagnostics.feeds_unhealthy > 0 ? (
          <div>
            <div className="text-xs font-medium text-gray-700 uppercase mb-1">Feed Health</div>
            <div className="text-sm font-mono text-gray-900">
              <span className="text-green-600">✓ {diagnostics.feeds_healthy} healthy</span>
              {diagnostics.feeds_unhealthy > 0 && <span className="ml-2 text-red-600">✗ {diagnostics.feeds_unhealthy} unhealthy</span>}
              {diagnostics.any_feed_stale && <span className="ml-2 text-yellow-600">⚠ data is stale</span>}
            </div>
          </div>
        ) : null}

        {/* Database */}
        <div>
          <div className="text-xs font-medium text-gray-700 uppercase mb-1">Database</div>
          <div className="text-sm font-mono text-gray-900">
            {diagnostics.db_connected === true ? (
              <span className="text-green-600">✓ Connected (persisting)</span>
            ) : diagnostics.db_connected === false ? (
              <span className="text-orange-600">○ Offline (local only)</span>
            ) : (
              <span className="text-gray-600">— Disabled</span>
            )}
          </div>
        </div>

        {/* System Resources */}
        <div>
          <div className="text-xs font-medium text-gray-700 uppercase mb-1">System Resources</div>
          <div className="text-sm font-mono text-gray-900">
            Memory: <strong>{diagnostics.memory_mb.toFixed(0)}MB</strong> | CPU: <strong>{diagnostics.cpu_percent.toFixed(1)}%</strong> | Uptime: <strong>{Math.floor(diagnostics.uptime_sec / 3600)}h {Math.floor((diagnostics.uptime_sec % 3600) / 60)}m</strong>
          </div>
        </div>
      </div>

      {/* Critical Issues */}
      {diagnostics.critical_issues.length > 0 && (
        <div className="mt-3 pt-3 border-t border-gray-300">
          <div className="text-xs font-medium text-red-700 uppercase mb-2">Critical Issues</div>
          <div className="space-y-1">
            {diagnostics.critical_issues.map((issue, i) => (
              <div key={i} className="text-xs text-red-700 bg-red-50 p-2 rounded border border-red-200">
                • {issue}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Warnings */}
      {diagnostics.warnings.length > 0 && (
        <div className="mt-3 pt-3 border-t border-gray-300">
          <div className="text-xs font-medium text-yellow-700 uppercase mb-2">Warnings</div>
          <div className="space-y-1">
            {diagnostics.warnings.map((warning, i) => (
              <div key={i} className="text-xs text-yellow-700 bg-yellow-50 p-2 rounded border border-yellow-200">
                ℹ {warning}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
