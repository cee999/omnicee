'use strict';

const EventEmitter = require('events');
const { bus } = require('./realtime');

function safeText(value) {
  return String(value ?? '').replace(/[<>]/g, '').slice(0, 2000);
}

class WebNotifier extends EventEmitter {
  constructor() {
    super();
    this.enabled = true;
    this.executionEngine = null;
    this.scorer = null;
  }

  _publish(type, payload = {}, priority = 'normal') {
    const notification = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      type,
      priority,
      timestamp: Date.now(),
      ...payload,
    };
    bus.emit('notification', notification);
    this.emit('notification', notification);
    return notification;
  }

  async sendSignal(signal) {
    return this._publish('signal', { signal }, 'high');
  }

  async ingestExternalSignal(signal) {
    return this.sendSignal(signal);
  }

  async sendMessage(message, options = {}) {
    return this._publish('message', {
      title: safeText(options.title || 'OMNICEE Alert'),
      message: safeText(message),
    }, options.priority || 'normal');
  }

  async sendCustom(message, options = {}) {
    return this.sendMessage(message, options);
  }

  async sendBreakeven(positionId, symbol, price, direction) {
    return this.sendMessage(`Breakeven set: ${symbol} ${direction} @ ${price}`, { title: 'Breakeven' });
  }

  async sendTPHit(signalId, tp, price, pnlR, remainingPct, symbol) {
    return this.sendMessage(`TP${tp} hit: ${symbol} @ ${price} (${pnlR}R). Remaining ${remainingPct}%`, { title: `TP${tp} Hit`, priority: 'high' });
  }

  async sendSLHit(signalId, price, pnlR, symbol, wasBreakeven = false) {
    return this.sendMessage(`SL hit: ${symbol} @ ${price} (${pnlR}R)${wasBreakeven ? ' at breakeven' : ''}`, { title: 'Stop Loss', priority: 'high' });
  }

  getStats() {
    return { enabled: this.enabled, transport: 'web-push/socket' };
  }
}

module.exports = { WebNotifier };
