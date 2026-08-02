'use strict';
/**
 * Simple email OTP auth:
 *  1) POST /api/auth/email/request  { email }  -> 6-digit code emailed
 *  2) POST /api/auth/email/verify   { email, code } -> session token
 * No password to remember. Code expires in 10 minutes.
 */
const crypto = require('crypto');

const CODE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_ATTEMPTS = 5;

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function hashCode(email, code) {
  const pepper = process.env.OTP_PEPPER || process.env.EA_SECRET || 'omnicee-otp';
  return crypto.createHash('sha256').update(`${email}:${code}:${pepper}`).digest('hex');
}

function randomCode() {
  return String(crypto.randomInt(100000, 999999));
}

function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

async function sendEmail({ to, subject, text }) {
  const resendKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM || 'OMNICEE <onboarding@resend.dev>';

  if (resendKey) {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to: [to], subject, text }),
    });
    if (!r.ok) {
      const body = await r.text();
      throw new Error(`Resend ${r.status}: ${body.slice(0, 200)}`);
    }
    return { provider: 'resend' };
  }

  // Optional nodemailer SMTP
  let nodemailer;
  try { nodemailer = require('nodemailer'); } catch (_) { nodemailer = null; }
  const host = process.env.SMTP_HOST;
  if (nodemailer && host) {
    const transporter = nodemailer.createTransport({
      host,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
    });
    await transporter.sendMail({
      from: process.env.EMAIL_FROM || process.env.SMTP_USER,
      to,
      subject,
      text,
    });
    return { provider: 'smtp' };
  }

  if (process.env.ALLOW_DEV_OTP === 'true') {
    console.log(`[AUTH DEV OTP] ${to} => code in response (ALLOW_DEV_OTP)`);
    return { provider: 'dev' };
  }

  throw new Error('Email not configured. Set RESEND_API_KEY or SMTP_HOST (+ SMTP_USER/SMTP_PASS).');
}

function createEmailAuthRouter(express, db) {
  const router = express.Router();

  // rate-ish: simple in-memory per email
  const lastRequest = new Map();

  router.post('/request', async (req, res) => {
    try {
      const email = normalizeEmail(req.body?.email);
      if (!isValidEmail(email)) {
        return res.status(400).json({ ok: false, error: 'Enter a valid email address' });
      }

      const now = Date.now();
      const prev = lastRequest.get(email) || 0;
      if (now - prev < 30000) {
        return res.status(429).json({ ok: false, error: 'Wait 30 seconds before requesting another code' });
      }
      lastRequest.set(email, now);

      const code = randomCode();
      const codeHash = hashCode(email, code);
      const expiresAt = new Date(now + CODE_TTL_MS);

      if (db?.getDB) {
        const mongo = await db.getDB();
        await mongo.collection('email_otps').updateOne(
          { email },
          {
            $set: {
              email,
              codeHash,
              attempts: 0,
              expiresAt,
              createdAt: new Date(now),
            },
          },
          { upsert: true }
        );
        await mongo.collection('users').updateOne(
          { email },
          {
            $set: { email, lastSeenAt: new Date(now), authProvider: 'email' },
            $setOnInsert: { createdAt: new Date(now), telegramId: 'email:' + email },
          },
          { upsert: true }
        );
      }

      const sendResult = await sendEmail({
        to: email,
        subject: 'Your OMNICEE login code',
        text:
          `Your OMNICEE login code is: ${code}\n\n` +
          `It expires in 10 minutes.\n` +
          `If you did not request this, ignore this email.\n`,
      });

      const payload = {
        ok: true,
        message: 'Code sent. Check your email inbox (and spam).',
        expiresInSec: Math.floor(CODE_TTL_MS / 1000),
      };
      if (sendResult.provider === 'dev') payload.devCode = code;
      res.json(payload);
    } catch (err) {
      console.warn('[AUTH] request failed:', err.message);
      res.status(500).json({ ok: false, error: err.message || 'Could not send code' });
    }
  });

  router.post('/verify', async (req, res) => {
    try {
      const email = normalizeEmail(req.body?.email);
      const code = String(req.body?.code || '').trim();
      if (!isValidEmail(email) || !/^\d{6}$/.test(code)) {
        return res.status(400).json({ ok: false, error: 'Email and 6-digit code required' });
      }
      if (!db?.getDB) {
        return res.status(503).json({ ok: false, error: 'Database unavailable' });
      }

      const mongo = await db.getDB();
      const row = await mongo.collection('email_otps').findOne({ email });
      if (!row) {
        return res.status(401).json({ ok: false, error: 'No code requested for this email' });
      }
      if (row.expiresAt && new Date(row.expiresAt).getTime() < Date.now()) {
        return res.status(401).json({ ok: false, error: 'Code expired. Request a new one.' });
      }
      if ((row.attempts || 0) >= MAX_ATTEMPTS) {
        return res.status(401).json({ ok: false, error: 'Too many attempts. Request a new code.' });
      }

      const ok = row.codeHash === hashCode(email, code);
      if (!ok) {
        await mongo.collection('email_otps').updateOne({ email }, { $inc: { attempts: 1 } });
        return res.status(401).json({ ok: false, error: 'Wrong code' });
      }

      await mongo.collection('email_otps').deleteOne({ email });

      const token = randomToken();
      const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
      await mongo.collection('sessions').insertOne({
        token,
        email,
        createdAt: new Date(),
        expiresAt,
      });
      await mongo.collection('users').updateOne(
        { email },
        {
          $set: { email, lastSeenAt: new Date(), lastLoginAt: new Date(), authProvider: 'email' },
          $setOnInsert: { createdAt: new Date(), telegramId: 'email:' + email },
        },
        { upsert: true }
      );

      res.json({
        ok: true,
        token,
        email,
        expiresAt: expiresAt.toISOString(),
      });
    } catch (err) {
      console.warn('[AUTH] verify failed:', err.message);
      res.status(500).json({ ok: false, error: err.message || 'Verify failed' });
    }
  });

  router.get('/me', async (req, res) => {
    const session = req.emailSession;
    if (!session) return res.status(401).json({ ok: false, error: 'Not logged in' });
    res.json({ ok: true, email: session.email });
  });

  router.post('/logout', async (req, res) => {
    try {
      const token = extractToken(req);
      if (token && db?.getDB) {
        const mongo = await db.getDB();
        await mongo.collection('sessions').deleteOne({ token });
      }
      res.json({ ok: true });
    } catch (_) {
      res.json({ ok: true });
    }
  });

  return router;
}

function extractToken(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  return (req.headers['x-session-token'] || req.query?.token || '').trim() || null;
}

function emailSessionMiddleware(db) {
  return async function emailSession(req, res, next) {
    req.emailSession = null;
    const token = extractToken(req);
    if (!token || !db?.getDB) return next();
    try {
      const mongo = await db.getDB();
      const session = await mongo.collection('sessions').findOne({ token });
      if (session && (!session.expiresAt || new Date(session.expiresAt).getTime() > Date.now())) {
        req.emailSession = { email: session.email, token };
      }
    } catch (_) { /* ignore */ }
    next();
  };
}

function requireEmailAuth(req, res, next) {
  const enabled = process.env.EMAIL_AUTH_REQUIRED !== 'false';
  if (!enabled) return next();
  // Allow EA routes and health without login
  const p = req.path || '';
  if (p.startsWith('/api/ea') || p === '/health' || p.startsWith('/api/auth/email')) return next();
  if (req.emailSession) return next();
  // legacy app token still ok for automation
  const appTok = process.env.APP_ACCESS_TOKEN || '';
  if (appTok && (req.headers['x-app-token'] === appTok)) return next();
  return res.status(401).json({ ok: false, error: 'Login required', code: 'AUTH_REQUIRED' });
}

async function ensureAuthIndexes(db) {
  if (!db?.getDB) return;
  try {
    const mongo = await db.getDB();
    await mongo.collection('email_otps').createIndex({ email: 1 }, { unique: true });
    await mongo.collection('email_otps').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await mongo.collection('sessions').createIndex({ token: 1 }, { unique: true });
    await mongo.collection('sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await mongo.collection('users').createIndex({ email: 1 }, { unique: true, sparse: true });
  } catch (err) {
    console.warn('[AUTH] index warning:', err.message);
  }
}

module.exports = {
  createEmailAuthRouter,
  emailSessionMiddleware,
  requireEmailAuth,
  ensureAuthIndexes,
  extractToken,
};
