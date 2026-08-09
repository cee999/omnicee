
'use strict';

const https        = require('https');
const http         = require('http');
const EventEmitter = require('events');
const { URL }      = require('url');

const TELEGRAM_API_BASE = 'https://api.telegram.org/bot';

const RATE_LIMIT_GLOBAL_MS   = 35;
const RATE_LIMIT_PER_CHAT_MS = 1100;

const MAX_RETRIES = 5;

const DEDUP_WINDOW_MS = 5 * 60 * 1000;

const QUEUE_INTERVAL_MS = 100;

const CHART_SNAPSHOT_BASE = 'https://charts.tradingview.com/chart-snapshots';

const PRIORITY = {
  EMERGENCY: 0,
  HIGH:      1,
  NORMAL:    2,
  LOW:       3,
};

const BOT_COMMANDS = [
  { command: 'start',     description: 'Start the trading assistant bot' },
  { command: 'status',    description: 'System status and connection health' },
  { command: 'signals',   description: 'Last 5 signals fired' },
  { command: 'stats',     description: 'Win rate and performance stats' },
  { command: 'risk',      description: 'Current risk engine status' },
  { command: 'outlook',   description: 'This week + next week: calendar, regime, institutional positioning' },
  { command: 'balance',   description: 'Set or view account balance' },
  { command: 'pause',     description: 'Pause signal delivery' },
  { command: 'resume',    description: 'Resume signal delivery' },
  { command: 'win',       description: 'Record last signal as WIN' },
  { command: 'loss',      description: 'Record last signal as LOSS' },
  { command: 'be',        description: 'Record last signal as BREAKEVEN' },
  { command: 'setsize',   description: 'Set risk % per trade (e.g. /setsize 1.5)' },
  { command: 'calc',      description: 'Position size calculator' },
  { command: 'markets',   description: 'Active market sessions right now' },
  { command: 'sub',       description: 'Subscribe to signal alerts' },
  { command: 'unsub',     description: 'Unsubscribe from signal alerts' },
  { command: 'help',      description: 'Full command reference' },
];

const EMOJI = {
  LONG:       '🟢',
  SHORT:      '🔴',
  WAIT:       '⏳',
  WIN:        '✅',
  LOSS:       '❌',
  BREAKEVEN:  '⚖️',
  WARNING:    '⚠️',
  EMERGENCY:  '🚨',
  SIGNAL:     '📡',
  CHART:      '📊',
  MONEY:      '💰',
  TARGET:     '🎯',
  STOP:       '🛑',
  BRAIN:      '🧠',
  ROCKET:     '🚀',
  FIRE:       '🔥',
  CLOCK:      '⏰',
  GRADE_A:    '⭐',
  GRADE_B:    '🔵',
  GRADE_C:    '⚪',
  UP:         '📈',
  DOWN:       '📉',
  LIGHTNING:  '⚡',
  LOCKED:     '🔒',
  BULL:       '🐂',
  BEAR:       '🐻',
  WHALE:      '🐋',
  EXPLOSION:  '💥',
};

class TelegramClient {
  constructor(token) {
    this.token   = token;
    this.baseUrl = `${TELEGRAM_API_BASE}${token}`;
  }

  async call(method, payload = {}) {
    const url     = `${this.baseUrl}/${method}`;
    const body    = JSON.stringify(payload);

    return new Promise((resolve, reject) => {
      const req = https.request(url, {
        method:  'POST',
        headers: {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (!parsed.ok) {
              reject(new Error(`Telegram API error [${method}]: ${parsed.description} (${parsed.error_code})`));
            } else {
              resolve(parsed.result);
            }
          } catch (e) {
            reject(new Error(`Failed to parse Telegram response: ${data}`));
          }
        });
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  async sendMessage(chatId, text, options = {}) {
    return this.call('sendMessage', {
      chat_id:    chatId,
      text:       text.slice(0, 4096),
      parse_mode: options.parseMode || 'HTML',
      reply_markup:           options.replyMarkup || undefined,
      disable_web_page_preview: options.noPreview !== false,
      ...options.extra,
    });
  }

  async sendPhoto(chatId, photoUrl, caption, options = {}) {
    return this.call('sendPhoto', {
      chat_id:   chatId,
      photo:     photoUrl,
      caption:   caption?.slice(0, 1024),
      parse_mode: options.parseMode || 'HTML',
      reply_markup: options.replyMarkup || undefined,
    });
  }

  async editMessage(chatId, messageId, text, options = {}) {
    return this.call('editMessageText', {
      chat_id:    chatId,
      message_id: messageId,
      text:       text.slice(0, 4096),
      parse_mode: options.parseMode || 'HTML',
      reply_markup: options.replyMarkup || undefined,
    });
  }

  async answerCallback(callbackQueryId, text, showAlert = false) {
    return this.call('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text,
      show_alert: showAlert,
    });
  }

  async setWebhook(webhookUrl) {
    return this.call('setWebhook', { url: webhookUrl });
  }

  async deleteWebhook() {
    return this.call('deleteWebhook');
  }

  async getUpdates(offset = 0, timeout = 30) {
    return this.call('getUpdates', { offset, timeout, allowed_updates: ['message','callback_query'] });
  }

  async setMyCommands(commands) {
    return this.call('setMyCommands', { commands });
  }

  async getMe() {
    return this.call('getMe');
  }

  async pinMessage(chatId, messageId) {
    return this.call('pinChatMessage', { chat_id: chatId, message_id: messageId });
  }

  async sendSticker(chatId, stickerId) {
    return this.call('sendSticker', { chat_id: chatId, sticker: stickerId });
  }
}

class SignalQueue {
  constructor() {
    this._queue     = [];
    this._lastSent  = 0;
    this._chatTimes = new Map();
  }

  push(item) {
    this._queue.push({ ...item, addedAt: Date.now() });
    this._queue.sort((a, b) => a.priority - b.priority);
  }

  // FIX: RATE_LIMIT_PER_CHAT_MS and this._chatTimes were declared but never consulted — nothing stopped multiple messages from firing at the same chat within Telegram's ~1 msg/sec-per-chat limit, risking...
  next() {
    if (this._queue.length === 0) return null;

    const now      = Date.now();
    const globalOk = now - this._lastSent >= RATE_LIMIT_GLOBAL_MS;
    if (!globalOk) return null;

    for (let i = 0; i < this._queue.length; i++) {
      const item = this._queue[i];
      const lastForChat = item.chatId != null ? (this._chatTimes.get(item.chatId) || 0) : 0;
      const chatOk = item.chatId == null || (now - lastForChat >= RATE_LIMIT_PER_CHAT_MS);
      if (chatOk) {
        this._queue.splice(i, 1);
        return item;
      }
    }
    return null;
  }

  async execute(item) {
    this._lastSent = Date.now();
    if (item.chatId != null) this._chatTimes.set(item.chatId, Date.now());
    try {
      await item.fn();
    } catch (err) {
      console.error('[SignalQueue] Execution error:', err.message);
      if ((item.retries || 0) < MAX_RETRIES) {
        item.retries = (item.retries || 0) + 1;
        const delay = Math.min(1000 * Math.pow(2, item.retries), 30000);
        setTimeout(() => this._queue.unshift(item), delay);
      }
    }
  }

  size() { return this._queue.length; }
  clear() { this._queue = []; }
}

class DedupManager {
  constructor() {
    this._seen = new Map();
  }

  isDuplicate(signal) {
    const key = `${signal.symbol}_${signal.action}_${signal.timeframe}`;
    const last = this._seen.get(key);
    if (last && (Date.now() - last) < DEDUP_WINDOW_MS) return true;
    this._seen.set(key, Date.now());
    return false;
  }

  clear() { this._seen.clear(); }

  cleanup() {
    const now = Date.now();
    for (const [key, time] of this._seen) {
      if (now - time > DEDUP_WINDOW_MS * 2) {
        this._seen.delete(key);
      }
    }
  }
}

class MessageFormatter {

  static formatSignal(signal) {
    const isLong     = signal.action === 'LONG';
    const gradeEmoji = signal.score?.grade === 'A' ? EMOJI.GRADE_A
      : signal.score?.grade === 'B' ? EMOJI.GRADE_B : EMOJI.GRADE_C;
    const dirEmoji   = isLong ? EMOJI.LONG : EMOJI.SHORT;

    const lines = [
      `${dirEmoji} <b>${signal.action} SIGNAL</b> — <code>${signal.symbol}</code> ${signal.timeframe}`,
      `${EMOJI.CHART} Score: <b>${signal.score?.final ?? signal.score}/100</b> ${gradeEmoji} Grade ${signal.score?.grade ?? '?'}`,
      `${EMOJI.MONEY} Price: <code>${signal.currentPrice}</code>`,
      `${EMOJI.CLOCK} Session: <b>${signal.session?.current ?? 'Unknown'}</b> [${signal.session?.quality ?? '?'}]`,
      '',
      `<b>━━━━━━━━ ENTRY ━━━━━━━━</b>`,
      `${EMOJI.TARGET} Zone: <code>${signal.entry?.zoneLow}</code> – <code>${signal.entry?.zoneHigh}</code>`,
      `${EMOJI.SIGNAL} Type: ${signal.entry?.type ?? 'LIMIT'}`,
      `${EMOJI.LOCKED} Note: <i>${signal.entry?.note ?? 'Wait for price to return'}</i>`,
      '',
      `<b>━━━━━━━━ TARGETS ━━━━━━━━</b>`,
      `${EMOJI.STOP} Stop Loss: <code>${signal.stopLoss?.price}</code>`,
      `   <i>${signal.stopLoss?.note ?? ''}</i>`,
      `${EMOJI.TARGET} TP1: <code>${signal.targets?.tp1?.price}</code> [${signal.targets?.tp1?.rr}:1 RR]`,
      `   <i>${signal.targets?.tp1?.note ?? ''}</i>`,
      `${EMOJI.TARGET} TP2: <code>${signal.targets?.tp2?.price}</code> [${signal.targets?.tp2?.rr}:1 RR]`,
      `   <i>${signal.targets?.tp2?.note ?? ''}</i>`,
    ];

    if (signal.agentBreakdown?.length > 0) {
      lines.push('');
      lines.push(`<b>━━━━━━━━ AGENT VOTES ━━━━━━━━</b>`);
      for (const agent of signal.agentBreakdown) {
        const statusEmoji = agent.status === 'CONFIRMS' ? '✅'
          : agent.status === 'NEUTRAL' ? '⚪' : '❌';
        lines.push(`${statusEmoji} ${agent.agent}: <b>${agent.score}/100</b> [${agent.weight}]`);
      }
    }

    if (signal.allReasons?.length > 0) {
      lines.push('');
      lines.push(`<b>━━━━━━━━ WHY THIS TRADE ━━━━━━━━</b>`);
      signal.allReasons.slice(0, 6).forEach(r => lines.push(`  ✅ ${r}`));
    }

    lines.push('');
    lines.push(`<b>━━━━━━━━ MANAGEMENT ━━━━━━━━</b>`);
    lines.push(`📍 Move to BE: <i>${signal.management?.moveToBreakeven ?? 'After TP1'}</i>`);
    lines.push(`✂️ Partial close: <i>${signal.management?.partialClose ?? '50% at TP1'}</i>`);
    lines.push(`🔄 Trail stop: <i>${signal.management?.trailingStop ?? 'ATR × 1.5'}</i>`);
    lines.push(`🚫 Invalidation: <i>${signal.management?.invalidation ?? 'Close beyond SL'}</i>`);

    lines.push('');
    lines.push(`${EMOJI.UP} HTF Bias: <b>${signal.htfBias?.direction ?? '?'}</b>`);

    lines.push('');
    lines.push(`<i>⚠️ Risk max 1-2% per trade. Confirm on your chart.</i>`);
    lines.push(`<i>📅 ${new Date(signal.timestamp).toUTCString()}</i>`);

    return lines.join('\n');
  }

  static formatShortAlert(signal) {
    const isLong = signal.action === 'LONG';
    const emoji  = isLong ? EMOJI.LONG : EMOJI.SHORT;
    const grade  = signal.score?.grade ?? '?';

    return [
      `${emoji} <b>${signal.action}</b> ${signal.symbol} ${signal.timeframe} | Grade ${grade} | Score ${signal.score?.final ?? signal.score}`,
      `Entry: ${signal.entry?.zoneLow}–${signal.entry?.zoneHigh} | SL: ${signal.stopLoss?.price} | TP1: ${signal.targets?.tp1?.price}`,
      `<i>Session: ${signal.session?.current}</i>`,
    ].join('\n');
  }

  static formatStatus(status) {
    const { feed, scorer, risk, signals } = status;

    return [
      `${EMOJI.SIGNAL} <b>System Status</b>`,
      '',
      `<b>Data Feeds:</b>`,
      `  Binance: ${feed?.connected?.spot ? '🟢 Connected' : '🔴 Disconnected'}`,
      `  Futures: ${feed?.connected?.futures ? '🟢 Connected' : '🔴 Disconnected'}`,
      `  Uptime:  ${Math.floor((feed?.uptime ?? 0) / 60)}min`,
      `  Msgs/s:  ${feed?.messagesReceived ?? 0}`,
      '',
      `<b>Signal Engine:</b>`,
      `  Min score: ${scorer?.minScore ?? 75}`,
      `  CB paused: ${risk?.isPaused ? '🔴 YES — ' + risk?.pausedReason : '🟢 No'}`,
      `  Daily PnL: ${risk?.dailyPnl ?? 0}%`,
      '',
      `<b>Signal Stats:</b>`,
      `  Total fired: ${signals?.total ?? 0}`,
      `  Win rate:    ${signals?.winRate ?? 0}%`,
      `  Profit factor: ${signals?.profitFactor ?? 0}`,
      '',
      `<i>Updated: ${new Date().toUTCString()}</i>`,
    ].join('\n');
  }

  static formatLiquidationCascade(data) {
    return [
      `${EMOJI.EMERGENCY} <b>LIQUIDATION CASCADE DETECTED</b>`,
      '',
      `Symbol:   <code>${data.symbol ?? 'MULTI'}</code>`,
      `Total:    <b>$${(data.totalUSDT / 1000000).toFixed(2)}M</b> in ${data.window / 1000}s`,
      `Longs liq: $${(data.longUSDT / 1000).toFixed(0)}K`,
      `Shorts liq: $${(data.shortUSDT / 1000).toFixed(0)}K`,
      `Signal:   <b>${data.marketSignal}</b>`,
      '',
      `<i>Consider waiting for price to stabilize before entering.</i>`,
    ].join('\n');
  }

  static formatWhaleTrade(trade) {
    const emoji = trade.direction === 'BUY' ? EMOJI.BULL : EMOJI.BEAR;
    return [
      `${EMOJI.WHALE} <b>WHALE TRADE DETECTED</b>`,
      `${emoji} ${trade.direction} <code>${trade.symbol}</code>`,
      `Size: <b>$${(trade.usdtValue / 1000).toFixed(1)}K</b> @ ${trade.price}`,
      `<i>${trade.note}</i>`,
    ].join('\n');
  }

  static formatFundingExtreme(extremes) {
    const lines = [`${EMOJI.WARNING} <b>EXTREME FUNDING RATES</b>`, ''];
    for (const e of extremes.slice(0, 5)) {
      const emoji = e.rate > 0 ? EMOJI.BEAR : EMOJI.BULL;
      lines.push(`${emoji} <code>${e.symbol}</code>: ${(e.rate * 100).toFixed(4)}% [${e.bias}]`);
      lines.push(`  Annualized: ${e.annualized?.toFixed(1)}% — ${e.meanReversionSignal}`);
    }
    return lines.join('\n');
  }

  static formatOutcome(outcome, signal) {
    const emoji = outcome.result === 'WIN' ? EMOJI.WIN
      : outcome.result === 'LOSS' ? EMOJI.LOSS : EMOJI.BREAKEVEN;

    return [
      `${emoji} <b>TRADE OUTCOME RECORDED</b>`,
      '',
      `Signal:  ${signal?.action ?? '?'} ${signal?.symbol ?? '?'} ${signal?.timeframe ?? '?'}`,
      `Result:  <b>${outcome.result}</b>`,
      `PnL:     <b>${outcome.pnlPct > 0 ? '+' : ''}${outcome.pnlPct}%</b>`,
      `Note:    <i>${outcome.note ?? ''}</i>`,
    ].join('\n');
  }

  static formatPositionSize(calc) {
    return [
      `${EMOJI.CHART} <b>Position Size Calculator</b>`,
      '',
      `Account:    $${calc.accountBalance}`,
      `Risk %:     ${calc.riskPct}%`,
      `Risk $:     $${calc.riskUSD.toFixed(2)}`,
      `Entry:      ${calc.entry}`,
      `Stop Loss:  ${calc.stopLoss}`,
      `SL Points:  ${calc.slPoints}`,
      `Lot Size:   <b>${calc.lotSize}</b>`,
      `Units:      ${calc.units}`,
      `RR:         ${calc.rr}:1`,
      `Potential:  +$${calc.potentialProfitUSD.toFixed(2)} at TP`,
    ].join('\n');
  }

  static formatSessions(session) {
    const quality = session.best.quality;
    const qEmoji  = quality === 'HIGHEST' ? EMOJI.FIRE
      : quality === 'HIGH' ? EMOJI.UP
      : quality === 'LOW' ? EMOJI.WARNING : '💤';

    return [
      `${EMOJI.CLOCK} <b>Market Sessions</b>`,
      '',
      `${qEmoji} Active: <b>${session.best.name}</b> [${quality}]`,
      `UTC Hour: ${session.utcHour}`,
      `Killzone: ${session.isKillzone ? '🔥 YES — Best time to trade' : 'No'}`,
      '',
      `<i>${session.best.note}</i>`,
      '',
      `Next killzone: <b>${session.nextKillzone?.session}</b> in ${session.nextKillzone?.hoursAway?.toFixed(1)}h`,
    ].join('\n');
  }

  static formatHelp() {
    return [
      `${EMOJI.BRAIN} <b>AI Trading Assistant — Commands</b>`,
      '',
      ...BOT_COMMANDS.map(c => `/<code>${c.command}</code> — ${c.description}`),
      '',
      `<b>Signal Grades:</b>`,
      `${EMOJI.GRADE_A} Grade A (85+) — Highest confluence`,
      `${EMOJI.GRADE_B} Grade B (75-84) — Strong signal`,
      `${EMOJI.GRADE_C} Grade C (65-74) — Not fired`,
      '',
      `<i>Signals only fire at score 75+. Always use stop loss.</i>`,
    ].join('\n');
  }
}

class KeyboardBuilder {
  static signalKeyboard(signalId, symbol) {
    return {
      inline_keyboard: [
        [
          { text: `✅ Approve`,   callback_data: `APPROVE:${signalId}` },
          { text: `❌ Skip`,      callback_data: `SKIP:${signalId}` },
        ],
        [
          { text: `📊 Details`,  callback_data: `DETAILS:${signalId}` },
          { text: `📈 Chart`,    callback_data: `CHART:${symbol}` },
        ],
        // FIX: added — these are the entry point into manual-mode.js's ExecutionEngine, which was fully built but never wired anywhere.
        [
          { text: `📝 Take (Track)`, callback_data: `TAKE:${signalId}` },
          { text: `👁 Watch`,         callback_data: `WATCH:${signalId}` },
        ],
        [
          { text: `🏆 Win`,       callback_data: `WIN:${signalId}` },
          { text: `💀 Loss`,      callback_data: `LOSS:${signalId}` },
          { text: `⚖️ BE`,        callback_data: `BE:${signalId}` },
        ],
      ],
    };
  }

  static confirmKeyboard(signalId) {
    return {
      inline_keyboard: [[
        { text: `⚡ EXECUTE NOW`, callback_data: `EXECUTE:${signalId}` },
        { text: `❌ Cancel`,      callback_data: `CANCEL:${signalId}` },
      ]],
    };
  }

  static mainMenu() {
    return {
      keyboard: [
        [{ text: '📊 Status' }, { text: '📡 Signals' }],
        [{ text: '📈 Markets' }, { text: '⚙️ Risk' }],
        [{ text: '🧮 Calculator' }, { text: '❓ Help' }],
      ],
      resize_keyboard:   true,
      one_time_keyboard: false,
    };
  }
}

class ChartUrlBuilder {
  static build(symbol, timeframe, levels = {}) {
    const tfMap = {
      M1: '1', M5: '5', M15: '15', M30: '30',
      H1: '60', H2: '120', H4: '240', H6: '360',
      H8: '480', H12: '720', D1: 'D', W1: 'W',
    };

    const interval = tfMap[timeframe] || '60';
    const tvSymbol = this._formatSymbol(symbol);

    const params = new URLSearchParams({
      symbol:   tvSymbol,
      interval: interval,
      theme:    'dark',
      style:    '1',
      locale:   'en',
      hide_top_toolbar: '1',
    });

    return `https://www.tradingview.com/chart/?${params.toString()}`;
  }

  static _formatSymbol(symbol) {
    const forexPairs = ['EURUSD','GBPUSD','USDJPY','XAUUSD','XAGUSD','USDCAD','AUDUSD'];
    if (forexPairs.some(p => symbol.includes(p.slice(0, 3)))) {
      return `FOREXCOM:${symbol}`;
    }
    return `BINANCE:${symbol}`;
  }
}

class PositionCalculator {
  static calculate(params) {
    const {
      accountBalance = 1000,
      riskPct        = 1,
      entry,
      stopLoss,
      tp1,
      symbol = 'UNKNOWN',
    } = params;

    const riskUSD   = accountBalance * (riskPct / 100);
    const slPoints  = Math.abs(entry - stopLoss);
    const tp1Points = tp1 ? Math.abs(tp1 - entry) : slPoints * 1.5;
    const rr        = slPoints > 0 ? parseFloat((tp1Points / slPoints).toFixed(2)) : 0;

    let pipValue = 10;
    let lotSize  = 0;
    let units    = 0;

    if (symbol.includes('JPY')) {
      pipValue = 1000;
      const pips = slPoints / 0.01;
      lotSize    = parseFloat((riskUSD / (pips * pipValue * 0.0001)).toFixed(4));
      units      = Math.round(lotSize * 100000);
    } else if (symbol.includes('XAU') || symbol.includes('GOLD')) {
      const pips = slPoints / 0.01;
      lotSize    = parseFloat((riskUSD / pips).toFixed(3));
      units      = lotSize;
      pipValue   = 1;
    } else if (symbol.includes('BTC') || symbol.includes('ETH')) {
      lotSize  = parseFloat((riskUSD / slPoints).toFixed(6));
      units    = lotSize;
      pipValue = slPoints;
    } else {
      const pips = slPoints / 0.0001;
      lotSize    = parseFloat((riskUSD / (pips * pipValue * 0.0001)).toFixed(4));
      units      = Math.round(lotSize * 100000);
    }

    const potentialProfitUSD = riskUSD * rr;

    return {
      accountBalance,
      riskPct,
      riskUSD:            parseFloat(riskUSD.toFixed(2)),
      entry,
      stopLoss,
      tp1,
      slPoints:           parseFloat(slPoints.toFixed(5)),
      tp1Points:          parseFloat(tp1Points.toFixed(5)),
      rr,
      lotSize,
      units,
      potentialProfitUSD: parseFloat(potentialProfitUSD.toFixed(2)),
      symbol,
      note: `Risk $${riskUSD.toFixed(2)} for potential $${potentialProfitUSD.toFixed(2)}`,
    };
  }
}

class DeliveryTracker {
  constructor() {
    this._receipts  = new Map();
    this._lastSignal = null;
  }

  record(signalId, chatId, messageId) {
    if (!this._receipts.has(signalId)) {
      this._receipts.set(signalId, { chatIds: [], messageIds: [], timestamp: Date.now() });
    }
    const r = this._receipts.get(signalId);
    r.chatIds.push(chatId);
    r.messageIds.push({ chatId, messageId });
    this._lastSignal = signalId;
  }

  get(signalId) {
    return this._receipts.get(signalId) || null;
  }

  getLastSignalId() {
    return this._lastSignal;
  }

  getRecent(n = 5) {
    const entries = [...this._receipts.entries()];
    return entries.slice(-n).reverse().map(([id, data]) => ({ id, ...data }));
  }

  size() { return this._receipts.size; }
}

class LongPollManager {
  constructor(client, handler) {
    this._client  = client;
    this._handler = handler;
    this._offset  = 0;
    this._running = false;
    this._timer   = null;
    this._conflictWarned = false;
  }

  start() {
    this._running = true;
    this._poll();
    console.log('[LongPoll] Started polling for updates');
  }

  stop() {
    this._running = false;
    if (this._timer) clearTimeout(this._timer);
    console.log('[LongPoll] Stopped');
  }

  async _poll() {
    if (!this._running) return;

    let nextDelay = 500;
    try {
      const updates = await this._client.getUpdates(this._offset, 30);
      for (const update of (updates || [])) {
        this._offset = update.update_id + 1;
        await this._handler(update);
      }
      this._conflictWarned = false;
    } catch (err) {
      // FIX: a 409 here means Telegram is rejecting this getUpdates call because ANOTHER process is already long-polling with the exact same bot token — Telegram only allows one consumer at a time.
      const isConflict = err.message?.includes('409') || err.message?.includes('Conflict');
      if (isConflict) {
        nextDelay = 30000;
        if (!this._conflictWarned) {
          console.error('[LongPoll] 409 Conflict: another process is already polling this bot token. This will not resolve by retrying — find and stop the other running instance (duplicate Render service, an old deploy still alive, or a local dev instance using the same TELEGRAM_BOT_TOKEN). Backing off to 30s between attempts until it clears.');
          this._conflictWarned = true;
        }
      } else {
        console.error('[LongPoll] Error:', err.message);
      }
    }

    if (this._running) {
      this._timer = setTimeout(() => this._poll(), nextDelay);
    }
  }
}

class WebhookServer {
  constructor(handler, port = 3000, secret = 'trading-assistant-webhook') {
    this._handler = handler;
    this._port    = port;
    this._secret  = secret;
    this._server  = null;
  }

  start() {
    this._server = http.createServer(async (req, res) => {
      const pathname = new URL(req.url, `http://localhost`).pathname;

      if (req.method === 'POST' && pathname === `/${this._secret}`) {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
          try {
            const update = JSON.parse(body);
            await this._handler(update);
            res.writeHead(200);
            res.end('OK');
          } catch (e) {
            res.writeHead(400);
            res.end('Bad request');
          }
        });
      } else if (req.method === 'GET' && pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', timestamp: Date.now() }));
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    this._server.listen(this._port, () => {
      console.log(`[WebhookServer] Listening on port ${this._port}`);
    });

    return this._server;
  }

  stop() {
    if (this._server) this._server.close();
  }

  getPath() {
    return `/${this._secret}`;
  }
}

class AlertDispatcher extends EventEmitter {
  constructor(config = {}) {
    super();

    this.token          = config.token          || process.env.TELEGRAM_BOT_TOKEN || '';
    this.chatIds        = config.chatIds        || [];
    this.adminChatIds   = config.adminChatIds   || this.chatIds;
    this.gradeAChatId   = config.gradeAChatId   || null;
    this.webhookUrl     = config.webhookUrl     || null;
    this.webhookPort    = config.webhookPort    || 3001;
    this.useLongPoll    = config.useLongPoll    !== false;
    this.accountBalance = config.accountBalance || 1000;
    this.riskPct        = config.riskPct        || 1;

    this.scorer         = config.scorer         || null;
    this.feed           = config.feed           || null;
    this.riskEngine     = config.riskEngine     || null;
    this._store         = config.store          || null;

    this._client        = new TelegramClient(this.token);
    this._queue         = new SignalQueue();
    this._dedup         = new DedupManager();
    this._delivery      = new DeliveryTracker();
    this._paused        = false;
    this._pendingSignals = new Map();
    this._approvedSignals = new Map();
    this._recordedOutcomes = new Set();
    this._subscribers   = new Set();
    this._bot           = null;

    this._queueTimer    = null;

    this._stats = {
      signalsSent:     0,
      messagesSent:    0,
      errorsCount:     0,
      commandsHandled: 0,
      startTime:       null,
    };
  }

  async init() {
    if (!this.token) {
      throw new Error('[AlertDispatcher] No Telegram bot token provided. Set TELEGRAM_BOT_TOKEN env var.');
    }

    console.log('[AlertDispatcher] Initializing...');

    try {
      this._bot = await this._client.getMe();
      console.log(`[AlertDispatcher] Bot verified: @${this._bot.username} (ID: ${this._bot.id})`);
    } catch (err) {
      throw new Error(`[AlertDispatcher] Bot token invalid: ${err.message}`);
    }

    try {
      await this._client.setMyCommands(BOT_COMMANDS);
      console.log('[AlertDispatcher] Commands registered');
    } catch (err) {
      console.warn('[AlertDispatcher] Failed to set commands:', err.message);
    }

    if (this.useLongPoll) {
      this._poller = new LongPollManager(this._client, (u) => this._handleUpdate(u));
      this._poller.start();
    } else if (this.webhookUrl) {
      this._webhookServer = new WebhookServer(
        (u) => this._handleUpdate(u),
        this.webhookPort
      );
      this._webhookServer.start();
      await this._client.setWebhook(`${this.webhookUrl}${this._webhookServer.getPath()}`);
      console.log(`[AlertDispatcher] Webhook set: ${this.webhookUrl}`);
    }

    this._stats.startTime = Date.now();
    this._queueTimer = setInterval(() => this._processQueue(), QUEUE_INTERVAL_MS);

    setInterval(() => this._dedup.cleanup(), 10 * 60 * 1000);

    await this._loadSubscribers();

    await this._broadcastToAdmins(
      `${EMOJI.ROCKET} <b>AI Trading Assistant Online</b>\n\n` +
      `Bot: @${this._bot.username}\n` +
      `Subscribers: ${this._subscribers.size + this.chatIds.length}\n` +
      `Mode: ${this.useLongPoll ? 'Long Poll' : 'Webhook'}\n` +
      `Risk: ${this.riskPct}% per trade\n\n` +
      `<i>System ready. Waiting for signals...</i>`
    );

    this.emit('ready', { bot: this._bot });
    console.log('[AlertDispatcher] Ready ✓');
  }

  async sendSignal(signal) {
    if (this._paused) {
      console.log('[AlertDispatcher] Paused — signal queued but not sent');
      return;
    }

    if (this._dedup.isDuplicate(signal)) {
      console.log(`[AlertDispatcher] Duplicate signal suppressed: ${signal.symbol} ${signal.action}`);
      return;
    }

    if (!signal.id) {
      signal.id = `${signal.symbol}-${signal.action}-${Date.now()}`;
    }

    this._pendingSignals.set(signal.id, signal);
    this._stats.signalsSent++;

    const priority  = signal.score?.grade === 'A' ? PRIORITY.HIGH : PRIORITY.NORMAL;
    const text      = MessageFormatter.formatSignal(signal);
    const keyboard  = KeyboardBuilder.signalKeyboard(signal.id, signal.symbol);
    const chartUrl  = ChartUrlBuilder.build(signal.symbol, signal.timeframe);

    let posCalcText = '';
    if (signal.entry && signal.stopLoss) {
      const calc = PositionCalculator.calculate({
        accountBalance: this.accountBalance,
        riskPct:        this.riskPct,
        entry:          signal.entry.zoneHigh,
        stopLoss:       signal.stopLoss.price,
        tp1:            signal.targets?.tp1?.price,
        symbol:         signal.symbol,
      });
      posCalcText = `\n\n${EMOJI.CHART} <b>Suggested size:</b> ${calc.lotSize} lots / $${calc.riskUSD} risk`;
    }

    // FIX: chartUrl was computed but never attached to the outgoing message — the chart link feature was silently dead.
    const chartLinkText = chartUrl
      ? `\n\n${EMOJI.CHART} <a href="${chartUrl}">View ${signal.symbol} chart on TradingView</a>`
      : '';

    let explanationText = '';
    if (signal.explanation) {
      const { summary, cautions } = signal.explanation;
      explanationText = `\n\n${EMOJI.CHART} <b>Why this signal:</b> ${summary}`;
      if (cautions?.length > 1) {
        explanationText += `\n${cautions.slice(1).map(c => `⚠️ ${c}`).join('\n')}`;
      }
    }

    const allChatIds = this._getAllChatIds();
    for (const chatId of allChatIds) {
      this._queue.push({
        priority,
        chatId,
        fn: async () => {
          try {
            const msg = await this._client.sendMessage(
              chatId,
              text + posCalcText + chartLinkText + explanationText,
              { replyMarkup: keyboard }
            );
            this._delivery.record(signal.id, chatId, msg.message_id);
            this._stats.messagesSent++;
          } catch (err) {
            this._stats.errorsCount++;
            console.error(`[AlertDispatcher] Send error to ${chatId}:`, err.message);
          }
        },
      });
    }

    if (signal.score?.grade === 'A' && this.gradeAChatId) {
      this._queue.push({
        priority: PRIORITY.HIGH,
        chatId: this.gradeAChatId,
        fn: async () => {
          await this._client.sendMessage(
            this.gradeAChatId,
            `${EMOJI.GRADE_A} <b>GRADE A SIGNAL</b>\n\n` + MessageFormatter.formatShortAlert(signal),
            { replyMarkup: KeyboardBuilder.signalKeyboard(signal.id, signal.symbol) }
          );
        },
      });
    }

    this.emit('signal_sent', signal);
    console.log(`[AlertDispatcher] Signal queued: ${signal.action} ${signal.symbol} | Grade ${signal.score?.grade} | Score ${signal.score?.final}`);
  }

  async sendLiquidationCascade(data) {
    const text = MessageFormatter.formatLiquidationCascade(data);

    for (const chatId of this._getAllChatIds()) {
      this._queue.push({
        priority: PRIORITY.EMERGENCY,
        chatId,
        fn: async () => {
          await this._client.sendMessage(chatId, text);
        },
      });
    }

    this.emit('cascade_alert', data);
  }

  // FIX: manual-mode.js's ExecutionEngine (a fully-built manual/semi-auto position-tracking system) calls dispatcher.sendTPHit/sendSLHit/ sendBreakeven/sendTrailUpdate — none of which existed anywhere on...

  async sendTPHit(signalId, tpNumber, price, pnlR, remainingPct, symbol) {
    const text = `${EMOJI.GRADE_A} <b>TP${tpNumber} HIT</b> — ${symbol}\n` +
      `Price: ${price} | +${pnlR.toFixed(2)}R\n` +
      (remainingPct > 0 ? `Remaining position: ${remainingPct.toFixed(0)}%` : `Position closed.`);

    for (const chatId of this._getAllChatIds()) {
      this._queue.push({
        priority: PRIORITY.HIGH,
        chatId,
        fn: async () => { await this._client.sendMessage(chatId, text); },
      });
    }
    this.emit('tp_hit_notified', { signalId, tpNumber, price, pnlR, symbol });
  }

  async sendSLHit(signalId, price, pnlR, symbol, wasBreakeven) {
    const text = `${wasBreakeven ? EMOJI.CHART : EMOJI.ALERT} <b>${wasBreakeven ? 'BREAKEVEN STOP' : 'SL HIT'}</b> — ${symbol}\n` +
      `Price: ${price} | ${pnlR >= 0 ? '+' : ''}${pnlR.toFixed(2)}R`;

    for (const chatId of this._getAllChatIds()) {
      this._queue.push({
        priority: PRIORITY.HIGH,
        chatId,
        fn: async () => { await this._client.sendMessage(chatId, text); },
      });
    }
    this.emit('sl_hit_notified', { signalId, price, pnlR, symbol, wasBreakeven });
  }

  async sendBreakeven(positionId, symbol, newSL, direction) {
    const text = `${EMOJI.CHART} <b>BREAKEVEN SET</b> — ${direction} ${symbol}\n` +
      `Stop moved to ${newSL} — this trade can no longer lose.`;

    for (const chatId of this._getAllChatIds()) {
      this._queue.push({
        priority: PRIORITY.NORMAL,
        chatId,
        fn: async () => { await this._client.sendMessage(chatId, text); },
      });
    }
    this.emit('breakeven_notified', { positionId, symbol, newSL, direction });
  }

  async sendTrailUpdate(positionId, symbol, direction, newSL, delta, unrealizedPnlR) {
    const text = `${EMOJI.CHART} <b>TRAIL UPDATED</b> — ${direction} ${symbol}\n` +
      `New stop: ${newSL} (moved ${delta > 0 ? '+' : ''}${delta})\n` +
      `Unrealized: ${unrealizedPnlR >= 0 ? '+' : ''}${unrealizedPnlR.toFixed(2)}R`;

    for (const chatId of this._getAllChatIds()) {
      this._queue.push({
        priority: PRIORITY.LOW,
        chatId,
        fn: async () => { await this._client.sendMessage(chatId, text); },
      });
    }
    this.emit('trail_notified', { positionId, symbol, direction, newSL, delta });
  }

  // Send an arbitrary HTML-formatted message (used by ExecutionEngine for entry-blocked/warning/order-failure notices — same missing-method pattern as sendTPHit et al above).
  async sendCustom(text, options = {}) {
    for (const chatId of this._getAllChatIds()) {
      this._queue.push({
        priority: options.silent ? PRIORITY.LOW : PRIORITY.NORMAL,
        chatId,
        fn: async () => { await this._client.sendMessage(chatId, text, { silent: options.silent }); },
      });
    }
  }

  async sendDailySummary({ signals = {}, risk = {}, sessions = {}, topSetup = null } = {}) {
    const lines = [
      `${EMOJI.BRAIN} <b>Daily Summary</b>`,
      '',
      `Signals fired: ${signals.fired ?? 0} | Trades: ${(signals.wins || 0) + (signals.losses || 0)}`,
      `Win rate: ${signals.winRate != null ? signals.winRate + '%' : 'n/a'} | Profit factor: ${signals.profitFactor ?? 'n/a'}`,
      `Avg win: ${signals.avgWin ?? 'n/a'}R | Avg loss: ${signals.avgLoss ?? 'n/a'}R`,
      '',
      `Daily PnL: ${risk.dailyPnl != null ? risk.dailyPnl + '%' : 'n/a'} | Drawdown: ${risk.drawdown != null ? risk.drawdown + '%' : 'n/a'}`,
    ];
    if (topSetup) lines.push('', `Best setup today: ${topSetup}`);

    const text = lines.join('\n');
    for (const chatId of this._getAllChatIds()) {
      this._queue.push({ priority: PRIORITY.LOW, chatId, fn: async () => { await this._client.sendMessage(chatId, text); } });
    }
  }

  async sendWhaleTrade(trade) {
    if (trade.usdtValue < 500000) return;

    const text = MessageFormatter.formatWhaleTrade(trade);
    for (const chatId of this._getAllChatIds()) {
      this._queue.push({
        priority: PRIORITY.NORMAL,
        chatId,
        fn: async () => this._client.sendMessage(chatId, text),
      });
    }
  }

  async sendFundingExtreme(extremes) {
    const text = MessageFormatter.formatFundingExtreme(extremes);
    for (const chatId of this._getAllChatIds()) {
      this._queue.push({
        priority: PRIORITY.NORMAL,
        chatId,
        fn: async () => this._client.sendMessage(chatId, text),
      });
    }
  }

  async broadcast(text, priority = PRIORITY.NORMAL) {
    for (const chatId of this._getAllChatIds()) {
      this._queue.push({
        priority,
        chatId,
        fn: async () => this._client.sendMessage(chatId, text),
      });
    }
  }

  async _handleUpdate(update) {
    try {
      if (update.message) {
        await this._handleMessage(update.message);
      } else if (update.callback_query) {
        await this._handleCallback(update.callback_query);
      }
    } catch (err) {
      console.error('[AlertDispatcher] Update handler error:', err.message);
    }
  }

  async _handleMessage(message) {
    const chatId  = message.chat.id;
    const text    = message.text || '';
    const userId  = message.from?.id;

    this._stats.commandsHandled++;

    const parts   = text.split(' ');
    const command = parts[0].toLowerCase().replace('@' + (this._bot?.username ?? ''), '');
    const args    = parts.slice(1);

    console.log(`[AlertDispatcher] Command: ${command} from ${userId}`);

    switch (command) {
      case '/start':
        await this._registerSubscriber(chatId, message.from);
        await this._client.sendMessage(
          chatId,
          `${EMOJI.ROCKET} <b>Welcome to OMNICEE AI Trading!</b>\n\n` +
          `${EMOJI.SIGNAL} You are now subscribed to live trading signals.\n` +
          `I monitor markets 24/7 and send you institutional-grade signals.\n\n` +
          `Use /help to see all commands.\n` +
          `Use /unsub to stop receiving signals.`,
          { replyMarkup: KeyboardBuilder.mainMenu() }
        );
        break;

      case '/help':
        await this._client.sendMessage(chatId, MessageFormatter.formatHelp());
        break;

      case '/status':
        await this._sendStatusMessage(chatId);
        break;

      case '/signals':
        await this._sendRecentSignals(chatId);
        break;

      case '/stats':
        await this._sendStats(chatId);
        break;

      case '/risk':
        await this._sendRiskStatus(chatId);
        break;

      case '/outlook':
        await this._sendMarketOutlook(chatId);
        break;

      case '/pause':
        if (this._isAdmin(userId)) {
          this._paused = true;
          await this._client.sendMessage(chatId, `${EMOJI.WARNING} Signal delivery paused.`);
        }
        break;

      case '/resume':
        if (this._isAdmin(userId)) {
          this._paused = false;
          await this._client.sendMessage(chatId, `${EMOJI.ROCKET} Signal delivery resumed.`);
        }
        break;

      case '/win':
        await this._recordOutcome(chatId, 'WIN', args);
        break;

      case '/loss':
        await this._recordOutcome(chatId, 'LOSS', args);
        break;

      case '/be':
        await this._recordOutcome(chatId, 'BREAKEVEN', args);
        break;

      case '/balance': {
        if (args[0]) {
          const bal = parseFloat(args[0]);
          if (!isNaN(bal) && bal > 0) {
            this.accountBalance = bal;
            await this._client.sendMessage(chatId, `${EMOJI.MONEY} Account balance set to $${bal.toLocaleString()}`);
          }
        } else {
          await this._client.sendMessage(chatId, `${EMOJI.MONEY} Current balance: $${this.accountBalance.toLocaleString()}`);
        }
        break;
      }

      case '/setsize': {
        const pct = parseFloat(args[0]);
        if (!isNaN(pct) && pct > 0 && pct <= 10) {
          this.riskPct = pct;
          await this._client.sendMessage(chatId, `${EMOJI.CHART} Risk per trade set to ${pct}%`);
        } else {
          await this._client.sendMessage(chatId, `Usage: /setsize 1.5 (max 10%)`);
        }
        break;
      }

      case '/calc': {
        if (args.length < 2) {
          await this._client.sendMessage(chatId,
            `Usage: /calc <entry> <stoploss> [tp1]\nExample: /calc 2345 2330 2380`
          );
          break;
        }
        const calc = PositionCalculator.calculate({
          accountBalance: this.accountBalance,
          riskPct:        this.riskPct,
          entry:          parseFloat(args[0]),
          stopLoss:       parseFloat(args[1]),
          tp1:            args[2] ? parseFloat(args[2]) : undefined,
          symbol:         args[3] || 'FOREX',
        });
        await this._client.sendMessage(chatId, MessageFormatter.formatPositionSize(calc));
        break;
      }

      case '/markets': {
        const { SessionDetector } = this._getSessionDetector();
        const session = SessionDetector.getCurrent();
        const next    = SessionDetector.getNextKillzone();
        await this._client.sendMessage(
          chatId,
          MessageFormatter.formatSessions({ ...session, nextKillzone: next })
        );
        break;
      }

      case '📊 status':
        await this._sendStatusMessage(chatId);
        break;

      case '📡 signals':
        await this._sendRecentSignals(chatId);
        break;

      case '📈 markets': {
        const { SessionDetector } = this._getSessionDetector();
        const s2 = SessionDetector.getCurrent();
        await this._client.sendMessage(chatId, MessageFormatter.formatSessions(s2));
        break;
      }

      case '/unsub':
        this._subscribers.delete(String(chatId));
        if (this._store?.unsubscribeTelegramUser) {
          await this._store.unsubscribeTelegramUser(chatId);
        }
        await this._client.sendMessage(chatId,
          `${EMOJI.WARNING} You have unsubscribed from signals. Send /start to resubscribe.`
        );
        break;

      case '/sub':
        await this._registerSubscriber(chatId, message.from);
        await this._client.sendMessage(chatId,
          `${EMOJI.SIGNAL} You are now subscribed to live trading signals!`
        );
        break;

      default:
        if (!this._subscribers.has(String(chatId)) && !this.chatIds.includes(String(chatId))) {
          await this._registerSubscriber(chatId, message.from);
        }
        if (text.startsWith('/')) {
          await this._client.sendMessage(chatId,
            `Unknown command. Try /help for a list of commands.`
          );
        }
        break;
    }
  }

  async _handleCallback(callback) {
    const chatId          = callback.message?.chat?.id;
    const messageId       = callback.message?.message_id;
    const callbackQueryId = callback.id;
    const data            = callback.data || '';

    const [action, signalId] = data.split(':');
    const signal             = this._pendingSignals.get(signalId);

    try {
      switch (action) {
        case 'APPROVE': {
          await this._client.answerCallback(callbackQueryId, '✅ Signal approved!', false);
          if (signal) {
            this._approvedSignals.set(signalId, { ...signal, approvedAt: Date.now(), executed: false });
            this.emit('signal_approved', { signal, chatId });
            await this._client.editMessage(
              chatId, messageId,
              `✅ <b>APPROVED</b> — ${signal.action} ${signal.symbol}\n` +
              `<i>Signal sent to MT5 for execution. Waiting for EA...</i>`
            );
          }
          break;
        }

        case 'SKIP': {
          await this._client.answerCallback(callbackQueryId, '❌ Signal skipped', false);
          if (signal) {
            this.emit('signal_skipped', { signal, chatId });
            await this._client.editMessage(
              chatId, messageId,
              `❌ <b>SKIPPED</b> — ${signal.action} ${signal.symbol}`
            );
          }
          break;
        }

        case 'DETAILS': {
          if (signal) {
            const detail = [
              `${EMOJI.BRAIN} <b>Full Signal Details</b>`,
              '',
              `ID: <code>${signalId}</code>`,
              `Time: ${new Date(signal.timestamp).toUTCString()}`,
              '',
              `<b>All Agent Scores:</b>`,
              ...(signal.agentBreakdown || []).map(a =>
                `  ${a.agent}: ${a.score}/100 [${a.status}]`
              ),
              '',
              `<b>All Reasons:</b>`,
              ...(signal.allReasons || []).map(r => `  • ${r}`),
            ].join('\n');

            await this._client.answerCallback(callbackQueryId, 'Details below', false);
            await this._client.sendMessage(chatId, detail);
          }
          break;
        }

        case 'CHART': {
          const symbol   = signalId;
          const chartUrl = ChartUrlBuilder.build(symbol, 'H1');
          await this._client.answerCallback(callbackQueryId, 'Chart link sent!', false);
          await this._client.sendMessage(chatId,
            `${EMOJI.CHART} <a href="${chartUrl}">Open ${symbol} chart on TradingView</a>`
          );
          break;
        }

        case 'WIN':
        case 'LOSS':
        case 'BE': {
          const result  = action;
          if (this._recordedOutcomes.has(signalId)) {
            await this._client.answerCallback(callbackQueryId, 'Already recorded for this signal', true);
            break;
          }
          this._recordedOutcomes.add(signalId);

          // NOTE: these are placeholder R-multiples for a single quick tap — a button can't capture the real P&L of a specific trade.
          const pnlMap  = { WIN: 1.5, LOSS: -1, BE: 0 };
          const pnlR    = pnlMap[result];
          const outcome = { result, pnlPct: pnlR, pnlR, note: `Recorded via Telegram callback` };

          if (this.scorer) {
            this.scorer.recordTradeOutcome(signalId, outcome);
          }

          // It also never touched adaptiveLearning, bayesianEng, walkForward, institutionalGates, sessionFilter, or institutionalRiskManager.
          try {
            const { recordOutcomeEverywhere } = require('./outcome-recorder');
            const { getEngines } = require('../api/realtime');
            const mongoStore = require('../db');
            await recordOutcomeEverywhere({
              signalId, signal, outcome: { pnlR, result },
              mongoStore, engines: getEngines(),
            });
          } catch (_) { }

          await this._client.answerCallback(callbackQueryId, `${result} recorded!`, true);
          this.emit('trade_outcome', { signalId, outcome, signal });
          break;
        }

        case 'TAKE': {
          if (!this.executionEngine) {
            await this._client.answerCallback(callbackQueryId, 'Manual tracking is not enabled.', true);
            break;
          }
          const result = await this.executionEngine.onTrade(signalId, {}).catch(e => ({ success: false, reason: e.message }));
          if (!result?.success) {
            await this._client.answerCallback(callbackQueryId, `Could not start tracking: ${result?.reason || 'unknown error'}`, true);
          } else {
            await this._client.answerCallback(callbackQueryId, '📝 Tracking this trade — TP/SL/BE alerts will follow live price.', true);
          }
          break;
        }

        case 'WATCH': {
          if (!this.executionEngine) {
            await this._client.answerCallback(callbackQueryId, 'Manual tracking is not enabled.', true);
            break;
          }
          // FIX: previously silent — the bot confirms "👁 Watching" to the user immediately below regardless of whether this actually succeeded, so a failure here was both invisible AND actively misleading (user...
          await this.executionEngine.onWatch(signalId)
            .catch(e => console.warn(`[AlertDispatcher] onWatch failed for signal ${signalId}: ${e.message}`));
          await this._client.answerCallback(callbackQueryId, '👁 Watching — no position opened.', false);
          break;
        }

        case 'EXECUTE': {
          if (signal) {
            this.emit('execute_signal', { signal, chatId });
            await this._client.answerCallback(callbackQueryId, '⚡ Executing trade!', true);
            await this._client.editMessage(
              chatId, messageId,
              `⚡ <b>EXECUTING</b> — ${signal.action} ${signal.symbol}\n` +
              `<i>Order placed via Binance API...</i>`
            );
          }
          break;
        }

        case 'CANCEL': {
          await this._client.answerCallback(callbackQueryId, 'Cancelled', false);
          await this._client.editMessage(chatId, messageId, '❌ Trade cancelled.');
          break;
        }

        default:
          await this._client.answerCallback(callbackQueryId, 'Unknown action', false);
          break;
      }
    } catch (err) {
      console.error('[AlertDispatcher] Callback error:', err.message);
      this._stats.errorsCount++;
    }
  }

  async _sendStatusMessage(chatId) {
    const status = {
      feed:    this.feed?.getStats?.()    || {},
      scorer:  this.scorer?.getStats?.()  || {},
      risk:    this.scorer?.circuitBreaker?.getStats?.() || {},
      signals: this.scorer?.history?.getStats?.() || {},
    };
    await this._client.sendMessage(chatId, MessageFormatter.formatStatus(status));
  }

  async _sendRecentSignals(chatId) {
    const recent = this._delivery.getRecent(5);
    if (recent.length === 0) {
      await this._client.sendMessage(chatId, 'No signals sent yet.');
      return;
    }

    const lines = [`${EMOJI.SIGNAL} <b>Recent Signals</b>`, ''];
    for (const r of recent) {
      const sig = this._pendingSignals.get(r.id);
      if (sig) {
        lines.push(`${sig.action === 'LONG' ? EMOJI.LONG : EMOJI.SHORT} ${sig.symbol} ${sig.timeframe} — Grade ${sig.score?.grade} — ${new Date(r.timestamp).toTimeString().slice(0,8)} UTC`);
      }
    }

    await this._client.sendMessage(chatId, lines.join('\n'));
  }

  async _sendStats(chatId) {
    const stats = this.scorer?.getStats?.() || {};
    const sigs  = stats.signals || {};

    const lines = [
      `${EMOJI.CHART} <b>Performance Stats</b>`,
      '',
      `Total signals: ${sigs.total ?? 0}`,
      `Closed trades: ${sigs.closed ?? 0}`,
      `Win rate:      <b>${sigs.winRate ?? 0}%</b>`,
      `Profit factor: <b>${sigs.profitFactor ?? 0}</b>`,
      `Wins:          ${sigs.wins ?? 0}`,
      `Losses:        ${sigs.losses ?? 0}`,
      `Breakevens:    ${sigs.breakevens ?? 0}`,
      '',
      `<b>By Symbol:</b>`,
      ...Object.entries(sigs.bySymbol || {}).map(([sym, d]) =>
        `  ${sym}: ${d.winRate}% (${d.wins}W/${d.losses}L)`
      ),
    ];

    await this._client.sendMessage(chatId, lines.join('\n'));
  }

  async _sendRiskStatus(chatId) {
    const risk = this.scorer?.circuitBreaker?.getStats?.() || {};
    const lines = [
      `${EMOJI.WARNING} <b>Risk Engine Status</b>`,
      '',
      `Daily PnL:    ${risk.dailyPnl ?? 0}%`,
      `Weekly PnL:   ${risk.weeklyPnl ?? 0}%`,
      `Consec. losses: ${risk.consecutiveLosses ?? 0}`,
      `Max daily loss: ${risk.maxDailyLoss ?? 3}%`,
      `Circuit breaker: ${risk.isPaused ? '🔴 PAUSED — ' + risk.pausedReason : '🟢 Active'}`,
      `Signals paused: ${this._paused ? '🔴 Yes' : '🟢 No'}`,
    ];
    await this._client.sendMessage(chatId, lines.join('\n'));
  }

  async _sendMarketOutlook(chatId) {
    if (typeof this.getMarketOutlookDeps !== 'function') {
      await this._client.sendMessage(chatId, `${EMOJI.WARNING} Outlook unavailable — trading engine not yet initialized.`);
      return;
    }
    let outlook;
    try {
      const { MarketOutlookBuilder } = require('./market-outlook');
      const deps = this.getMarketOutlookDeps();
      outlook = MarketOutlookBuilder.build({ ...deps, timeframe: 'H1' });
    } catch (err) {
      await this._client.sendMessage(chatId, `${EMOJI.WARNING} Could not build outlook: ${err.message}`);
      return;
    }

    // NOTE: MarketOutlookBuilder deliberately stopped returning calendar data (outlook.week / outlook.nextWeek no longer exist — see the "Calendar is intentionally NOT part of Market Outlook" comment in...
    const lines = [`${EMOJI.CHART} <b>Market Outlook — This Week &amp; Next</b>`, ''];
    lines.push(outlook.narrative);
    lines.push('');
    lines.push('<i>Economic calendar moved to the Intel tab / /api/calendar.</i>');

    const withPositioning = outlook.symbols.filter(s => s.institutionalPositioning);
    if (withPositioning.length) {
      lines.push('');
      lines.push('<b>Institutional positioning (CFTC, weekly):</b>');
      for (const s of withPositioning) {
        const p = s.institutionalPositioning;
        lines.push(`  • ${s.symbol}: large-spec (hedge fund) net ${p.largeSpecNet > 0 ? '+' : ''}${p.largeSpecNet.toLocaleString()}, ${Math.round(p.largeSpecPercentile)}th percentile${p.isExtreme ? ' ⚠️ EXTREME' : ''}`);
      }
    }

    lines.push('');
    lines.push('<i>This is a summary of scheduled events and known positioning, not a forecast — treat it as context, not a guarantee.</i>');

    await this._client.sendMessage(chatId, lines.join('\n'));
  }

  async _recordOutcome(chatId, result, args) {
    const lastSignalId = this._delivery.getLastSignalId();
    if (!lastSignalId) {
      await this._client.sendMessage(chatId, 'No recent signal to record outcome for.');
      return;
    }

    const signal  = this._pendingSignals.get(lastSignalId);
    const pnlMap  = { WIN: this.riskPct * 1.5, LOSS: -this.riskPct, BREAKEVEN: 0 };
    const pnlPct  = parseFloat(args[0] || pnlMap[result]);
    // FIX: recordOutcome() (signal-pipeline/adaptive-learning-engine.js) derives WIN/LOSS/BREAKEVEN from outcome.pnlR, not from a `result` string — this object never had a pnlR field, so every /win, /loss,...
    const pnlR = this.riskPct > 0 ? pnlPct / this.riskPct : (result === 'WIN' ? 1 : result === 'LOSS' ? -1 : 0);
    const outcome = {
      result,
      pnlPct: pnlPct.toFixed(2),
      pnlR,
      note:   `Manual via /${result.toLowerCase()}`,
    };

    // FIX: this.scorer was never assigned anywhere in the codebase, so this outcome was recorded nowhere — the confirmation message sent below was the ONLY effect of /win, /loss, /be.
    if (this.scorer) {
      this.scorer.recordTradeOutcome(lastSignalId, outcome);
    }

    await this._client.sendMessage(
      chatId,
      MessageFormatter.formatOutcome(outcome, signal)
    );

    this.emit('trade_outcome', { signalId: lastSignalId, outcome, signal });
  }

  _getAllChatIds() {
    const all = new Set(this.chatIds.map(String));
    for (const id of this._subscribers) all.add(id);
    return [...all];
  }

  async _registerSubscriber(chatId, fromUser) {
    const id = String(chatId);
    this._subscribers.add(id);
    if (this._store?.upsertTelegramUser) {
      try {
        const userUpdate = fromUser ? { ...fromUser, id: chatId } : { id: chatId };
        await this._store.upsertTelegramUser({ ...userUpdate, subscribed: true });
      } catch (e) {
        console.warn('[AlertDispatcher] Failed to save subscriber:', e.message);
      }
    }
    console.log(`[AlertDispatcher] Subscriber registered: ${id} (total: ${this._subscribers.size})`);
  }

  async _loadSubscribers() {
    if (!this._store?.getSubscriberChatIds) return;
    try {
      const ids = await this._store.getSubscriberChatIds();
      for (const id of ids) this._subscribers.add(String(id));
      console.log(`[AlertDispatcher] Loaded ${ids.length} subscribers from database`);
    } catch (e) {
      console.warn('[AlertDispatcher] Failed to load subscribers:', e.message);
    }
  }

  async _broadcastToAdmins(text) {
    for (const chatId of this.adminChatIds) {
      try {
        await this._client.sendMessage(chatId, text);
      } catch (err) {
        console.error(`[AlertDispatcher] Admin broadcast error to ${chatId}:`, err.message);
      }
    }
  }

  _isAdmin(userId) {
    return true;
  }

  _getSessionDetector() {
    try {
      return require('./signal-scorer');
    } catch {
      return {
        SessionDetector: {
          getCurrent: () => ({ best: { name: 'Unknown', quality: 'UNKNOWN', note: '' }, utcHour: 0, isKillzone: false, nextKillzone: null }),
          getNextKillzone: () => ({ session: 'Unknown', hoursAway: 0 }),
        },
      };
    }
  }

  async _processQueue() {
    const item = this._queue.next();
    if (item) await this._queue.execute(item);
  }

  pause()  { this._paused = true;  console.log('[AlertDispatcher] Paused'); }
  resume() { this._paused = false; console.log('[AlertDispatcher] Resumed'); }

  getApprovedSignals() {
    const approved = [];
    for (const [id, sig] of this._approvedSignals) {
      if (!sig.executed) approved.push({ id, ...sig });
    }
    return approved;
  }

  markSignalExecuted(signalId, executionDetails = {}) {
    const sig = this._approvedSignals.get(signalId);
    if (!sig) return false;
    sig.executed = true;
    sig.executedAt = Date.now();
    sig.executionDetails = executionDetails;
    this.emit('signal_executed', { signalId, signal: sig, executionDetails });
    const text = `${EMOJI.LIGHTNING} <b>TRADE EXECUTED</b>\n\n` +
      `${sig.action === 'LONG' ? EMOJI.LONG : EMOJI.SHORT} ${sig.action} <code>${sig.symbol}</code>\n` +
      `Lot: <b>${executionDetails.lotSize || '?'}</b>\n` +
      `Entry: <code>${executionDetails.entryPrice || sig.currentPrice}</code>\n` +
      `SL: <code>${executionDetails.sl || sig.stopLoss?.price}</code>\n` +
      `TP: <code>${executionDetails.tp || sig.targets?.tp1?.price}</code>\n\n` +
      `<i>Executed by MT5 EA</i>`;
    this.broadcast(text, PRIORITY.HIGH);
    return true;
  }

  getStats() {
    const uptime = this._stats.startTime
      ? Math.floor((Date.now() - this._stats.startTime) / 1000)
      : 0;
    return {
      ...this._stats,
      uptime,
      queueSize:   this._queue.size(),
      paused:      this._paused,
      deliveries:  this._delivery.size(),
      pendingSignals: this._pendingSignals.size,
    };
  }

  async shutdown() {
    console.log('[AlertDispatcher] Shutting down...');
    clearInterval(this._queueTimer);
    if (this._poller)        this._poller.stop();
    if (this._webhookServer) this._webhookServer.stop();
    await this._broadcastToAdmins(`${EMOJI.WARNING} Trading assistant going offline.`);
  }
}

module.exports = {
  AlertDispatcher,
  TelegramClient,
  MessageFormatter,
  KeyboardBuilder,
  ChartUrlBuilder,
  PositionCalculator,
  DeliveryTracker,
  SignalQueue,
  DedupManager,
  WebhookServer,
  LongPollManager,
  EMOJI,
  PRIORITY,
  BOT_COMMANDS,
};

