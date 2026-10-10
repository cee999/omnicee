# OMNICEE engine: one long-running Python process (feeds + engine + API).
# Host-agnostic: Fly.io, a VPS, Cloudflare Containers, anything that runs
# Docker. Needs a region where Binance/Deriv WebSockets are reachable
# (US IPs get HTTP 451) - Singapore/EU are fine.
FROM python:3.12-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PYTHONPATH=/app NODE_ENV=production
COPY requirements.txt requirements-edge.txt ./
RUN pip install --no-cache-dir -r requirements.txt -r requirements-edge.txt
COPY . .
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request;urllib.request.urlopen('http://localhost:8000/health')"
CMD ["uvicorn", "api.app:asgi", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
