# Deployment notes — OMNICEE (single Python service)

The backend is one Python ASGI app (`omnicee.api.app:asgi`): FastAPI REST +
python-socketio + the live engine, all in one uvicorn process. The Node
runtime was fully retired.

## Render (recommended)

Use the Blueprint in [`render.yaml`](render.yaml) — it builds the React app,
installs `requirements.txt`, and starts uvicorn with the right env vars.
Manual equivalent for a single Web Service:

- **Build:** `pip install --no-cache-dir -r requirements.txt && npm --prefix webapp-react install --include=dev && npm --prefix webapp-react run build`
- **Start:** `uvicorn omnicee.api.app:asgi --host 0.0.0.0 --port $PORT` (working dir: repo root)
- **Health check:** `/health`

Required env vars (see [`.env.example`](.env.example) for the full list):
`EA_SECRET`, `MONGODB_URI` (both required in `NODE_ENV=production`).

## Bare metal / VPS (systemd)

Create `/etc/systemd/system/omnicee.service`:

```ini
[Unit]
Description=OMNICEE trading service (Python)
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/omnicee
Environment=NODE_ENV=production
Environment=PYTHONPATH=/path/to/omnicee
ExecStart=/usr/bin/python3 -m uvicorn omnicee.api.app:asgi --host 0.0.0.0 --port 8000
Restart=on-failure
RestartSec=10
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable omnicee
sudo systemctl start omnicee
sudo journalctl -u omnicee -f
```

## Notes

- `DISABLE_ENGINE=1` gives the old stateless-brain mode (REST API only, no
  live loop) — useful for debugging the API surface in isolation.
- For durable persistence enable MongoDB and set `MONGODB_URI`.
- A lightweight market/candles cache is persisted to `.cache/` at the working
  directory root (gitignored — never commit it).

*** End of file
