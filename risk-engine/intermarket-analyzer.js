'use strict';

/**
 * Intermarket Analyzer — DXY / equity-index cross-confirmation.
 *
 * FIX (advanced feature, confirmed absent — the original audit's "does not
 * exist" list, the one item that survived every prior pass): correlation.js
 * has a `DXY_EURUSD: -0.97` constant with a comment saying "if DXY tracked
 * separately" — acknowledging it never was. No feed subscribed to it, no
 * module computed cross-asset confirmation. This is genuinely new.
 *
 * Deliberately advisory, not a hard gate — see index.js for how it's used.
 * Two honest limitations, stated rather than hidden:
 *   1. Bond yields (the third leg of "DXY/bonds/equities") are NOT wired.
 *      TwelveData's free/standard tiers don't reliably expose treasury
 *      yields as a plain ticker the way they do forex/indices — that would
 *      need a dedicated macro data provider (e.g. FRED), which this
 *      codebase has no integration for. bondsSymbol stays optional and,
 *      if never configured, is honestly reported as unavailable rather
 *      than silently assumed neutral.
 *   2. The DXY/equity relationships below (which currencies are "risk" vs
 *      "haven", USD-base vs USD-quote direction) are well-known FX
 *      heuristics, not physical laws — they break during regime shifts
 *      (e.g. a USD liquidity crisis where DXY and havens rise together).
 *      Treat `confirmed` as a lean, matching the same caveat StrategySelector
 *      already states about its own regime-fit multiplier.
 */
class IntermarketAnalyzer {
  /**
   * @param {Object} [config]
   * @param {number} [config.lookback] - number of recent price samples used
   *   to determine each macro instrument's short-term directional bias.
   * @param {number} [config.flatThresholdPct] - % change below which a
   *   macro instrument is considered directionless (avoids treating normal
   *   noise as a confirming or diverging signal).
   */
  constructor(config = {}) {
    this._lookback = config.lookback ?? 10;
    this._flatThresholdPct = config.flatThresholdPct ?? 0.05;
    this._series = new Map(); // macroSymbol -> [{ price, timestamp }]
  }

  /** Call on every real price/candle update for a tracked macro symbol. */
  updatePrice(macroSymbol, price, timestamp = Date.now()) {
    if (!macroSymbol || !Number.isFinite(price)) return;
    const arr = this._series.get(macroSymbol) || [];
    arr.push({ price, timestamp });
    if (arr.length > this._lookback + 5) arr.shift();
    this._series.set(macroSymbol, arr);
  }

  _bias(macroSymbol) {
    if (!macroSymbol) return null;
    const arr = this._series.get(macroSymbol);
    if (!arr || arr.length < 3) return null; // honest "no data" — not a fabricated neutral
    const first = arr[0].price;
    const last = arr[arr.length - 1].price;
    if (!first) return null;
    const pctChange = ((last - first) / first) * 100;
    const direction = pctChange > this._flatThresholdPct ? 'UP'
      : pctChange < -this._flatThresholdPct ? 'DOWN' : 'FLAT';
    return { pctChange: Math.round(pctChange * 1000) / 1000, direction, samples: arr.length };
  }

  /**
   * Does the current macro picture confirm or diverge from a proposed trade?
   * @param {string} symbol    - tradeable symbol, e.g. 'EURUSD', 'XAUUSD', 'USDJPY'
   * @param {string} direction - 'LONG' | 'SHORT'
   * @param {Object} [macroConfig]
   * @param {string} [macroConfig.dxySymbol]    - default 'DXY'
   * @param {string} [macroConfig.equitySymbol] - default 'SPX500'
   * @param {string} [macroConfig.bondsSymbol]  - optional; omitted if not configured (see class notes)
   */
  checkConfirmation(symbol, direction, macroConfig = {}) {
    const dxySymbol    = macroConfig.dxySymbol    || 'DXY';
    const equitySymbol = macroConfig.equitySymbol || 'SPX500';
    const bondsSymbol  = macroConfig.bondsSymbol   || null;

    const dxy    = this._bias(dxySymbol);
    const equity = this._bias(equitySymbol);
    const bonds  = bondsSymbol ? this._bias(bondsSymbol) : null;

    const reasons = [];
    let confirmSignals = 0;
    let divergeSignals = 0;
    let evaluated = 0;

    // DXY: most USD-quoted pairs (EURUSD, GBPUSD...) and gold move inversely
    // to dollar strength; USD-base pairs (USDJPY, USDCAD...) move WITH it.
    if (dxy && dxy.direction !== 'FLAT') {
      const isUsdQuote = /USD$/.test(symbol) && !symbol.startsWith('USD');
      const isUsdBase  = symbol.startsWith('USD');
      const isGold     = symbol.startsWith('XAU') || symbol.startsWith('XAG');
      let expectedDxyForLong = null;
      if (isUsdQuote || isGold) expectedDxyForLong = 'DOWN';
      else if (isUsdBase)       expectedDxyForLong = 'UP';

      if (expectedDxyForLong) {
        evaluated++;
        const wantDxy = direction === 'LONG'
          ? expectedDxyForLong
          : (expectedDxyForLong === 'UP' ? 'DOWN' : 'UP');
        if (dxy.direction === wantDxy) {
          confirmSignals++;
          reasons.push(`DXY ${dxy.direction} (${dxy.pctChange}%) confirms ${direction} ${symbol}`);
        } else {
          divergeSignals++;
          reasons.push(`DXY ${dxy.direction} (${dxy.pctChange}%) diverges from ${direction} ${symbol}`);
        }
      }
    }

    // Equities: loose risk-on/risk-off heuristic. Risk currencies (AUD/NZD/CAD)
    // tend to strengthen with equities; havens (JPY/CHF/gold) tend to weaken.
    // Checks BOTH legs of the pair — e.g. GBPJPY: JPY is the QUOTE currency,
    // so being long GBPJPY means being short JPY, which benefits from
    // risk-on same as being long an explicit risk currency would.
    if (equity && equity.direction !== 'FLAT') {
      const equityRoleScore = (code) => {
        if (['AUD', 'NZD', 'CAD'].includes(code)) return 1;   // risk currency: long benefits from equities UP
        if (['JPY', 'CHF'].includes(code)) return -1;         // haven: long benefits from equities DOWN
        if (['XAU', 'XAG'].includes(code)) return -1;         // gold/silver as haven
        return 0;
      };
      const base = symbol.slice(0, 3);
      const quote = symbol.slice(3, 6);
      // Long `symbol` = long base, short quote — so quote's role is inverted.
      const netScore = equityRoleScore(base) - equityRoleScore(quote);

      if (netScore !== 0) {
        evaluated++;
        const wantEquityForLong = netScore > 0 ? 'UP' : 'DOWN';
        const wantEquity = direction === 'LONG'
          ? wantEquityForLong
          : (wantEquityForLong === 'UP' ? 'DOWN' : 'UP');
        if (equity.direction === wantEquity) {
          confirmSignals++;
          reasons.push(`Equities ${equity.direction} confirms ${direction} ${symbol}`);
        } else {
          divergeSignals++;
          reasons.push(`Equities ${equity.direction} diverges from ${direction} ${symbol}`);
        }
      }
    }

    if (evaluated === 0) {
      return {
        available: false, confirmed: null,
        reasons: reasons.length ? reasons : ['No relevant macro relationship or insufficient data for this symbol'],
        dxy, equity, bonds,
      };
    }

    const confirmed = confirmSignals > divergeSignals ? true
      : divergeSignals > confirmSignals ? false : null; // tie — genuinely mixed picture, not a lean either way

    return { available: true, confirmed, confirmSignals, divergeSignals, evaluated, reasons, dxy, equity, bonds };
  }

  getStatus() {
    return [...this._series.keys()].map(symbol => ({ symbol, ...(this._bias(symbol) || { samples: 0, direction: null }) }));
  }
}

module.exports = { IntermarketAnalyzer };
