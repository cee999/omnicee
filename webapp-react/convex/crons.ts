import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";

const SIGNAL_TTL_DAYS = 45; // matches the old MONGODB_SIGNAL_TTL_DAYS

export const pruneSignals = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - SIGNAL_TTL_DAYS * 86_400_000;
    const old = await ctx.db.query("signals").withIndex("by_time")
      .filter((q) => q.lt(q.field("timestamp"), cutoff)).take(500);
    for (const s of old) await ctx.db.delete(s._id);
    return { deleted: old.length };
  },
});

const crons = cronJobs();
crons.daily("prune old signals", { hourUTC: 3, minuteUTC: 0 }, internal.crons.pruneSignals);
export default crons;
