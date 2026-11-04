// Live system health, rendered from GET /api/system-status.
// Rule: an unknown value is shown as "—", never as 0 (a made-up zero reads as real data).

const STATUS_STYLE = {
  ok: { color: 'var(--emerald)', label: 'OK' },
  degraded: { color: 'var(--gold)', label: 'DEGRADED' },
  critical: { color: 'var(--coral)', label: 'CRITICAL' },
};

const dash = (v, fmt = (x) => x) => (v === null || v === undefined ? '—' : fmt(v));

function formatUptime(sec) {
  if (sec === null || sec === undefined) return '—';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function engineLabel(engine) {
  if (!engine.enabled) return { text: 'DISABLED', color: 'var(--textFaint)' };
  return engine.running
    ? { text: 'RUNNING', color: 'var(--emerald)' }
    : { text: 'STOPPED', color: 'var(--coral)' };
}

function dbLabel(connected) {
  if (connected === true) return { text: 'CONNECTED', color: 'var(--emerald)' };
  if (connected === false) return { text: 'UNREACHABLE', color: 'var(--coral)' };
  return { text: 'NOT CONFIGURED', color: 'var(--textFaint)' };
}

function Cell({ title, children }) {
  return (
    <div className="p-3 rounded border" style={{ borderColor: 'var(--border)' }}>
      <div className="font-mono text-[10px] uppercase tracking-wider mb-1" style={{ color: 'var(--textFaint)' }}>{title}</div>
      <div className="font-mono text-[12px] space-y-0.5" style={{ color: 'var(--textDim)' }}>{children}</div>
    </div>
  );
}

export function SystemStatusPanel({ status, error }) {
  if (!status) {
    return (
      <div className="font-mono text-[12px]" style={{ color: error ? 'var(--coral)' : 'var(--textFaint)' }}>
        {error ? `STATUS UNAVAILABLE — ${error}` : 'Loading system status…'}
      </div>
    );
  }

  const { engine, feeds, resources, persistence, issues } = status;
  const overall = STATUS_STYLE[status.status] || STATUS_STYLE.degraded;
  const eng = engineLabel(engine);
  const db = dbLabel(persistence.connected);

  return (
    <div className="space-y-3">
      {/* If a refresh fails after a successful load, keep the last data but say it is stale. */}
      {error && (
        <div className="font-mono text-[10px]" style={{ color: 'var(--gold)' }}>
          Showing last known status — refresh failed: {error}
        </div>
      )}
      <div className="font-mono text-[12px] flex items-center gap-2" role="status">
        <span aria-hidden="true" style={{ color: overall.color }}>●</span>
        <span style={{ color: overall.color }}>{overall.label}</span>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Cell title="Engine">
          <div style={{ color: eng.color }}>{eng.text}</div>
          <div>{dash(engine.cyclesCompleted)} cycles</div>
          <div>last {dash(engine.lastCycleMs, (v) => `${Math.round(v)}ms`)}</div>
          <div>errors {dash(engine.errorRatePct, (v) => `${v}%`)}</div>
          <div>breaker {dash(engine.circuitBreaker)}</div>
        </Cell>
        <Cell title="Feeds">
          <div>{dash(feeds.healthy)} / {dash(feeds.total)} connected</div>
          <div>stale series {dash(feeds.staleSeries)}</div>
        </Cell>
        <Cell title="Database">
          <div style={{ color: db.color }}>{db.text}</div>
        </Cell>
        <Cell title="Resources">
          <div>mem {dash(resources.memoryMb, (v) => `${Math.round(v)}MB`)}</div>
          <div>cpu {dash(resources.cpuPercent, (v) => `${v}%`)}</div>
          <div>up {formatUptime(resources.uptimeSec)}</div>
        </Cell>
      </div>

      {(issues.critical.length > 0 || issues.warnings.length > 0) && (
        <ul className="font-mono text-[11px] space-y-1">
          {issues.critical.map((m) => (
            <li key={`c-${m}`} style={{ color: 'var(--coral)' }}>✕ {m}</li>
          ))}
          {issues.warnings.map((m) => (
            <li key={`w-${m}`} style={{ color: 'var(--gold)' }}>▲ {m}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
