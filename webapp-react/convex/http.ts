import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { authComponent, createAuth } from "./auth";

const http = httpRouter();

// Better Auth routes (/api/auth/*). Trusted origins = the Pages site.
authComponent.registerRoutes(http, createAuth);

/** Constant-time string compare so the secret check leaks nothing by timing. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const MAX_EVENTS = 100;

/**
 * Engine -> Convex. Called only by services/convex_sink.py.
 * Auth: Authorization: Bearer <INGEST_SECRET> (Convex env var; fail-closed).
 */
http.route({
  path: "/ingest",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const expected = process.env.INGEST_SECRET ?? "";
    const given = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (expected.length < 24 || !safeEqual(given, expected)) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401, headers: { "content-type": "application/json" },
      });
    }
    let body: { events?: unknown };
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "invalid json" }, { status: 400 });
    }
    if (!Array.isArray(body.events) || body.events.length === 0 || body.events.length > MAX_EVENTS) {
      return Response.json({ error: `events must be 1..${MAX_EVENTS}` }, { status: 400 });
    }
    try {
      const result = await ctx.runMutation(internal.ingest.apply, { events: body.events as any });
      return Response.json({ ok: true, ...result });
    } catch (err) {
      console.error("ingest failed", err);
      return Response.json({ error: "ingest failed" }, { status: 500 });
    }
  }),
});

export default http;
