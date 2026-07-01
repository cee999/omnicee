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

  const { hash, dataCheckString, params } = parseInitData(initData);
  if (!hash) return { ok: false, reason: 'Missing Telegram hash' };

  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computed = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  const validHash = crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(hash));
  if (!validHash) return { ok: false, reason: 'Invalid Telegram hash' };

  const authDate = Number(params.get('auth_date') || 0);
  if (authDate && maxAgeSeconds > 0) {
    const ageSeconds = Math.floor(Date.now() / 1000) - authDate;
    if (ageSeconds > maxAgeSeconds) return { ok: false, reason: 'Telegram auth expired' };
  }

  let user = null;
  try {
    user = JSON.parse(params.get('user') || 'null');
  } catch (_) {
    user = null;
  }

  return { ok: true, user, authDate, params: Object.fromEntries(params.entries()) };
}

function allowedTelegramUser(user) {
  const allowed = (process.env.TELEGRAM_ALLOWED_USER_IDS || process.env.TELEGRAM_CHAT_IDS || '')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);
  if (!allowed.length) return true;
  return user?.id && allowed.includes(String(user.id));
}

async function telegramAuthMiddleware(req, res, next) {
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
  try { await db.upsertTelegramUser(validation.user); } catch (_) {}
  return next();
}

module.exports = {
  parseInitData,
  validateTelegramInitData,
  telegramAuthMiddleware,
  allowedTelegramUser,
};
