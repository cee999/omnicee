import { useMemo, useRef, useState } from "react";
import OmniceeBackdrop, { type Regime } from "./OmniceeBackdrop";
import Spark from "./Spark";
import { useLiveFeed } from "./useLiveFeed";

type View = "market" | "signals" | "smart" | "feeds" | "keys";
const NAV: { id: View; label: string; glyph: string }[] = [
  { id: "market", label: "Market", glyph: "▤" },
  { id: "signals", label: "Signals", glyph: "◈" },
  { id: "smart", label: "Smart money", glyph: "◎" },
  { id: "feeds", label: "Feeds", glyph: "≋" },
  { id: "keys", label: "Keys", glyph: "⚿" },
];

const fmt = (p: number) =>
  p >= 1000 ? p.toLocaleString(undefined, { maximumFractionDigits: 2 }) : p >= 1 ? p.toFixed(3) : p.toFixed(5);

function Card({ sym, price, open, hist }: { sym: string; price: number; open: number; hist: number[] }) {
  const prev = useRef(price);
  const dir = price > prev.current ? "up" : price < prev.current ? "down" : "";
  prev.current = price;
  const chg = open ? ((price - open) / open) * 100 : 0;
  return (
    <article className="panel card">
      <header><b>{sym}</b><span className={chg >= 0 ? "up" : "down"}>{chg >= 0 ? "+" : ""}{chg.toFixed(2)}%</span></header>
      <div key={price} className={`price ${dir}`}>{fmt(price)}</div>
      <Spark data={hist} up={chg >= 0} />
    </article>
  );
}

function Soon({ title, body }: { title: string; body: string }) {
  return (
    <section className="panel soon">
      <h2>{title}</h2>
      <p>{body}</p>
    </section>
  );
}

export default function App() {
  const live = useLiveFeed();
  const [view, setView] = useState<View>("market");

  const regime: Regime = useMemo(() => {
    const ch = Object.keys(live.ticks).map((s) => (live.open[s] ? (live.ticks[s].price - live.open[s]) / live.open[s] : 0));
    if (!ch.length) return "neutral";
    const avg = ch.reduce((a, b) => a + b, 0) / ch.length;
    return avg > 0.001 ? "bull" : avg < -0.001 ? "bear" : "neutral";
  }, [live.ticks, live.open]);

  const pill = { live: "Live", stale: "Stale", offline: "Offline" }[live.link];
  const symbols = live.watchlist.length ? live.watchlist : Object.keys(live.ticks);

  return (
    <>
      <OmniceeBackdrop regime={regime} />
      <div className="shell">
        <nav className="rail" aria-label="Primary">
          <div className="mark">Ω</div>
          {NAV.map((n) => (
            <button key={n.id} className={view === n.id ? "on" : ""} onClick={() => setView(n.id)} aria-label={n.label}>
              <span className="glyph">{n.glyph}</span><span className="lbl">{n.label}</span>
            </button>
          ))}
        </nav>

        <main>
          <header className="top">
            <h1>OMNICEE</h1>
            <div className={`pill ${live.link}`} role="status">
              <i />{pill}
              {live.lastMsgAgeMs !== null && <span>{(live.lastMsgAgeMs / 1000).toFixed(0)}s ago</span>}
            </div>
          </header>

          {view === "market" && (
            <section className="grid">
              {symbols.map((s) =>
                live.ticks[s] ? (
                  <Card key={s} sym={s} price={live.ticks[s].price} open={live.open[s]} hist={live.hist[s] ?? []} />
                ) : (
                  <article key={s} className="panel card waiting"><header><b>{s}</b></header><div className="price">waiting for tick…</div></article>
                ),
              )}
              {!symbols.length && <Soon title="No data yet" body={live.link === "offline" ? "Cannot reach the backend. Retrying automatically." : "Connected, waiting for the first tick."} />}
            </section>
          )}

          {view === "feeds" && (
            <section className="panel table">
              <table>
                <thead><tr><th>Provider</th><th>State</th><th>Last msg</th><th>Msgs</th><th>Reconnects</th></tr></thead>
                <tbody>
                  {live.feeds.map((f) => (
                    <tr key={f.name}>
                      <td>{f.name}</td>
                      <td className={f.state}>{f.state}</td>
                      <td>{f.age_ms === null ? "—" : `${(f.age_ms / 1000).toFixed(1)}s`}</td>
                      <td>{f.msgs.toLocaleString()}</td>
                      <td>{f.reconnects}</td>
                    </tr>
                  ))}
                  {!live.feeds.length && <tr><td colSpan={5}>No feed data yet.</td></tr>}
                </tbody>
              </table>
              {live.feeds.some((f) => f.error) && <p className="err">{live.feeds.find((f) => f.error)?.error}</p>}
            </section>
          )}

          {view === "signals" && <Soon title="Signals" body="The six agents and the consensus radar plug in here once the signal pipeline is ported to Python." />}
          {view === "smart" && <Soon title="Smart money" body="Quiver Quant feed (congress, insiders, contracts) lands here after the key vault is built." />}
          {view === "keys" && <Soon title="API keys" body="Encrypted key vault and provider router. Keys will be stored server-side only." />}
        </main>
      </div>
    </>
  );
}
