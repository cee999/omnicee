'use strict';

const crypto = require('crypto');
const db = require('../db');

function parseInitData(initData) {
  const params = new URLSearchParams(initData || '');
  const hash = params.get('hash');
  params.delete('hash');
  const pairs = [];
  for (const [key, value] of params.entries()) pairs.push(`${key}=${value}`);
  pairs.sort();
  return { hash, dataCheckString: pairs.join('\n'), params };
}

function validateTelegramInitData(initData, botToken, maxAgeSeconds = 86400) {
  if (!initData || !botToken) {
    return { ok: false, reason: 'Missing Telegram initData or bot token' };
  }

  try {
    const { hash, dataCheckString, params } = parseInitData(initData);
    if (!hash) return { ok: false, reason: 'Missing Telegram hash' };

    const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const computed = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
    
    // FIX: Wrap timingSafeEqual in try-catch to prevent crash on buffer mismatch
    let validHash = false;
    try {
      const computedBuf = Buffer.from(computed);
      const hashBuf = Buffer.from(hash);
      // Ensure buffers are same length before comparing
      if (computedBuf.length !== hashBuf.length) {
        validHash = false;
      } else {
        validHash = crypto.timingSafeEqual(computedBuf, hashBuf);
      }
    } catch (err) {
      console.warn('[Telegram Auth] Hash comparison error:', err.message);
      return { ok: false, reason: 'Hash validation error' };
    }
    
    if (!validHash) return { ok: false, reason: 'Invalid Telegram hash' };

    const authDate = Number(params.get('auth_date') || 0);
    if (authDate && maxAgeSeconds > 0) {
      const ageSeconds = Math.floor(Date.now() / 1000) - authDate;
      if (ageSeconds > maxAgeSeconds) return { ok: false, reason: 'Telegram auth expired' };
    }

    let user = null;
    try {
      const userStr = params.get('user');
      user = userStr ? JSON.parse(userStr) : null;
      // FIX: Validate parsed user object has required fields
      if (user && typeof user === 'object' && !user.id) {
        console.warn('[Telegram Auth] Parsed user missing id field');
        user = null;
      }
    } catch (err) {
      console.warn('[Telegram Auth] User JSON parse error:', err.message);
      user = null;
    }

    return { 
      ok: true, 
      user: user || null, 
      authDate, 
      params: Object.fromEntries(params.entries()) 
    };
  } catch (err) {
    console.error('[Telegram Auth] Validation error:', err.message);
    return { ok: false, reason: 'Authentication validation failed' };
  }
}

function allowedTelegramUser(user) {
  const allowed = (process.env.TELEGRAM_ALLOWED_USER_IDS || process.env.TELEGRAM_CHAT_IDS || '')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);
  if (!allowed.length) return true;
  // FIX: Add null check on user object
  return user && user.id && allowed.includes(String(user.id));
}

// App-token auth: a simple shared-secret alternative to Telegram initData,
// for accessing the Mini App outside Telegram (plain browser, testing,
// sharing with someone who doesn't have the bot). Deliberately separate
// from Telegram auth rather than a replacement for it — telegramAuthMiddleware
// tries this first and only falls through to Telegram validation if it's
// absent or doesn't match, so existing Telegram sessions are unaffected.
function validateAppToken(token) {
  const appToken = process.env.APP_ACCESS_TOKEN || '';
  if (!appToken) return { ok: false, reason: 'App token auth not configured' };
  if (!token) return { ok: false, reason: 'Missing app token' };

  try {
    const tokenBuf = Buffer.from(String(token));
    const appTokenBuf = Buffer.from(appToken);
    // Constant-time compare requires equal-length buffers; unequal length
    // is itself a safe, immediate reject (mirrors the Telegram hash check
    // just above).
    const valid = tokenBuf.length === appTokenBuf.length
      && crypto.timingSafeEqual(tokenBuf, appTokenBuf);
    if (!valid) return { ok: false, reason: 'Invalid app token' };
    return { ok: true, user: { id: 'app-token', username: 'app-token-user' } };
  } catch (err) {
    console.warn('[App Token Auth] Validation error:', err.message);
    return { ok: false, reason: 'App token validation error' };
  }
}

async function telegramAuthMiddleware(req, res, next) {
  // App-token path first: if the caller sent a valid x-app-token, accept it
  // and skip Telegram validation entirely. If APP_ACCESS_TOKEN isn't
  // configured, or the header's absent, or it doesn't match, this is a
  // no-op fall-through — Telegram auth behaves exactly as before.
  const appToken = req.header('x-app-token');
  if (appToken) {
    const appValidation = validateAppToken(appToken);
    if (appValidation.ok) {
      req.telegramUser = appValidation.user;
      req.authMethod = 'app-token';
      return next();
    }
    // Wrong/expired app token: don't silently fall through to Telegram
    // auth (that would mask a typo'd token as a confusing Telegram error).
    // Only reject outright if no Telegram initData was also provided.
    if (!req.header('x-telegram-init-data') && !req.body?.initData && !req.query?.initData) {
      return res.status(401).json({ ok: false, error: appValidation.reason });
    }
  }

  const initData = req.header('x-telegram-init-data') || req.body?.initData || req.query?.initData;
  const botToken = process.env.TELEGRAM_BOT_TOKEN;

  if (!initData && process.env.NODE_ENV !== 'production') {
    req.telegramUser = { id: 'dev', username: 'local-dev' };
    return next();
  }

  const validation = validateTelegramInitData(initData, botToken);
  if (!validation.ok) return res.status(401).json({ ok: false, error: validation.reason });
  if (!allowedTelegramUser(validation.user)) return res.status(403).json({ ok: false, error: 'Telegram user not allowed' });

  req.telegramUser = validation.user;
  req.authMethod = 'telegram';
  try { 
    if (validation.user) {
      await db.upsertTelegramUser(validation.user);
    }
  } catch (err) {
    console.warn('[Telegram Auth] User upsert failed:', err.message);
  }
  return next();
}

module.exports = {
  parseInitData,
  validateTelegramInitData,
  telegramAuthMiddleware,
  allowedTelegramUser,
  validateAppToken,
};
