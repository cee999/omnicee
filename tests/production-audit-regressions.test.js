'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const indexSource = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const persistSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'persist.js'), 'utf8');

describe('production regression guards', () => {
  it('does not create a persistence interval from the live tick path', () => {
    const livePriceStart = indexSource.indexOf('function onLivePrice(');
    const livePriceEnd = indexSource.indexOf('\nconst TIMEFRAME_MS', livePriceStart);
    assert(livePriceStart >= 0 && livePriceEnd > livePriceStart);
    const livePrice = indexSource.slice(livePriceStart, livePriceEnd);
    assert(!/setInterval\s*\(/.test(livePrice));
  });

  it('coalesces candle persistence instead of writing every tick', () => {
    assert(/CANDLE_WRITE_INTERVAL_MS/.test(persistSource));
    assert(/pendingCandles/.test(persistSource));
    assert(/setTimeout\s*\(flushCandles/.test(persistSource));
  });
});
