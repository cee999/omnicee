# OMNICEE v2

Python (FastAPI) backend streams live market data over a WebSocket; React frontend
(Vite) renders it on a Kexsio FaultyTerminal backdrop. Responsive: phone, PWA/Telegram
Mini App, desktop.

## Run locally
    cd backend && python -m venv .venv && . .venv/bin/activate
    pip install -r requirements.txt
    SIMULATE=1 uvicorn app.main:app --reload     # offline random-walk feed
    # or without SIMULATE=1 for live Hyperliquid prices

    cd frontend && npm install && npm run dev    # http://localhost:5173 (proxies /ws to :8000)

## Deploy
- Backend: Render (render.yaml). Set ALLOWED_ORIGINS to the Pages URL.
- Frontend: Cloudflare Pages, root `frontend`, build `npm run build`, output `dist`,
  env `VITE_WS_URL=wss://<your-render-service>.onrender.com/ws`.

## Status
Done: live ingest (Hyperliquid), WebSocket fan-out, feed-health strip, responsive shell.
Next: key vault + provider router, Quiver Quant feed, agents/signals, auth.
