import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

const num = (x: unknown): number | null =>
  typeof x === "number" && Number.isFinite(x) ? x : null;
const strs = (x: unknown): string[] =>
  Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : [];

/**
 * Apply one batch from the engine. Invalid events are REJECTED and reported
 * (returned + counted), never defaulted and never silently dropped.
 */
export const apply = internalMutation({
  args: {
    events: v.array(
      v.object({
        kind: v.union(
          v.literal("signal"),
          v.literal("market"),
          v.literal("feed_health"),
          v.literal("telemetry"),
          v.literal("balance"),
        ),
        data: v.any(),
        at: v.number(),
      }),
    ),
  },
  handler: async (ctx, { events }) => {
    const now = Date.now();
    let accepted = 0;
    const rejected: string[] = [];

    for (const ev of events) {
      const d = ev.data as Record<string, any>;
      if (ev.kind === "signal") {
        const score = num(d?.score?.final);
        if (typeof d?.id !== "string" || typeof d?.symbol !== "string" || score === null
            || typeof d?.action !== "string") {
          rejected.push(`signal missing id/symbol/action/score.final`);
          continue;
        }
        const doc = {
          sigId: d.id,
          symbol: d.symbol,
          timeframe: String(d.timeframe ?? ""),
          action: d.action,
          state: String(d.state ?? "CANDIDATE"),
          scoreFinal: score,
          grade: String(d.score?.grade ?? ""),
          confidence: num(d.confidence),
          regime: d.regime ?? null,
          consensus: d.consensus ?? null,
          votes: d.votes ?? [],
          entry: d.entry ?? null,
          stopLoss: d.stopLoss ?? null,
          targets: d.targets ?? null,
          positionSize: num(d.positionSize),
          reasons: strs(d.reasons),
          blockedReasons: strs(d.blockedReasons),
          engines: d.engines ?? null,
          timestamp: num(d.timestamp) ?? ev.at,
        };
        const existing = await ctx.db
          .query("signals").withIndex("by_sigId", (q) => q.eq("sigId", d.id)).unique();
        if (existing) await ctx.db.replace(existing._id, doc);
        else await ctx.db.insert("signals", doc);
        accepted++;
      } else if (ev.kind === "market") {
        const price = num(d?.price);
        if (typeof d?.symbol !== "string" || price === null) {
          rejected.push("market missing symbol/price");
          continue;
        }
        const doc = {
          symbol: d.symbol, price,
          bid: num(d.bid), ask: num(d.ask), change: num(d.change),
          source: String(d.source ?? "unknown"),
          ts: num(d.ts) ?? ev.at, receivedAt: now,
        };
        const existing = await ctx.db
          .query("market").withIndex("by_symbol", (q) => q.eq("symbol", d.symbol)).unique();
        if (existing) await ctx.db.replace(existing._id, doc);
        else await ctx.db.insert("market", doc);
        accepted++;
      } else {
        const existing = await ctx.db
          .query("systemState").withIndex("by_key", (q) => q.eq("key", ev.kind)).unique();
        const doc = { key: ev.kind, data: d, at: ev.at };
        if (existing) await ctx.db.replace(existing._id, doc);
        else await ctx.db.insert("systemState", doc);
        accepted++;
      }
    }

    const stats = await ctx.db
      .query("ingestStats").withIndex("by_key", (q) => q.eq("key", "main")).unique();
    const next = {
      key: "main" as const,
      batches: (stats?.batches ?? 0) + 1,
      events: (stats?.events ?? 0) + accepted,
      rejected: (stats?.rejected ?? 0) + rejected.length,
      lastBatchAt: now,
      lastRejection: rejected[0] ?? stats?.lastRejection,
    };
    if (stats) await ctx.db.replace(stats._id, next);
    else await ctx.db.insert("ingestStats", next);

    return { accepted, rejected };
  },
});
