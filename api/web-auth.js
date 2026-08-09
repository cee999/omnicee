'use strict';

const crypto = require('crypto');

function validateAppToken(token) {
  const expected = String(process.env.APP_ACCESS_TOKEN || '').trim();
  if (!expected) return { ok: false, reason: 'App token auth not configured' };
  if (!token) return { ok: false, reason: 'Missing app token' };
  try {
    const a = Buffer.from(String(token).trim());
    const b = Buffer.from(expected);
    const valid = a.length === b.length && crypto.timingSafeEqual(a, b);
    return valid
      ? { ok: true, user: { id: 'app-token', username: 'app-token-user' } }
      : { ok: false, reason: 'Invalid app token' };
  } catch (_) {
    return { ok: false, reason: 'App token validation error' };
  }
}

function appTokenMiddleware(req, res, next) {
  const token = req.header('x-app-token');
  const validation = validateAppToken(token);
  if (validation.ok) {
    req.user = validation.user;
    req.authMethod = 'app-token';
    return next();
  }
  if (req.emailSession?.email) {
    req.user = { id: req.emailSession.email, username: req.emailSession.email };
    req.authMethod = 'email';
    return next();
  }
  if (process.env.NODE_ENV !== 'production' && process.env.EMAIL_AUTH_REQUIRED !== 'true') {
    req.user = { id: 'dev', username: 'local-dev' };
    req.authMethod = 'dev';
    return next();
  }
  return res.status(401).json({ ok: false, error: validation.reason || 'Authentication required' });
}

module.exports = { validateAppToken, appTokenMiddleware };
