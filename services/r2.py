"""Cloudflare R2 archive (S3-compatible). Cold storage only - never live state.

Holds candle snapshots and exported backtest/calibration reports so Convex
stays small. boto3 is imported lazily and is optional: with R2 unset or boto3
missing, archiving reports itself disabled rather than pretending to work.
"""

from __future__ import annotations

import asyncio
import gzip
import json
import logging
import time
from typing import Any

from config import Settings

log = logging.getLogger("omnicee.r2")


class R2Archive:
    def __init__(self, settings: Settings) -> None:
        self._s = settings
        self._client: Any = None
        self.enabled = settings.r2_enabled
        self.puts = 0
        self.last_error: str | None = None

    def _boto(self) -> Any:
        if self._client is None:
            import boto3  # lazy: optional dependency

            self._client = boto3.client(
                "s3",
                endpoint_url=f"https://{self._s.R2_ACCOUNT_ID}.r2.cloudflarestorage.com",
                aws_access_key_id=self._s.R2_ACCESS_KEY_ID,
                aws_secret_access_key=self._s.R2_SECRET_ACCESS_KEY,
                region_name="auto",
            )
        return self._client

    def _put_sync(self, key: str, body: bytes, content_type: str) -> None:
        self._boto().put_object(Bucket=self._s.R2_BUCKET, Key=key, Body=body,
                                ContentType=content_type, ContentEncoding="gzip")

    async def put_json(self, key: str, obj: Any) -> bool:
        if not self.enabled:
            return False
        body = gzip.compress(json.dumps(obj, separators=(",", ":")).encode())
        try:
            await asyncio.to_thread(self._put_sync, key, body, "application/json")
        except Exception as exc:  # surfaced via stats(), never swallowed
            self.last_error = f"{type(exc).__name__}: {exc}"
            log.error("r2 put failed for %s: %s", key, self.last_error)
            return False
        self.puts += 1
        self.last_error = None
        return True

    async def archive_loop(self, snapshot_fn) -> None:
        """Periodically archive snapshot_fn() (candle stores) to R2."""
        if not self.enabled:
            log.info("r2 archive disabled (R2_* unset)")
            return
        interval = self._s.R2_ARCHIVE_INTERVAL_MIN * 60
        while True:
            await asyncio.sleep(interval)
            try:
                data = snapshot_fn()
            except Exception:
                log.exception("r2 snapshot failed")
                continue
            if data:
                key = time.strftime("candles/%Y/%m/%d/%H%M.json.gz", time.gmtime())
                await self.put_json(key, data)

    def stats(self) -> dict[str, Any]:
        return {"enabled": self.enabled, "puts": self.puts, "lastError": self.last_error}
