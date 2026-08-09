'use strict';

const express = require('express');
const { publicKey } = require('./web-push');
const store = require('./web-push-store');

function requireWebUser(req, res, next) {
  const email = String(req.emailSession?.email || '').trim().toLowerCase();
  if (!email) return res.status(401).json({ ok: false, error: 'Login required', code: 'AUTH_REQUIRED' });
  req.webUserId = email;
  next();
}

function createWebPushRouter() {
  const router = express.Router();

  router.get('/public-key', requireWebUser, (_req, res) => {
    const key = publicKey();
    if (!key) return res.status(503).json({ ok: false, error: 'Web Push is not configured' });
    res.json({ ok: true, publicKey: key });
  });

  router.post('/subscribe', requireWebUser, async (req, res) => {
    try {
      await store.save(req.webUserId, req.body?.subscription || req.body);
      res.status(201).json({ ok: true });
    } catch (err) {
      const status = /MONGODB_URI|database/i.test(err.message) ? 503 : 400;
      res.status(status).json({ ok: false, error: err.message });
    }
  });

  router.delete('/subscribe', requireWebUser, async (req, res) => {
    try {
      await store.remove(req.webUserId, req.body?.endpoint);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  return router;
}

module.exports = { createWebPushRouter };
