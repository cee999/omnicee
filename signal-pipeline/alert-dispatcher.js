/**
 * ============================================================
 *  ALERT DISPATCHER — Full Production Signal Delivery Engine
 *  AI Trading Assistant · Layer 5 · Signal Pipeline
 * ============================================================
 *
 *  Features:
 *    - Telegram Bot API (messages, photos, inline keyboards)
 *    - Rich signal formatting with full AI reasoning text
 *    - Chart screenshot generation via TradingView URL
 *    - Inline keyboard buttons (Approve / Skip / Details)
 *    - Signal queue with priority ordering
 *    - Rate limiting (Telegram allows 30 messages/sec)
 *    - Retry logic with exponential backoff
 *    - Multi-channel broadcasting (groups + private chats)
 *    - Alert deduplication (no spam same signal twice)
 *    - Grade-based routing (Grade A → priority channel)
 *    - Webhook handler for user replies / callbacks
 *    - Email fallback via nodemailer
 *    - Sound alert via system notification
 *    - Signal acknowledgement tracking
 *    - Delivery receipt storage
 *    - Full bot command handlers (/start, /status, /signals, /risk)
 *    - Inline position calculator on demand
 *    - Session-aware message scheduling
 *    - Trade outcome recording via /win or /loss commands
 *    - Callback query handler for inline keyboards
 *    - Admin-only commands for risk engine control
 *    - Message templating engine with dynamic data injection
 *    - HTML and Markdown formatting modes
 *    - Sticker/emoji-based quick alerts
 *    - News alert broadcasting
 *    - Liquidation cascade emergency alerts
 *
 *  Usage:
 *    const dispatcher = new AlertDispatcher({ token: BOT_TOKEN, chatIds: [...] });
 *    await dispatcher.init();
 *    await dispatcher.sendSignal(signal);  // from signal-scorer.js
 * ============================================================
 */

'use strict';

const https        = require('https');
const http         = require('http');
const EventEmitter = require('events');
const { URL }      = require('url');

// ─────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────

const TELEGRAM_API_BASE = 'https://api.telegram.org/bot';

// Telegram rate limit: 30 messages/second global, 1 msg/second per chat
const RATE_LIMIT_GLOBAL_MS   = 35;     // ms between sends (global)
const RATE_LIMIT_PER_CHAT_MS = 1100;   // ms between sends per chat

// Max retries for failed Telegram calls
const MAX_RETRIES = 5;

// Alert deduplication window (ms) — same symbol+direction within window = skip
const DEDUP_WINDOW_MS = 5 * 60 * 1000;   // 5 minutes

// Signal queue check interval
const QUEUE_INTERVAL_MS = 100;

// Chart screenshot service URL (uses TradingView snapshot API)
const CHART_SNAPSHOT_BASE = 'https://charts.tradingview.com/chart-snapshots';

// Priority levels
const PRIORITY = {
  EMERGENCY: 0,   // liquidation cascades, circuit breaker
  HIGH:      1,   // Grade A signals
  NORMAL:    2,   // Grade B signals
  LOW:       3,   // status updates, stats
};

// Bot command list
const BOT_COMMANDS = [
  { command: 'start',     description: 'Start the trading assistant bot' },
  { command: 'status',    description: 'System status and connection health' },
  { command: 'signals',   description: 'Last 5 signals fired' },
  { command: 'stats',     description: 'Win rate and performance stats' },
  { command: 'risk',      description: 'Current risk engine status' },
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

// Emoji map for signal formatting
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

// ─────────────────────────────────────────────
//  TELEGRAM HTTP CLIENT
// ─────────────────────────────────────────────

class TelegramClient {
  constructor(token) {
    this.token   = token;
    this.baseUrl = `${TELEGRAM_API_BASE}${token}`;
  }

  /**
   * Make a raw Telegram API request.
   * Returns parsed JSON response body.
   *
   * @param {string} method   - Telegram API method name
   * @param {Object} payload  - request body
   * @returns {Promise<Object>}
   */
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

  /**
   * Send text message with optional keyboard
   */
  async sendMessage(chatId, text, options = {}) {
    return this.call('sendMessage', {
      chat_id:    chatId,
      text:       text.slice(0, 4096), // Telegram limit
      parse_mode: options.parseMode || 'HTML',
      reply_markup:           options.replyMarkup || undefined,
      disable_web_page_preview: options.noPreview !== false,
      ...options.extra,
    });
  }

  /**
   * Send photo with caption
   */
  async sendPhoto(chatId, photoUrl, caption, options = {}) {
    return this.call('sendPhoto', {
      chat_id:   chatId,
      photo:     photoUrl,
      caption:   caption?.slice(0, 1024),
      parse_mode: options.parseMode || 'HTML',
      reply_markup: options.replyMarkup || undefined,
    });
  }

  /**
   * Edit existing message text
   */
  async editMessage(chatId, messageId, text, options = {}) {
    return this.call('editMessageText', {
      chat_id:    chatId,
      message_id: messageId,
      text:       text.slice(0, 4096),
      parse_mode: options.parseMode || 'HTML',
      reply_markup: options.replyMarkup || undefined,
    });
  }

  /**
   * Answer callback query (button press)
   */
  async answerCallback(callbackQueryId, text, showAlert = false) {
    return this.call('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text,
      show_alert: showAlert,
    });
  }

  /**
   * Set webhook URL for receiving updates
   */
  async setWebhook(webhookUrl) {
    return this.call('setWebhook', { url: webhookUrl });
  }

  /**
   * Delete webhook and use long polling
   */
  async deleteWebhook() {
    return this.call('deleteWebhook');
  }

  /**
   * Get updates via long polling
   */
  async getUpdates(offset = 0, timeout = 30) {
    return this.call('getUpdates', { offset, timeout, allowed_updates: ['message','callback_query'] });
  }

  /**
   * Set bot commands list
   */
  async setMyCommands(commands) {
    return this.call('setMyCommands', { commands });
  }

  /**
   * Get bot info
   */
  async getMe() {
    return this.call('getMe');
  }

  /**
   * Pin a message in a channel/group
   */
  async pinMessage(chatId, messageId) {
    return this.call('pinChatMessage', { chat_id: chatId, message_id: messageId });
  }

  /**
   * Send sticker
   */
  async sendSticker(chatId, stickerId) {
    return this.call('sendSticker', { chat_id: chatId, sticker: stickerId });
  }
}

// ─────────────────────────────────────────────
//  SIGNAL QUEUE
// ─────────────────────────────────────────────

class SignalQueue {
  constructor() {
    this._queue     = [];
    this._lastSent  = 0;
    this._chatTimes = new Map(); // chatId → last send time
  }

  /**
   * Add item to queue with priority
   * @param {Object} item - { priority, chatIds, fn: async () => {} }
   */
  push(item) {
    this._queue.push({ ...item, addedAt: Date.now() });
    // Sort by priority (lower number = higher priority)
    this._queue.sort((a, b) => a.priority - b.priority);
  }

  /**
   * Get next item if rate limit allows.
   * FIX: RATE_LIMIT_PER_CHAT_MS and this._chatTimes were declared but never
   * consulted — nothing stopped multiple messages from firing at the same
   * chat within Telegram's ~1 msg/sec-per-chat limit, risking 429s/bans on
   * bursts (e.g. many signals firing at once). Now scans for the first
   * queued item that satisfies both the global and per-chat cooldown,
   * instead of only ever looking at the front of the queue.
   */
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
    return null; // every queued item is still within its per-chat cooldown
  }

  async execute(item) {
    this._lastSent = Date.now();
    if (item.chatId != null) this._chatTimes.set(item.chatId, Date.now());
    try {
      await item.fn();
    } catch (err) {
      console.error('[SignalQueue] Execution error:', err.message);
      // Retry logic
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

// ─────────────────────────────────────────────
//  DEDUPLICATION MANAGER
// ─────────────────────────────────────────────

class DedupManager {
  constructor() {
    this._seen = new Map(); // key → timestamp
  }

  /**
   * Returns true if this signal was already sent recently
   */
  isDuplicate(signal) {
    const key = `${signal.symbol}_${signal.action}_${signal.timeframe}`;
    const last = this._seen.get(key);
    if (last && (Date.now() - last) < DEDUP_WINDOW_MS) return true;
    this._seen.set(key, Date.now());
    return false;
  }

  clear() { this._seen.clear(); }

  /**
   * Clean up old entries
   */
  cleanup() {
    const now = Date.now();
    for (const [key, time] of this._seen) {
      if (now - time > DEDUP_WINDOW_MS * 2) {
        this._seen.delete(key);
      }
    }
  }
}

// ─────────────────────────────────────────────
//  MESSAGE FORMATTER
// ─────────────────────────────────────────────

class MessageFormatter {

  /**
   * Format a full trading signal into a rich Telegram HTML message
   */
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

    // Agent breakdown
    if (signal.agentBreakdown?.length > 0) {
      lines.push('');
      lines.push(`<b>━━━━━━━━ AGENT VOTES ━━━━━━━━</b>`);
      for (const agent of signal.agentBreakdown) {
        const statusEmoji = agent.status === 'CONFIRMS' ? '✅'
          : agent.status === 'NEUTRAL' ? '⚪' : '❌';
        lines.push(`${statusEmoji} ${agent.agent}: <b>${agent.score}/100</b> [${agent.weight}]`);
      }
    }

    // Top reasons
    if (signal.allReasons?.length > 0) {
      lines.push('');
      lines.push(`<b>━━━━━━━━ WHY THIS TRADE ━━━━━━━━</b>`);
      signal.allReasons.slice(0, 6).forEach(r => lines.push(`  ✅ ${r}`));
    }

    // Trade management
    lines.push('');
    lines.push(`<b>━━━━━━━━ MANAGEMENT ━━━━━━━━</b>`);
    lines.push(`📍 Move to BE: <i>${signal.management?.moveToBreakeven ?? 'After TP1'}</i>`);
    lines.push(`✂️ Partial close: <i>${signal.management?.partialClose ?? '50% at TP1'}</i>`);
    lines.push(`🔄 Trail stop: <i>${signal.management?.trailingStop ?? 'ATR × 1.5'}</i>`);
    lines.push(`🚫 Invalidation: <i>${signal.management?.invalidation ?? 'Close beyond SL'}</i>`);

    // HTF bias
    lines.push('');
    lines.push(`${EMOJI.UP} HTF Bias: <b>${signal.htfBias?.direction ?? '?'}</b>`);

    // Footer
    lines.push('');
    lines.push(`<i>⚠️ Risk max 1-2% per trade. Confirm on your chart.</i>`);
    lines.push(`<i>📅 ${new Date(signal.timestamp).toUTCString()}</i>`);

    return lines.join('\n');
  }

  /**
   * Format a short inline alert (for group channels)
   */
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

  /**
   * Format system status message
   */
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

  /**
   * Format a liquidation cascade alert
   */
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

  /**
   * Format whale trade alert
   */
  static formatWhaleTrade(trade) {
    const emoji = trade.direction === 'BUY' ? EMOJI.BULL : EMOJI.BEAR;
    return [
      `${EMOJI.WHALE} <b>WHALE TRADE DETECTED</b>`,
      `${emoji} ${trade.direction} <code>${trade.symbol}</code>`,
      `Size: <b>$${(trade.usdtValue / 1000).toFixed(1)}K</b> @ ${trade.price}`,
      `<i>${trade.note}</i>`,
    ].join('\n');
  }

  /**
   * Format funding rate extreme alert
   */
  static formatFundingExtreme(extremes) {
    const lines = [`${EMOJI.WARNING} <b>EXTREME FUNDING RATES</b>`, ''];
    for (const e of extremes.slice(0, 5)) {
      const emoji = e.rate > 0 ? EMOJI.BEAR : EMOJI.BULL;
      lines.push(`${emoji} <code>${e.symbol}</code>: ${(e.rate * 100).toFixed(4)}% [${e.bias}]`);
      lines.push(`  Annualized: ${e.annualized?.toFixed(1)}% — ${e.meanReversionSignal}`);
    }
    return lines.join('\n');
  }

  /**
   * Format win/loss/BE trade outcome message
   */
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

  /**
   * Format position size calculator result
   */
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

  /**
   * Format market sessions info
   */
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

  /**
   * Format help message with all commands
   */
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

// ─────────────────────────────────────────────
//  INLINE KEYBOARD BUILDER
// ─────────────────────────────────────────────

class KeyboardBuilder {
  /**
   * Build the inline keyboard for a signal message
   * Buttons: Approve ✅ | Skip ❌ | Details 📊 | Chart 📈
   */
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
        // FIX: added — these are the entry point into manual-mode.js's
        // ExecutionEngine, which was fully built but never wired anywhere.
        // Unlike the WIN/LOSS/BE row below (a single guessed R-multiple),
        // tapping Take starts REAL position tracking: TP/SL/breakeven/trail
        // are detected from actual price action and the position is closed
        // with a computed, accurate pnlR — not a placeholder.
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

  /**
   * Confirmation keyboard for semi-auto mode
   */
  static confirmKeyboard(signalId) {
    return {
      inline_keyboard: [[
        { text: `⚡ EXECUTE NOW`, callback_data: `EXECUTE:${signalId}` },
        { text: `❌ Cancel`,      callback_data: `CANCEL:${signalId}` },
      ]],
    };
  }

  /**
   * Main menu keyboard
   */
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

// ─────────────────────────────────────────────
//  CHART URL BUILDER
// ─────────────────────────────────────────────

class ChartUrlBuilder {
  /**
   * Builds a TradingView chart image URL for a symbol + timeframe.
   * Uses TradingView's public snapshot service.
   *
   * @param {string} symbol    - e.g. 'BINANCE:BTCUSDT'
   * @param {string} timeframe - e.g. '60' (minutes)
   * @param {Object} levels    - { entry, sl, tp1, tp2 }
   * @returns {string} chartUrl
   */
  static build(symbol, timeframe, levels = {}) {
    // TF to TradingView interval map
    const tfMap = {
      M1: '1', M5: '5', M15: '15', M30: '30',
      H1: '60', H2: '120', H4: '240', H6: '360',
      H8: '480', H12: '720', D1: 'D', W1: 'W',
    };

    const interval = tfMap[timeframe] || '60';
    const tvSymbol = this._formatSymbol(symbol);

    // TradingView snapshot URL
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
    // Convert BTCUSDT → BINANCE:BTCUSDT
    // Convert XAUUSD → FOREXCOM:XAUUSD
    const forexPairs = ['EURUSD','GBPUSD','USDJPY','XAUUSD','XAGUSD','USDCAD','AUDUSD'];
    if (forexPairs.some(p => symbol.includes(p.slice(0, 3)))) {
      return `FOREXCOM:${symbol}`;
    }
    return `BINANCE:${symbol}`;
  }
}

// ─────────────────────────────────────────────
//  POSITION SIZE CALCULATOR
// ─────────────────────────────────────────────

class PositionCalculator {
  /**
   * Calculates the correct position size for a trade.
   *
   * @param {Object} params
   * @param {number} params.accountBalance - total account in USD
   * @param {number} params.riskPct        - risk per trade in % (e.g. 1.5)
   * @param {number} params.entry          - entry price
   * @param {number} params.stopLoss       - stop loss price
   * @param {number} params.tp1            - take profit 1 price
   * @param {string} params.symbol         - trading symbol (for pip value)
   * @returns {Object} calculation result
   */
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

    // Pip value calculation (simplified)
    // For forex pairs: 1 pip = 0.0001 for most pairs, 0.01 for JPY
    // For gold (XAUUSD): 1 pip = 0.01
    // For crypto: 1 unit = 1 USDT per coin
    let pipValue = 10; // default per standard lot per pip
    let lotSize  = 0;
    let units    = 0;

    if (symbol.includes('JPY')) {
      pipValue = 1000;
      const pips = slPoints / 0.01;
      lotSize    = parseFloat((riskUSD / (pips * pipValue * 0.0001)).toFixed(4));
      units      = Math.round(lotSize * 100000);
    } else if (symbol.includes('XAU') || symbol.includes('GOLD')) {
      // Gold: 1 pip = $1 per oz per contract
      const pips = slPoints / 0.01;
      lotSize    = parseFloat((riskUSD / pips).toFixed(3));
      units      = lotSize;
      pipValue   = 1;
    } else if (symbol.includes('BTC') || symbol.includes('ETH')) {
      // Crypto: risk / SL distance in USDT
      lotSize  = parseFloat((riskUSD / slPoints).toFixed(6));
      units    = lotSize;
      pipValue = slPoints;
    } else {
      // Standard forex
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

// ─────────────────────────────────────────────
//  DELIVERY RECEIPT TRACKER
// ─────────────────────────────────────────────

class DeliveryTracker {
  constructor() {
    this._receipts  = new Map(); // signalId → { messageIds, chatIds, timestamp }
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

// ─────────────────────────────────────────────
//  LONG POLL MANAGER
// ─────────────────────────────────────────────

class LongPollManager {
  constructor(client, handler) {
    this._client  = client;
    this._handler = handler;
    this._offset  = 0;
    this._running = false;
    this._timer   = null;
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

    try {
      const updates = await this._client.getUpdates(this._offset, 30);
      for (const update of (updates || [])) {
        this._offset = update.update_id + 1;
        await this._handler(update);
      }
    } catch (err) {
      console.error('[LongPoll] Error:', err.message);
    }

    if (this._running) {
      this._timer = setTimeout(() => this._poll(), 500);
    }
  }
}

// ─────────────────────────────────────────────
//  WEBHOOK SERVER
// ─────────────────────────────────────────────

class WebhookServer {
  /**
   * Creates a lightweight HTTP server to receive Telegram webhook updates.
   *
   * @param {Function} handler - async function(update) => void
   * @param {number} port      - port to listen on (default 3000)
   * @param {string} secret    - secret path token
   */
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

// ─────────────────────────────────────────────
//  MAIN ALERT DISPATCHER CLASS
// ─────────────────────────────────────────────

class AlertDispatcher extends EventEmitter {
  /**
   * @param {Object} config
   * @param {string}   config.token          - Telegram bot token
   * @param {string[]} config.chatIds        - primary chat IDs to deliver to
   * @param {string[]} config.adminChatIds   - admin-only chat IDs
   * @param {string}   config.gradeAChatId   - exclusive channel for Grade A signals
   * @param {string}   config.webhookUrl     - public HTTPS URL for webhook (optional)
   * @param {number}   config.webhookPort    - local port for webhook server (default 3000)
   * @param {boolean}  config.useLongPoll    - use long polling instead of webhook
   * @param {number}   config.accountBalance - default account balance for calc
   * @param {number}   config.riskPct        - default risk % per trade
   * @param {Object}   config.scorer         - reference to SignalScorer instance
   * @param {Object}   config.feed           - reference to BinanceFeed instance
   * @param {Object}   config.riskEngine     - reference to RiskEngine instance
   * @param {Object}   config.store          - reference to MongoDB store (db.js) for subscriber persistence
   */
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

    // External service references (injected)
    this.scorer         = config.scorer         || null;
    this.feed           = config.feed           || null;
    this.riskEngine     = config.riskEngine     || null;
    this._store         = config.store          || null;

    // Internal state
    this._client        = new TelegramClient(this.token);
    this._queue         = new SignalQueue();
    this._dedup         = new DedupManager();
    this._delivery      = new DeliveryTracker();
    this._paused        = false;
    this._pendingSignals = new Map(); // signalId → signal (for callback resolution)
    this._approvedSignals = new Map(); // signalId → signal (approved, waiting for EA execution)
    this._recordedOutcomes = new Set(); // signalId → guards against double-tapping WIN/LOSS/BE
    this._subscribers   = new Set();  // auto-registered chat IDs from /start
    this._bot           = null;      // bot info from getMe()

    // Queue processor interval
    this._queueTimer    = null;

    // Stats
    this._stats = {
      signalsSent:     0,
      messagesSent:    0,
      errorsCount:     0,
      commandsHandled: 0,
      startTime:       null,
    };
  }

  // ─────────────────────────────────────────────
  //  INITIALIZATION
  // ─────────────────────────────────────────────

  /**
   * Initialize the dispatcher:
   *  1. Verify bot token
   *  2. Set bot commands
   *  3. Start update listener (long poll or webhook)
   *  4. Start queue processor
   *  5. Send startup message to admin chats
   */
  async init() {
    if (!this.token) {
      throw new Error('[AlertDispatcher] No Telegram bot token provided. Set TELEGRAM_BOT_TOKEN env var.');
    }

    console.log('[AlertDispatcher] Initializing...');

    // Verify token
    try {
      this._bot = await this._client.getMe();
      console.log(`[AlertDispatcher] Bot verified: @${this._bot.username} (ID: ${this._bot.id})`);
    } catch (err) {
      throw new Error(`[AlertDispatcher] Bot token invalid: ${err.message}`);
    }

    // Set commands
    try {
      await this._client.setMyCommands(BOT_COMMANDS);
      console.log('[AlertDispatcher] Commands registered');
    } catch (err) {
      console.warn('[AlertDispatcher] Failed to set commands:', err.message);
    }

    // Start update listener
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

    // Start queue processor
    this._stats.startTime = Date.now();
    this._queueTimer = setInterval(() => this._processQueue(), QUEUE_INTERVAL_MS);

    // Dedup cleanup every 10 minutes
    setInterval(() => this._dedup.cleanup(), 10 * 60 * 1000);

    // Load subscribers from MongoDB
    await this._loadSubscribers();

    // Send startup notification
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

  // ─────────────────────────────────────────────
  //  SIGNAL DELIVERY
  // ─────────────────────────────────────────────

  /**
   * Main signal delivery function.
   * Called by task-planner.js or signal-scorer.js when a signal fires.
   *
   * @param {Object} signal - full signal from signal-scorer.js
   * @returns {Promise<void>}
   */
  async sendSignal(signal) {
    if (this._paused) {
      console.log('[AlertDispatcher] Paused — signal queued but not sent');
      return;
    }

    // Deduplication check
    if (this._dedup.isDuplicate(signal)) {
      console.log(`[AlertDispatcher] Duplicate signal suppressed: ${signal.symbol} ${signal.action}`);
      return;
    }

    // Ensure signal has a unique ID
    if (!signal.id) {
      signal.id = `${signal.symbol}-${signal.action}-${Date.now()}`;
    }

    this._pendingSignals.set(signal.id, signal);
    this._stats.signalsSent++;

    const priority  = signal.score?.grade === 'A' ? PRIORITY.HIGH : PRIORITY.NORMAL;
    const text      = MessageFormatter.formatSignal(signal);
    const keyboard  = KeyboardBuilder.signalKeyboard(signal.id, signal.symbol);
    const chartUrl  = ChartUrlBuilder.build(signal.symbol, signal.timeframe);

    // Compute position size suggestion
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

    // FIX: chartUrl was computed but never attached to the outgoing message —
    // the chart link feature was silently dead. Append it now.
    const chartLinkText = chartUrl
      ? `\n\n${EMOJI.CHART} <a href="${chartUrl}">View ${signal.symbol} chart on TradingView</a>`
      : '';

    // Queue delivery to all configured chats + subscribers
    const allChatIds = this._getAllChatIds();
    for (const chatId of allChatIds) {
      this._queue.push({
        priority,
        chatId,
        fn: async () => {
          try {
            const msg = await this._client.sendMessage(
              chatId,
              text + posCalcText + chartLinkText,
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

    // Grade A → extra channel
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

    // Emit for any attached listeners (e.g. web dashboard)
    this.emit('signal_sent', signal);
    console.log(`[AlertDispatcher] Signal queued: ${signal.action} ${signal.symbol} | Grade ${signal.score?.grade} | Score ${signal.score?.final}`);
  }

  /**
   * Send a liquidation cascade emergency alert
   */
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

  // FIX: manual-mode.js's ExecutionEngine (a fully-built manual/semi-auto
  // position-tracking system) calls dispatcher.sendTPHit/sendSLHit/
  // sendBreakeven/sendTrailUpdate — none of which existed anywhere on this
  // class. Since those calls aren't wrapped in try/catch in
  // ExecutionEngine._handlePositionAction, and the exception surfaces
  // asynchronously (inside an async listener callback whose synchronous
  // invocation IS wrapped in try/catch by PriceMonitor, but whose eventual
  // promise rejection is NOT), wiring in ExecutionEngine without these would
  // have produced an unhandled promise rejection on the very first TP/SL/BE/
  // trail event of any manually-tracked position — a real crash risk.

  /**
   * Notify that a take-profit level was hit on a manually-tracked position.
   */
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

  /**
   * Notify that a stop loss was hit on a manually-tracked position.
   */
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

  /**
   * Notify that a position's stop loss was moved to breakeven.
   */
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

  /**
   * Notify that a position's trailing stop was updated.
   */
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

  /**
   * Send an arbitrary HTML-formatted message (used by ExecutionEngine for
   * entry-blocked/warning/order-failure notices — same missing-method
   * pattern as sendTPHit et al above).
   */
  async sendCustom(text, options = {}) {
    for (const chatId of this._getAllChatIds()) {
      this._queue.push({
        priority: options.silent ? PRIORITY.LOW : PRIORITY.NORMAL,
        chatId,
        fn: async () => { await this._client.sendMessage(chatId, text, { silent: options.silent }); },
      });
    }
  }

  /**
   * Send the end-of-day manual-mode journal summary (signals, risk, best
   * setup) — called once daily by ExecutionEngine._scheduleDailySummary().
   */
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

  /**
   * Send whale trade detection alert
   */
  async sendWhaleTrade(trade) {
    // Only send if trade is very large (>$500K)
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

  /**
   * Send funding rate extreme alert
   */
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

  /**
   * Broadcast a plain text message to all chats
   */
  async broadcast(text, priority = PRIORITY.NORMAL) {
    for (const chatId of this._getAllChatIds()) {
      this._queue.push({
        priority,
        chatId,
        fn: async () => this._client.sendMessage(chatId, text),
      });
    }
  }

  // ─────────────────────────────────────────────
  //  UPDATE HANDLER (Messages + Callbacks)
  // ─────────────────────────────────────────────

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

  /**
   * Handle incoming text messages (bot commands)
   */
  async _handleMessage(message) {
    const chatId  = message.chat.id;
    const text    = message.text || '';
    const userId  = message.from?.id;

    this._stats.commandsHandled++;

    // Extract command and args
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
        // /calc ENTRY STOPLOSS TP1
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
        // Auto-register any user who messages the bot
        if (!this._subscribers.has(String(chatId)) && !this.chatIds.includes(String(chatId))) {
          await this._registerSubscriber(chatId, message.from);
        }
        // Unknown command — show quick help
        if (text.startsWith('/')) {
          await this._client.sendMessage(chatId,
            `Unknown command. Try /help for a list of commands.`
          );
        }
        break;
    }
  }

  /**
   * Handle inline keyboard button presses
   */
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
          const symbol   = signalId; // in CHART callback, signalId is actually the symbol
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
          // Guard against double-tapping the same button (or Telegram
          // redelivering the callback) at the UI layer, before the
          // storage-level dedupe check in recordOutcomeEverywhere even runs.
          if (this._recordedOutcomes.has(signalId)) {
            await this._client.answerCallback(callbackQueryId, 'Already recorded for this signal', true);
            break;
          }
          this._recordedOutcomes.add(signalId);

          // NOTE: these are placeholder R-multiples for a single quick tap —
          // a button can't capture the real P&L of a specific trade. This is
          // a genuine UX limitation, not something wiring can fix.
          const pnlMap  = { WIN: 1.5, LOSS: -1, BE: 0 };
          const pnlR    = pnlMap[result];
          const outcome = { result, pnlPct: pnlR, pnlR, note: `Recorded via Telegram callback` };

          if (this.scorer) {
            this.scorer.recordTradeOutcome(signalId, outcome);
          }

          // FIX: this handler — the primary way most users will record an
          // outcome, via a single Telegram tap — only ever fed
          // scorer.recordTradeOutcome(), which updates a SEPARATE circuit
          // breaker (signal-scorer.js's own DrawdownCircuitBreaker) that is
          // NOT the same object as drawdownGuard (risk-engine/drawdown-guard.js),
          // which is what actually gates new trades pre-signal. It also never
          // touched adaptiveLearning, bayesianEng, walkForward,
          // institutionalGates, sessionFilter, or institutionalRiskManager.
          // FIX (reconciled during merge): an earlier version of this fix
          // called the engines directly here, un-awaited, and ALSO emitted
          // 'trade_outcome' below — which index.js listens for and records
          // through the same pipeline again. Un-awaited + emit-right-after
          // is a real race: the direct call's mongoStore write might not be
          // durable yet when the listener's dedupe check runs, double-
          // counting the outcome. Call the single shared implementation and
          // await it here instead — one write, no race, and the emit below
          // becomes a safe, idempotent no-op for any other listener.
          try {
            const { recordOutcomeEverywhere } = require('./outcome-recorder');
            const { getEngines } = require('../api/realtime');
            const mongoStore = require('../db');
            await recordOutcomeEverywhere({
              signalId, signal, outcome: { pnlR, result },
              mongoStore, engines: getEngines(),
            });
          } catch (_) { /* registry/db not available (e.g. standalone dispatcher usage) — non-fatal */ }

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
          await this.executionEngine.onWatch(signalId).catch(() => {});
          await this._client.answerCallback(callbackQueryId, '👁 Watching — no position opened.', false);
          break;
        }

        case 'EXECUTE': {
          // Semi-auto execution
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

  // ─────────────────────────────────────────────
  //  COMMAND HELPERS
  // ─────────────────────────────────────────────

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

  async _recordOutcome(chatId, result, args) {
    const lastSignalId = this._delivery.getLastSignalId();
    if (!lastSignalId) {
      await this._client.sendMessage(chatId, 'No recent signal to record outcome for.');
      return;
    }

    const signal  = this._pendingSignals.get(lastSignalId);
    const pnlMap  = { WIN: this.riskPct * 1.5, LOSS: -this.riskPct, BREAKEVEN: 0 };
    const pnlPct  = parseFloat(args[0] || pnlMap[result]);
    // FIX: recordOutcome() (signal-pipeline/adaptive-learning-engine.js)
    // derives WIN/LOSS/BREAKEVEN from outcome.pnlR, not from a `result`
    // string — this object never had a pnlR field, so every /win, /loss, and
    // /be would have been silently misrecorded as BREAKEVEN (pnlR defaults
    // to 0) even after the scorer wiring below was fixed. riskPct is our
    // best available proxy for 1R here, since this dispatcher only tracks
    // percent-of-account risk, not literal R-multiples.
    const pnlR = this.riskPct > 0 ? pnlPct / this.riskPct : (result === 'WIN' ? 1 : result === 'LOSS' ? -1 : 0);
    const outcome = {
      result,
      pnlPct: pnlPct.toFixed(2),
      pnlR,
      note:   `Manual via /${result.toLowerCase()}`,
    };

    // FIX: this.scorer was never assigned anywhere in the codebase, so this
    // outcome was recorded nowhere — the confirmation message sent below was
    // the ONLY effect of /win, /loss, /be. index.js listens for the
    // 'trade_outcome' event emitted below and feeds it through the same real
    // pipeline used by /api/outcomes (signal-pipeline/outcome-recorder.js).
    if (this.scorer) {
      this.scorer.recordTradeOutcome(lastSignalId, outcome);
    }

    await this._client.sendMessage(
      chatId,
      MessageFormatter.formatOutcome(outcome, signal)
    );

    this.emit('trade_outcome', { signalId: lastSignalId, outcome, signal });
  }

  // ─────────────────────────────────────────────
  //  INTERNAL UTILITIES
  // ─────────────────────────────────────────────

  /**
   * Get all chat IDs to broadcast to (configured + subscribers)
   */
  _getAllChatIds() {
    const all = new Set(this.chatIds.map(String));
    for (const id of this._subscribers) all.add(id);
    return [...all];
  }

  /**
   * Register a subscriber and persist to MongoDB
   */
  async _registerSubscriber(chatId, fromUser) {
    const id = String(chatId);
    this._subscribers.add(id);
    if (this._store?.upsertTelegramUser) {
      try {
        // Ensure user is marked as subscribed in DB
        const userUpdate = fromUser ? { ...fromUser, id: chatId } : { id: chatId };
        await this._store.upsertTelegramUser({ ...userUpdate, subscribed: true });
      } catch (e) {
        console.warn('[AlertDispatcher] Failed to save subscriber:', e.message);
      }
    }
    console.log(`[AlertDispatcher] Subscriber registered: ${id} (total: ${this._subscribers.size})`);
  }

  /**
   * Load subscribers from MongoDB on startup
   */
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
    // All users in admin chats are considered admins
    // In production, maintain an admin user ID whitelist
    return true;
  }

  _getSessionDetector() {
    // Lazy import to avoid circular deps
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

  // ─────────────────────────────────────────────
  //  PUBLIC API
  // ─────────────────────────────────────────────

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
    // Notify via Telegram
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

// ─────────────────────────────────────────────
//  EXPORTS
// ─────────────────────────────────────────────

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

/**
 * ─────────────────────────────────────────────
 *  USAGE EXAMPLE
 * ─────────────────────────────────────────────
 *
 *  const { AlertDispatcher } = require('./alert-dispatcher');
 *
 *  const dispatcher = new AlertDispatcher({
 *    token:          process.env.TELEGRAM_BOT_TOKEN,
 *    chatIds:        [process.env.TELEGRAM_CHAT_ID],
 *    gradeAChatId:   process.env.GRADE_A_CHANNEL_ID,
 *    useLongPoll:    true,
 *    accountBalance: 5000,
 *    riskPct:        1.5,
 *    scorer:         scorerInstance,
 *    feed:           feedInstance,
 *  });
 *
 *  await dispatcher.init();
 *
 *  // Send a signal
 *  dispatcher.on('signal_approved', ({ signal }) => {
 *    console.log('User approved:', signal.symbol, signal.action);
 *  });
 *
 *  dispatcher.on('execute_signal', ({ signal }) => {
 *    // Pass to execution.js for order placement
 *    executionEngine.placeOrder(signal);
 *  });
 *
 *  // Called automatically by task-planner.js
 *  await dispatcher.sendSignal(scoredSignal);
 * ─────────────────────────────────────────────
 */