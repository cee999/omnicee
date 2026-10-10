# Deployment - OMNICEE (Cloudflare Pages + Convex + Better Auth + R2 + Python engine)

Render is retired. The system is split by what each part is good at:

| Part | Where | Why |
|---|---|---|
| React dashboard (+ PWA / Telegram Mini App) | **Cloudflare Pages** | static, global, free |
| System of record + realtime pushes to the UI | **Convex** (`webapp-react/convex/`) | live queries replace Socket.IO polling |
| Operator login | **Better Auth** (in Convex) | sign-up is fail-closed via `ALLOWED_EMAILS` |
| Cold archive (candles, reports) | **Cloudflare R2** | keeps Convex small |
| Feeds + engine + agents + risk | **Python container** (`Dockerfile`) | needs long-lived WebSockets; serverless can't hold them |

Data flow: feeds -> engine -> `services/convex_sink.py` -> `POST {CONVEX_SITE_URL}/ingest`
-> Convex tables -> dashboard subscribes to Convex queries. If the sink fails or
Convex rejects an event it shows in `/health` (`convexSink`) and `/api/edge-status`.

## 1. Convex
```bash
cd webapp-react && npm install
npx convex dev            # first run creates the deployment + convex/_generated
npx convex env set INGEST_SECRET "$(openssl rand -hex 24)"
npx convex env set SITE_URL https://<your>.pages.dev
npx convex env set ALLOWED_EMAILS you@example.com
npm run typecheck:convex
npx convex deploy
```
## 2. Cloudflare Pages
Build command `npm run build`, output `dist`, root `webapp-react`. Set
`VITE_CONVEX_URL`, `VITE_CONVEX_SITE_URL`, `VITE_API_BASE` (see `.env.example`).
Or: `npm run pages:deploy`.

## 3. R2
Create a bucket and an S3 API token; set `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`, `R2_BUCKET` on the engine. Optional.

## 4. Python engine
Run the `Dockerfile` on any always-on host in a region where Binance/Deriv
WebSockets are reachable (Singapore/EU; US IPs get HTTP 451). Required env:
`EA_SECRET`, `CONVEX_SITE_URL` (the `.convex.site` URL), `CONVEX_INGEST_SECRET`
(same value as Convex `INGEST_SECRET`), `CORS_ORIGIN` (the Pages URL), plus feed
keys. `MONGODB_URI` is now optional. Health check: `/health`.

Local: `uvicorn api.app:asgi --port 8000` (`DISABLE_ENGINE=1` for API only).
A candle cache is written to `.cache/` (gitignored).
