import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Convex is the system of record for everything the dashboard shows live.
 * The Python engine is the only writer (via convex/http.ts -> ingest.ts).
 *
 * AGENTS.md rule 1 applies here too: an unknown value is `null`, never 0.
 * That is why bid/ask/confidence are number-or-null, not defaulted.
 */
const nullableNumber = v.union(v.number(), v.null());

export default defineSchema({
  // Actionable signals only (LONG/SHORT/BUY/SELL). `sigId` is the engine id.
  signals: defineTable({
    sigId: v.string(),
    symbol: v.string(),
    timeframe: v.string(),
    action: v.string(),
    state: v.string(),
    scoreFinal: v.number(),
    grade: v.string(),
    confidence: nullableNumber, // null until Calibrator has fitted on real outcomes
    regime: v.any(),
    consensus: v.any(),
    votes: v.any(),
    entry: v.any(),
    stopLoss: v.any(),
    targets: v.any(),
    positionSize: nullableNumber,
    reasons: v.array(v.string()),
    blockedReasons: v.array(v.string()),
    engines: v.any(),
    timestamp: v.number(), // engine clock, ms
  })
    .index("by_sigId", ["sigId"])
    .index("by_symbol_time", ["symbol", "timestamp"])
    .index("by_time", ["timestamp"]),

  // Latest price per symbol (upserted). `receivedAt` lets the UI show age.
  market: defineTable({
    symbol: v.string(),
    price: v.number(),
    bid: nullableNumber,
    ask: nullableNumber,
    change: nullableNumber,
    source: v.string(),
    ts: v.number(),
    receivedAt: v.number(),
  }).index("by_symbol", ["symbol"]),

  // Singletons keyed by kind: "feed_health" | "telemetry" | "balance".
  systemState: defineTable({
    key: v.string(),
    data: v.any(),
    at: v.number(),
  }).index("by_key", ["key"]),

  // Ingest bookkeeping so a silent sink is visible from the dashboard.
  ingestStats: defineTable({
    key: v.literal("main"),
    batches: v.number(),
    events: v.number(),
    rejected: v.number(),
    lastBatchAt: v.number(),
    lastRejection: v.optional(v.string()),
  }).index("by_key", ["key"]),
});
