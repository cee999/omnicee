import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireUser } from "./auth";

/** Live feed for the dashboard. Convex pushes changes; no polling, no sockets. */
export const recentSignals = query({
  args: { symbol: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, { symbol, limit }) => {
    await requireUser(ctx);
    const n = Math.min(Math.max(limit ?? 50, 1), 200);
    if (symbol) {
      return ctx.db.query("signals")
        .withIndex("by_symbol_time", (q) => q.eq("symbol", symbol.toUpperCase()))
        .order("desc").take(n);
    }
    return ctx.db.query("signals").withIndex("by_time").order("desc").take(n);
  },
});

export const latestMarket = query({
  args: {},
  handler: async (ctx) => {
    await requireUser(ctx);
    const rows = await ctx.db.query("market").collect();
    const now = Date.now();
    // age is computed server-side so the UI can grey out stale quotes honestly
    return rows.map((r) => ({ ...r, ageMs: now - r.receivedAt }));
  },
});

/** Engine/feeds/ingest status. If the engine goes quiet this shows it. */
export const systemStatus = query({
  args: {},
  handler: async (ctx) => {
    await requireUser(ctx);
    const state = await ctx.db.query("systemState").collect();
    const ingest = await ctx.db.query("ingestStats")
      .withIndex("by_key", (q) => q.eq("key", "main")).unique();
    return {
      state: Object.fromEntries(state.map((s) => [s.key, { data: s.data, at: s.at }])),
      ingest,
    };
  },
});
