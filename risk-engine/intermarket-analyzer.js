'use strict';

// bondsSymbol stays optional and, if never configured, is honestly reported as unavailable rather than silently assumed neutral.
class IntermarketAnalyzer {
  constructor(config = {}) {
    this._lookback = config.lookback ?? 10;
    this._flatThresholdPct = config.flatThresholdPct ?? 0.05;
    this._series = new Map();
  }

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
    if (!arr || arr.length < 3) return null;
    const first = arr[0].price;
    const last = arr[arr.length - 1].price;
    if (!first) return null;
    const pctChange = ((last - first) / first) * 100;
    const direction = pctChange > this._flatThresholdPct ? 'UP'
      : pctChange < -this._flatThresholdPct ? 'DOWN' : 'FLAT';
    return { pctChange: Math.round(pctChange * 1000) / 1000, direction, samples: arr.length };
  }

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

    if (equity && equity.direction !== 'FLAT') {
      const equityRoleScore = (code) => {
        if (['AUD', 'NZD', 'CAD'].includes(code)) return 1;
        if (['JPY', 'CHF'].includes(code)) return -1;
        if (['XAU', 'XAG'].includes(code)) return -1;
        return 0;
      };
      const base = symbol.slice(0, 3);
      const quote = symbol.slice(3, 6);
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
      : divergeSignals > confirmSignals ? false : null;

    return { available: true, confirmed, confirmSignals, divergeSignals, evaluated, reasons, dxy, equity, bonds };
  }

  getStatus() {
    return [...this._series.keys()].map(symbol => ({ symbol, ...(this._bias(symbol) || { samples: 0, direction: null }) }));
  }
}

module.exports = { IntermarketAnalyzer };
