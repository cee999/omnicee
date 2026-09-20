"""Orchestrator: the analysis engine loop.

Wires feeds -> market snapshot -> the Stage-1 pipeline (regime -> agents ->
consensus -> gates -> levels -> calibration) -> the new validation stack
(Monte Carlo, Bayesian, statistical, walk-forward, ensemble) -> risk stack
-> institutional gates -> dispatch.

Non-negotiables honoured here:
  * signals are emitted only when every layer agrees; WAIT otherwise
  * "nothing fired" and "it crashed" are distinguishable (audit trail)
  * exceptions in the loop are logged and surfaced via `engine_telemetry`
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from collections import deque
from typing import Any

import numpy as np

from ..agents.registry import build_agents
from ..config import Settings
from ..contracts.market import Candle, MarketSnapshot, Series
from ..contracts.signals import Direction
from ..engines.pipeline import (
    OpportunityRanker,
    build_trade_plan,
    detect_compression,
    detect_traps,
    evaluate_gold_desk,
    institutional_gates,
    intermarket_check,
    select_strategy,
    should_dampen_breakout,
)
from ..ensemble.calibration import Calibrator
from ..ensemble.validation import (
    bayesian_posterior,
    ensemble_gate,
    monte_carlo_validate,
    statistical_validate,
    walk_forward,
)
from ..feeds.news import fetch_news
from ..pipeline import PipelineDeps, analyse
from ..risk.gates import AccountState
from ..risk.stack import CorrelationFilter, DrawdownGuard, PositionSizer, SessionFilter
from ..services.alerts import AlertDispatcher
from ..services.bus import EventBus
from ..services.db import Database
from .audit import AuditTrail

log = logging.getLogger(__name__)


class Orchestrator:
    def __init__(self, settings: Settings, bus: EventBus, db: Database,
                 feed_manager: Any, cot_report: Any, market_info: Any,
                 calendar: Any) -> None:
        self.cfg = settings
        self.bus = bus
        self.db = db
        self.fm = feed_manager
        self.cot = cot_report
        self.market_info = market_info
        self.calendar = calendar
        self.audit = AuditTrail(maxlen=500)
        self.agents = build_agents()
        self.calibrator = Calibrator(min_samples=settings.CALIBRATION_MIN_SAMPLES)
        self.correlation = CorrelationFilter()
        self.drawdown = DrawdownGuard()
        self.session = SessionFilter(require_killzone=settings.REQUIRE_KILLZONE)
        balance = settings.ACCOUNT_BALANCE or 10_000.0
        self.sizer = PositionSizer(balance, settings.RISK_PCT_PER_TRADE, drawdown=self.drawdown)
        self.ranker = OpportunityRanker()
        self.alerts = AlertDispatcher(settings, db)
        self.dxy_prices: deque[float] = deque(maxlen=30)
        self.equity_prices: deque[float] = deque(maxlen=30)
        self.symbol_loss_streak: dict[str, int] = {}
        # Latest MT5 EA account sync (balance/equity) — makes gates and sizing
        # run on the real account. None until the EA pushes /api/ea/balance.
        self.account_state: dict[str, Any] | None = None
        self._running = False
        self._last_cycle_stats: dict[str, Any] = {}
        self._boot_ms = time.time() * 1000
        self.consec_loss = 0
        self.trades_today = 0
        self.trades_last_hour = 0

    # ------------------------------------------------------------------ loop
    async def run(self) -> None:
        self._running = True
        log.info("analysis engine started", extra={"symbols": self.cfg.symbols})
        # Boot grace: let feeds warm up before the first cycle.
        grace = max(0.0, (self._boot_ms + self.cfg.BOOT_GRACE_MS - time.time() * 1000) / 1000)
        if grace:
            await asyncio.sleep(grace)
        interval = self.cfg.ANALYSIS_INTERVAL_MS / 1000.0
        while self._running:
            started = time.time()
            try:
                await self.cycle()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("analysis cycle crashed")
                await self.bus.emit("engine_telemetry", {"kind": "cycle_error", "at": int(time.time() * 1000)})
            elapsed = time.time() - started
            await asyncio.sleep(max(1.0, interval - elapsed))

    def stop(self) -> None:
        self._running = False

    # ----------------------------------------------------------------- cycle
    async def cycle(self) -> None:
        t0 = time.time()
        outcomes = {"analyzed": 0, "signaled": 0, "waited": 0, "errors": 0}
        rows = self.fm.resolved_market_rows()
        if not rows:
            await self.bus.emit("engine_telemetry", {"kind": "no_prices", "at": int(time.time() * 1000)})
            return
        try:
            news_articles = await fetch_news(limit=30)
        except Exception:
            log.exception("news fetch failed (non-fatal)")
            news_articles = []
        for row in rows:
            sym = row["symbol"]
            try:
                if sym == self.cfg.DXY_SYMBOL and row.get("price"):
                    self.dxy_prices.append(float(row["price"]))
                if sym == self.cfg.EQUITY_INDEX_SYMBOL and row.get("price"):
                    self.equity_prices.append(float(row["price"]))
                result = await self._analyze_symbol(sym, news_articles)
                outcomes["analyzed"] += 1
                if result.get("action") in ("LONG", "SHORT", "BUY", "SELL"):
                    outcomes["signaled"] += 1
                else:
                    outcomes["waited"] += 1
            except Exception as exc:
                outcomes["errors"] += 1
                log.exception("analysis failed for %s", sym)
                self.audit.record({"kind": "symbol_error", "symbol": sym, "error": str(exc)[:200]})
        self.ranker.prune(self.cfg.symbols)
        self._last_cycle_stats = {**outcomes, "durationMs": round((time.time() - t0) * 1000, 1),
                                  "at": int(time.time() * 1000)}
        await self.bus.emit("engine_telemetry", {"kind": "cycle", **self._last_cycle_stats})

    # ------------------------------------------------------------- snapshot
    def _build_snapshot(self, symbol: str) -> MarketSnapshot | None:
        series: dict[str, Series] = {}
        for tf in self.cfg.timeframes:
            rows = self.fm.store.get(symbol, tf)
            if len(rows) < 60:
                continue
            candles: list[Candle] = []
            for c in rows[-300:]:
                try:
                    candles.append(Candle(time=int(c["time"]), open=float(c["open"]),
                                          high=float(c["high"]), low=float(c["low"]),
                                          close=float(c["close"]),
                                          volume=float(c.get("volume") or 0.0)))
                except Exception:
                    continue
            if len(candles) >= 60:
                series[tf] = Series(symbol=symbol, timeframe=tf, candles=candles)
        if not series:
            return None
        last_row = self.fm.store.last_prices.get(symbol, {})
        spread = None
        if last_row.get("bid") and last_row.get("ask"):
            spread = float(last_row["ask"]) - float(last_row["bid"])
        return MarketSnapshot(symbol=symbol, series=series, spread=spread,
                              source=f"python-feeds:{last_row.get('source') or 'unknown'}",
                              last_tick_ms=last_row.get("atMs"))

    def _account(self) -> AccountState:
        """Live account state from the EA sync, or unknown (safe defaults)."""
        st = self.account_state
        if not st:
            return AccountState()
        balance = float(st.get("balance") or 0.0)
        if balance <= 0:
            return AccountState()
        return AccountState(balance=balance, known=True)

    @staticmethod
    def _score_from_raw(raw: float) -> float:
        # raw in [-1, 1] -> desk score in [0, 100], 50 = neutral
        return float(np.clip(50.0 + raw * 50.0, 0.0, 100.0))

    # -------------------------------------------------------------- symbol
    async def _analyze_symbol(self, symbol: str, news_articles: list[dict[str, Any]]) -> dict[str, Any]:
        snapshot = self._build_snapshot(symbol)
        if snapshot is None:
            self.ranker.update(symbol, action="WAIT", reason="insufficient candles")
            return {"action": "WAIT", "reason": "insufficient candles"}

        # External context (feeds feed the sentiment agent through here)
        external: dict[str, Any] = {"articles": news_articles}
        if symbol in ("BTCUSDT", "ETHUSDT") and self.market_info and self.market_info.fear_greed:
            external["fearGreed"] = self.market_info.fear_greed
        try:
            cot = self.cot.parser.analyze(symbol) if self.cot else None
        except Exception:
            log.exception("cot analysis failed for %s", symbol)
            cot = None
        if cot:
            external["cot"] = cot
        events = self.calendar.upcoming(10) if self.calendar else []
        external["upcomingEvents"] = [
            {**e, "minutesAway": (float(e["time"]) - time.time() * 1000) / 60_000} for e in events]

        # ---- Stage-1 pipeline (regime -> agents -> consensus -> gates -> levels)
        deps = PipelineDeps(settings=self.cfg, calibrator=self.calibrator)
        result = await analyse(snapshot, deps, account=self._account(), external=external)
        consensus = result.consensus
        direction = consensus.direction
        votes = consensus.votes

        candles = self.fm.store.get(symbol, snapshot.primary().timeframe)
        candles_dict = {"open": [float(c["open"]) for c in candles],
                        "high": [float(c["high"]) for c in candles],
                        "low": [float(c["low"]) for c in candles],
                        "close": [float(c["close"]) for c in candles],
                        "volume": [float(c.get("volume") or 0.0) for c in candles],
                        "regime": str(result.regime.get("regime", ""))}
        score = self._score_from_raw(consensus.raw_score)

        # ---- engines
        try:
            trap = detect_traps(candles_dict)
            comp = detect_compression(candles_dict)
        except Exception:
            log.exception("engine failure (traps/compression) for %s", symbol)
            trap, comp = {"traps": [], "activeTrap": None, "trapRisk": 0.0}, {"compressionScore": 0.0, "isCompressed": False, "biasHint": "NEUTRAL"}
        if direction is not Direction.FLAT:
            dampen = should_dampen_breakout(trap, direction.value)
            if dampen.get("dampen"):
                score *= float(dampen.get("factor", 1.0))
        dir_str = direction.value if direction is not Direction.FLAT else "WAIT"
        strategy = select_strategy({"structure": result.regime.get("structure", "CHOP"),
                                    "volatility": result.regime.get("volatility", "NORMAL"),
                                    "trend": result.regime.get("trend", ""),
                                    "tradeability": result.regime.get("tradeability", 50)}, dir_str)
        inter = intermarket_check(symbol, dir_str, self.dxy_prices, self.equity_prices)
        session = self.session.check(symbol, news_events=events)

        # ---- levels: reuse the pipeline's when present, else build a plan
        entry = stop = None
        rr: float | None = None
        targets: list[dict[str, Any]] = []
        plan_method = None
        if result.signal is not None and result.signal.levels is not None:
            lv = result.signal.levels
            entry, stop = float(lv.entry), float(lv.stop_loss)
            rr = float(lv.risk_reward) if lv.risk_reward else None
            sign = 1.0 if direction is Direction.LONG else -1.0
            risk = abs(entry - stop)
            targets = [{"price": round(entry + sign * rr_val * risk, 6), "rr": rr_val, "closePct": pct}
                       for rr_val, pct in ((1.5, 50), (2.0, 50), (3.0, 30))]
            plan_method = "PIPELINE_LEVELS"
        elif direction is not Direction.FLAT and session.get("allowed"):
            price_now = self.fm.store.last_prices.get(symbol, {}).get("price") or float(candles[-1]["close"])
            plan = build_trade_plan(candles_dict, dir_str, {"zoneHigh": price_now, "zoneLow": price_now})
            p = plan.get("plan")
            if p:
                entry = p["entry"]["midPoint"]
                stop = p["stopLoss"]["price"]
                rr = p["targets"][0]["rr"] if p["targets"] else None
                targets = p["targets"]
                plan_method = p["stopLoss"]["method"]

        # ---- sizing (session-aware; the pipeline's sizing is informational here)
        risk_approved = direction is Direction.FLAT
        effective_risk = 0.0
        if entry and stop and direction is not Direction.FLAT:
            sizing = self.sizer.size(symbol, entry, stop,
                                     session_mult=float(session.get("multiplier", 1.0)))
            risk_approved = bool(sizing.get("approved"))
            effective_risk = float((sizing.get("sizing") or {}).get("effectiveRiskPct", 0))

        # ---- validation layers
        mc = monte_carlo_validate(candles_dict, dir_str, entry or float(candles[-1]["close"]),
                                  stop or float(candles[-1]["close"]) * 0.99,
                                  [t["price"] for t in targets] or [float(candles[-1]["close"])],
                                  simulations=self.cfg.MC_SIMULATIONS)
        bayes = bayesian_posterior(
            {"agentAgreement": consensus.agreement, "score": score,
             "tradeability": result.regime.get("tradeability", 50),
             "rr": rr or 0, "riskRejected": (not risk_approved) and direction is not Direction.FLAT},
            prior=self.cfg.BAYES_PRIOR, min_posterior=self.cfg.BAYES_MIN_POSTERIOR)
        stat = statistical_validate(candles_dict, dir_str, score,
                                    min_tests=self.cfg.STAT_MIN_TESTS,
                                    significance=self.cfg.STAT_SIGNIFICANCE)
        outcomes_db = self.db.get_outcomes(200) if self.db else []
        wf = walk_forward([o for o in outcomes_db if o.get("symbol") == symbol] or outcomes_db,
                          min_samples=self.cfg.WF_MIN_SAMPLES, min_wfe=self.cfg.WF_MIN_WFE)
        ensemble = ensemble_gate({
            "monteCarlo": {"approved": mc["approved"], "score": (mc.get("winProbability") or 0) * 100,
                           "penalty": mc.get("penalty", 0)},
            "bayesian": {"approved": bayes["approved"], "score": bayes["posterior"] * 100,
                         "penalty": bayes.get("penalty", 0)},
            "statistical": {"approved": stat["approved"], "score": stat["compositeScore"],
                            "penalty": stat.get("penalty", 0)},
            "walkForward": {"approved": True, "score": 70 if wf.get("robust") else 45,
                            "penalty": wf.get("penalty", 0), "present": bool(wf.get("sufficient"))},
            "session": {"approved": bool(session.get("allowed")),
                        "score": 80 if session.get("allowed") else 20,
                        "penalty": 0 if session.get("allowed") else 40, "present": True},
        }, signal_score=score, min_confidence=self.cfg.ENSEMBLE_MIN_SCORE)

        core_directions = {}
        for v in votes:
            if v.agent in ("smc", "mtf", "momentum") and v.ok:
                core_directions[v.agent] = v.direction.value
        gates = institutional_gates(
            score=score, rr=rr or 0,
            regime={"structure": result.regime.get("structure", "CHOP"),
                    "tradeability": result.regime.get("tradeability", 50)},
            risk_approved=risk_approved, effective_risk=effective_risk,
            consensus=consensus.agreement, ensemble=ensemble,
            learning_action=None, symbol_loss_streak=self.symbol_loss_streak.get(symbol, 0),
            core_directions=core_directions, signal_direction=dir_str)
        gold = evaluate_gold_desk(symbol, dir_str, score, consec_loss=self.consec_loss,
                                  trades_today=self.trades_today, trades_last_hour=self.trades_last_hour,
                                  swarm_consensus=consensus.agreement, rr=rr)

        # ---- final action
        pipeline_fired = result.signal is not None and result.signal.state is not None \
            and direction is not Direction.FLAT
        approved = (pipeline_fired and gates["approved"] and ensemble["approved"]
                    and not gold.get("hardBlock") and not gold.get("softBlock"))
        final_action = dir_str if approved else "WAIT"

        sig_doc = {
            "id": f"sig-{uuid.uuid4().hex[:12]}",
            "symbol": symbol, "timeframe": snapshot.primary().timeframe,
            "action": final_action,
            "state": str(result.signal.state.value) if result.signal else "CANDIDATE",
            "score": {"final": round(score, 1),
                      "grade": "A" if score >= 85 else "B" if score >= 75 else "C" if score >= 65 else "D"},
            "confidence": result.signal.confidence if result.signal else None,
            "regime": result.regime,
            "consensus": {"direction": consensus.direction.value, "rawScore": consensus.raw_score,
                          "agreement": consensus.agreement, "participating": consensus.participating,
                          "failed": consensus.failed},
            "votes": [{"agent": v.agent, "direction": v.direction.value, "score": v.score,
                       "weight": v.weight, "confidence": v.confidence, "evidence": v.evidence,
                       "ok": v.ok} for v in votes],
            "entry": {"midPoint": entry} if entry is not None else None,
            "stopLoss": {"price": stop, "method": plan_method} if stop is not None else None,
            "targets": targets,
            "positionSize": result.signal.position_size if result.signal else None,
            "reasons": (result.signal.rationale if result.signal else result.blocked_reasons) or [],
            "engines": {"traps": trap, "compression": comp, "strategy": strategy,
                        "intermarket": inter, "session": session,
                        "monteCarlo": {k: v for k, v in mc.items() if k != "calibration"},
                        "bayesian": bayes,
                        "statistical": {k: v for k, v in stat.items() if k != "tests"},
                        "walkForward": wf, "ensemble": ensemble,
                        "institutionalGates": gates, "goldDesk": gold},
            "blockedReasons": [] if approved else list(result.blocked_reasons or []) + (gates.get("failures") or []),
            "timestamp": int(time.time() * 1000),
        }
        self.ranker.update(symbol, action=final_action, score=round(score, 1),
                           reason="; ".join((gates.get("failures") or [])[:2]) or None,
                           regime=result.regime.get("regime"))
        # Only actionable signals go out on the `signal` channel — WAIT docs
        # are visible in the audit trail and engine telemetry, not as signals.
        if final_action in ("LONG", "SHORT", "BUY", "SELL"):
            await self.bus.emit("signal", sig_doc)
            if self.db:
                self.db.save_signal(sig_doc)
            try:
                await self.alerts.dispatch_signal(sig_doc)
            except Exception:
                log.exception("alert dispatch failed")
            self.audit.record({"kind": "signal", "symbol": symbol, "action": final_action,
                               "score": round(score, 1), "gates": gates["status"]})
        else:
            self.audit.record({"kind": "wait", "symbol": symbol, "score": round(score, 1),
                               "gates": gates["status"],
                               "failures": (gates.get("failures") or [])[:3]})
        return sig_doc

    # ----------------------------------------------------------------- status
    def status(self) -> dict[str, Any]:
        return {
            "running": self._running,
            "lastCycle": self._last_cycle_stats,
            "bootGraceRemainingMs": max(0, round(self._boot_ms + self.cfg.BOOT_GRACE_MS - time.time() * 1000)),
            "circuitBreaker": {"state": self.drawdown.state, "dailyPnl": round(self.drawdown.daily_pnl, 3),
                               "consecLoss": self.drawdown.consec_loss, "tradesToday": self.drawdown.trades_today},
            "auditTail": self.audit.tail(20),
        }
