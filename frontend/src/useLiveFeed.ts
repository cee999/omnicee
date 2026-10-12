import { useEffect, useRef, useState } from "react";
import type { Conn, Feed, Link, Tick } from "./types";

const HIST = 80;

export interface LiveState {
  link: Link;
  conn: Conn;
  lastMsgAgeMs: number | null;
  watchlist: string[];
  ticks: Record<string, Tick>;
  open: Record<string, number>; // first price seen this session, for session change %
  hist: Record<string, number[]>;
  feeds: Feed[];
}

function defaultUrl(): string {
  const env = import.meta.env.VITE_WS_URL as string | undefined;
  if (env) return env;
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
}

export function useLiveFeed(): LiveState {
  const [conn, setConn] = useState<Conn>("connecting");
  const [now, setNow] = useState(Date.now());
  const [watchlist, setWatchlist] = useState<string[]>([]);
  const [ticks, setTicks] = useState<Record<string, Tick>>({});
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [hist, setHist] = useState<Record<string, number[]>>({});
  const openRef = useRef<Record<string, number>>({});
  const bufRef = useRef<Tick[]>([]);
  const lastMsg = useRef(0);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry = 1000;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;

    const connect = () => {
      setConn("connecting");
      ws = new WebSocket(defaultUrl());
      ws.onopen = () => { setConn("open"); retry = 1000; };
      ws.onmessage = (e) => {
        lastMsg.current = Date.now();
        const m = JSON.parse(e.data);
        if (m.type === "snapshot") {
          setWatchlist(m.watchlist ?? []);
          setFeeds(m.feeds ?? []);
          bufRef.current.push(...(m.ticks as Tick[]));
        } else if (m.type === "tick") bufRef.current.push(m as Tick);
        else if (m.type === "status") setFeeds(m.feeds ?? []);
      };
      ws.onclose = () => {
        setConn("closed");
        if (!stop) { timer = setTimeout(connect, retry); retry = Math.min(retry * 2, 15000); }
      };
      ws.onerror = () => ws?.close();
    };
    connect();

    // Batch tick updates so a busy feed does not re-render the tree per message.
    const flush = setInterval(() => {
      const batch = bufRef.current;
      if (!batch.length) return;
      bufRef.current = [];
      setTicks((prev) => {
        const next = { ...prev };
        for (const t of batch) next[t.symbol] = t;
        return next;
      });
      setHist((prev) => {
        const next = { ...prev };
        for (const t of batch) {
          if (openRef.current[t.symbol] === undefined) openRef.current[t.symbol] = t.price;
          const arr = (next[t.symbol] ?? []).concat(t.price);
          next[t.symbol] = arr.length > HIST ? arr.slice(arr.length - HIST) : arr;
        }
        return next;
      });
    }, 200);
    const clock = setInterval(() => setNow(Date.now()), 1000);

    return () => { stop = true; clearTimeout(timer); clearInterval(flush); clearInterval(clock); ws?.close(); };
  }, []);

  const age = lastMsg.current ? now - lastMsg.current : null;
  const link: Link = conn !== "open" ? "offline" : age !== null && age > 5000 ? "stale" : "live";
  return { link, conn, lastMsgAgeMs: age, watchlist, ticks, open: openRef.current, hist, feeds };
}
