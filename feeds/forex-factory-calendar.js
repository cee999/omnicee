/**
 * Forex Factory weekly economic calendar — NO API KEY
 * Source: https://nfs.faireconomy.media/ff_calendar_thisweek.json
 * (same weekly export Forex Factory publishes publicly)
 */
'use strict';

const https = require('https');

const FF_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const COUNTRY_TO_CCY = {
  USD: 'USD', US: 'USD', 'United States': 'USD',
  EUR: 'EUR', EU: 'EUR', EMU: 'EUR', All: 'USD',
  GBP: 'GBP', UK: 'GBP', GBR: 'GBP',
  JPY: 'JPY', JP: 'JPY',
  AUD: 'AUD', AU: 'AUD',
  CAD: 'CAD', CA: 'CAD',
  NZD: 'NZD', NZ: 'NZD',
  CHF: 'CHF', CH: 'CHF',
  CNY: 'CNY', CN: 'CNY',
};

function httpGetJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'OMNICEE/1.0 (forex-factory-calendar; +https://github.com/cee999/omnicee)',
        Accept: 'application/json',
      },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse: ${data.slice(0, 80)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function impactToTier(impact) {
  const i = String(impact || '').toLowerCase();
  if (i === 'high') return 'TIER_1';
  if (i === 'medium') return 'TIER_2';
  if (i === 'low') return 'TIER_3';
  if (i === 'holiday') return 'TIER_4';
  return null;
}

class ForexFactoryCalendar {
  enabled() { return true; }
  isConnected() { return true; }

  /**
   * @returns {Promise<Array<{name,currency,time,impact,forecast,previous}>>}
   */
  async economicCalendar() {
    const rows = await httpGetJSON(FF_URL);
    if (!Array.isArray(rows)) return [];

    return rows
      .map(e => {
        const time = e.date ? new Date(e.date).getTime() : NaN;
        const country = e.country || '';
        const currency = COUNTRY_TO_CCY[country] || COUNTRY_TO_CCY[country.toUpperCase()] || (country.length === 3 ? country : 'USD');
        return {
          name: e.title || 'Economic Event',
          currency,
          time,
          impact: e.impact || null,
          forecast: e.forecast || null,
          previous: e.previous || null,
          source: 'forex-factory',
          tierHint: impactToTier(e.impact),
        };
      })
      .filter(e => e.name && Number.isFinite(e.time) && e.time > 0);
  }
}

module.exports = { ForexFactoryCalendar };
