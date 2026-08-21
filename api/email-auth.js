'use strict';
const crypto = require('crypto');

const CODE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 5;

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function getOtpPepper() {
  const pepper = String(
    process.env.OTP_PEPPER
    || process.env.EA_SECRET
    || process.env.APP_ACCESS_TOKEN
    || ''
  ).trim();
  if (pepper) return pepper;
  if (process.env.NODE_ENV === 'production') {
    console.warn('[AUTH] OTP_PEPPER/EA_SECRET unset — using ephemeral process pepper (set OTP_PEPPER on Render)');
    if (!global.__omniceeOtpPepper) {
      global.__omniceeOtpPepper = crypto.randomBytes(16).toString('hex');
    }
    return global.__omniceeOtpPepper;
  }
  return 'omnicee-local-dev-otp';
}

function hashCode(email, code) {
  const pepper = getOtpPepper();
  return crypto.createHash('sha256').update(`${email}:${code}:${pepper}`).digest('hex');
}

function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

function randomCode() {
  return String(crypto.randomInt(100000, 999999));
}

function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

function isValidFromAddress(from) {
  const s = String(from || '').trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) || /^[^<>]+<[^\s@]+@[^\s@]+\.[^\s@]+>$/.test(s);
}

// "Name <email@domain>" or a bare email -> { name, email } (Brevo/nodemailer want these split).
function parseFromAddress(from) {
  const s = String(from || '').trim();
  const m = s.match(/^([^<>]*)<([^\s@<>]+@[^\s@<>]+)>$/);
  if (m) return { name: m[1].trim().replace(/^["']|["']$/g, '') || 'OMNICEE', email: m[2].trim() };
  return { name: 'OMNICEE', email: s };
}

async function sendViaResend({ to, subject, text, from }) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return null;
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
    // Resend free tier only delivers to the account-owner email until a
    // custom domain is verified — main cause of "second Gmail fails".
    if (r.status === 403 || /only send testing|not authorized|domain/i.test(body)) {
      throw new Error(
        'Resend free tier only delivers to the account-owner email until a domain is verified.'
      );
    }
    throw new Error(`Resend ${r.status}: ${body.slice(0, 200)}`);
  }
  return { provider: 'resend' };
}

// Brevo (brevo.com) free tier: 300 emails/day, sends to ANY recipient once your
// sender address is verified in the dashboard (a one-click email link — no DNS,
// no custom domain needed). This is the real alternative to Resend's free-tier
// "only your own inbox" restriction.
async function sendViaBrevo({ to, subject, text, fromParsed }) {
  const brevoKey = process.env.BREVO_API_KEY;
  if (!brevoKey) return null;
  const r = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': brevoKey,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      sender: { name: fromParsed.name, email: fromParsed.email },
      to: [{ email: to }],
      subject,
      textContent: text,
    }),
  });
  if (!r.ok) {
    const body = await r.text();
    if (/sender.*not.*valid|not authorized|unrecognised sender/i.test(body)) {
      throw new Error(
        `Brevo rejected sender "${fromParsed.email}" — verify it under Senders in your Brevo dashboard (or set BREVO_SENDER_EMAIL to an already-verified address).`
      );
    }
    throw new Error(`Brevo ${r.status}: ${body.slice(0, 200)}`);
  }
  return { provider: 'brevo' };
}

async function sendViaSmtp({ to, subject, text, from }) {
  const host = process.env.SMTP_HOST;
  if (!host) return null;
  let nodemailer;
  try { nodemailer = require('nodemailer'); }
  catch (_) { throw new Error('SMTP_HOST is set but the "nodemailer" package is not installed.'); }
  const transporter = nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });
  await transporter.sendMail({
    from: isValidFromAddress(from) ? from : (process.env.SMTP_USER || from),
    to,
    subject,
    text,
  });
  return { provider: 'smtp' };
}

// Tries every CONFIGURED provider in priority order (Resend -> Brevo -> SMTP) and
// falls through to the next one on failure, instead of hard-failing on the first
// provider that happens to have a key set. This is the fix for "Resend key is set
// but broken, so nothing else ever gets tried."
async function sendEmail({ to, subject, text }) {
  const DEFAULT_FROM = 'OMNICEE <onboarding@resend.dev>';
  let from = (process.env.EMAIL_FROM || '').trim().replace(/^["']|["']$/g, '') || DEFAULT_FROM;
  if (from && !from.includes('<') && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from)) {
    from = `OMNICEE <${from}>`;
  }
  if (!isValidFromAddress(from)) {
    console.warn('[AUTH] Invalid EMAIL_FROM configured — using default sender');
    from = DEFAULT_FROM;
  }
  const fromParsed = parseFromAddress(from);
  if (process.env.BREVO_SENDER_EMAIL) fromParsed.email = process.env.BREVO_SENDER_EMAIL.trim();

  const providers = [
    { name: 'resend', configured: Boolean(process.env.RESEND_API_KEY), send: () => sendViaResend({ to, subject, text, from }) },
    { name: 'brevo', configured: Boolean(process.env.BREVO_API_KEY), send: () => sendViaBrevo({ to, subject, text, fromParsed }) },
    { name: 'smtp', configured: Boolean(process.env.SMTP_HOST), send: () => sendViaSmtp({ to, subject, text, from }) },
  ];

  const errors = [];
  for (const p of providers.filter(p => p.configured)) {
    try {
      const result = await p.send();
      if (result) return result;
    } catch (err) {
      console.warn(`[AUTH] ${p.name} send failed, trying next provider: ${err.message}`);
      errors.push(`${p.name}: ${err.message}`);
    }
  }

  // ALLOW_DEV_OTP returns the code in the API response (UI shows it).
  if (process.env.ALLOW_DEV_OTP === 'true') {
    console.log(`[AUTH DEV OTP] ${to} => code in response (ALLOW_DEV_OTP)`);
    return { provider: 'dev' };
  }

  if (errors.length) {
    throw new Error(`All configured email providers failed — ${errors.join(' | ')}`);
  }
  throw new Error('Email not configured. Set RESEND_API_KEY, BREVO_API_KEY, or SMTP_HOST (+ SMTP_USER/SMTP_PASS), or ALLOW_DEV_OTP=true for on-screen codes.');
}

function createEmailAuthRouter(express, db) {
  const router = express.Router();

  const MAX_PER_DAY = Math.max(1, Number(process.env.OTP_MAX_PER_EMAIL_PER_DAY || 8));
  const DAY_MS = 24 * 60 * 60 * 1000;
  const COOLDOWN_MS = 30000;
  const lastRequest = new Map();
  const ipRequest = new Map();
  const MAX_PER_IP_PER_HOUR = Math.max(1, Number(process.env.OTP_MAX_PER_IP_PER_HOUR || 20));
  const HOUR_MS = 60 * 60 * 1000;

  function cleanupStale(now) {
    if (lastRequest.size >= 500) {
      for (const [email, rec] of lastRequest) {
        if (now - rec.windowStart > DAY_MS) lastRequest.delete(email);
      }
    }
    if (ipRequest.size >= 500) {
      for (const [ip, rec] of ipRequest) {
        if (now - rec.windowStart > HOUR_MS) ipRequest.delete(ip);
      }
    }
  }

  router.post('/request', async (req, res) => {
    try {
      const email = normalizeEmail(req.body?.email);
      if (!isValidEmail(email)) {
        return res.status(400).json({ ok: false, error: 'Enter a valid email address' });
      }

      // Optional desk password (LOGIN_PASSWORD or DESK_PASSWORD). When set,
      // email alone is not enough — stops random inboxes from requesting OTP.
      const requiredPass = String(
        process.env.LOGIN_PASSWORD || process.env.DESK_PASSWORD || ''
      ).trim();
      if (requiredPass) {
        const provided = String(req.body?.password || '').trim();
        if (!provided || provided !== requiredPass) {
          return res.status(401).json({ ok: false, error: 'Invalid email or password' });
        }
      }

      const now = Date.now();
      cleanupStale(now);
      const ip = String(req.ip || req.socket?.remoteAddress || 'unknown');
      const ipPrev = ipRequest.get(ip);
      if (ipPrev && now - ipPrev.last < COOLDOWN_MS) {
        return res.status(429).json({ ok: false, error: 'Wait 30 seconds before requesting another code' });
      }
      const ipWindowStart = ipPrev && now - ipPrev.windowStart < HOUR_MS ? ipPrev.windowStart : now;
      const ipCount = ipPrev && now - ipPrev.windowStart < HOUR_MS ? ipPrev.count + 1 : 1;
      if (ipCount > MAX_PER_IP_PER_HOUR) {
        return res.status(429).json({ ok: false, error: 'Too many code requests from this address. Try again later.' });
      }

      const prev = lastRequest.get(email);
      if (prev && now - prev.last < COOLDOWN_MS) {
        return res.status(429).json({ ok: false, error: 'Wait 30 seconds before requesting another code' });
      }
      const windowStart = prev && now - prev.windowStart < DAY_MS ? prev.windowStart : now;
      const count = prev && now - prev.windowStart < DAY_MS ? prev.count + 1 : 1;
      if (count > MAX_PER_DAY) {
        return res.status(429).json({ ok: false, error: 'Too many codes requested for this email today. Try again tomorrow.' });
      }

      lastRequest.set(email, { last: now, windowStart, count });
      ipRequest.set(ip, { last: now, windowStart: ipWindowStart, count: ipCount });

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
      if (sendResult.provider === 'dev' && process.env.NODE_ENV !== 'production') payload.devCode = code;
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

      const ok = safeEqualHex(row.codeHash, hashCode(email, code));
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

  // Public: tell LoginGate whether to show the password field
  router.get('/config', (_req, res) => {
    const needsPassword = Boolean(String(
      process.env.LOGIN_PASSWORD || process.env.DESK_PASSWORD || ''
    ).trim());
    res.json({
      ok: true,
      passwordRequired: needsPassword,
      otpLength: 6,
      codeTtlMinutes: Math.round(CODE_TTL_MS / 60000),
    });
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
  // Do not accept session tokens in query strings: URLs can leak through logs,
  // browser history, referrers, analytics, and proxy caches.
  return (req.headers['x-session-token'] || '').trim() || null;
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
    } catch (_) { }
    next();
  };
}

function requireEmailAuth(req, res, next) {
  const enabled = process.env.EMAIL_AUTH_REQUIRED !== 'false';
  if (!enabled) return next();
  const p = req.path || '';
  if (p.startsWith('/api/ea') || p === '/health' || p.startsWith('/api/auth/email')) return next();
  if (req.emailSession) return next();
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
