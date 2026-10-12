export interface Tick { type: "tick"; symbol: string; price: number; ts: number; source: string }
export interface Feed { name: string; state: string; age_ms: number | null; msgs: number; reconnects: number; error: string }
export type Conn = "connecting" | "open" | "closed";
export type Link = "live" | "stale" | "offline";
