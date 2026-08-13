'use strict';

const crypto = require('crypto');

function validateAppToken(token) {
  const expected = String(process.env.APP_ACCESS_TOKEN || '').trim();
  if (!expected) return { ok: false, reason: 'App token auth not configured' };
  if (!token) return { ok: false, reason: 'Missing app token' };
  try {
    const left = Buffer.from(String(token).trim());
    const right = Buffer.from(expected);
    const valid = left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
    return valid
      ? { ok: true, user: { id: 'app-token', username: 'app-token-user' } }
      : { ok: false, reason: 'Invalid app token' };
  } catch (_) {
    return { ok: false, reason: 'App token validation error' };
  }
}

function webAuthMiddleware(req, res, next) {
  if (req.emailSession?.email) {
    req.webUser = { id: req.emailSession.email, username: req.emailSession.email };
    req.authMethod = 'email';
    return next();
  }
  const appToken = req.header('x-app-token');
  if (appToken) {
    const result = validateAppToken(appToken);
    if (result.ok) {
      req.webUser = result.user;
      req.authMethod = 'app-token';
      return next();
    }
    return res.status(401).json({ ok: false, error: result.reason });
  }
  if (process.env.NODE_ENV !== 'production' && process.env.ALLOW_DEV_WEB_AUTH === 'true') {
    req.webUser = { id: 'dev', username: 'local-dev' };
    req.authMethod = 'dev';
    return next();
  }
  return res.status(401).json({ ok: false, error: 'Login required', code: 'AUTH_REQUIRED' });
}

module.exports = { validateAppToken, webAuthMiddleware };
