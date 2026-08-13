'use strict';

const webpush = require('web-push');

let configured = false;

function configure() {
  const subject = String(process.env.WEB_PUSH_SUBJECT || '').trim();
  const publicKey = String(process.env.WEB_PUSH_PUBLIC_KEY || '').trim();
  const privateKey = String(process.env.WEB_PUSH_PRIVATE_KEY || '').trim();

  if (!subject || !publicKey || !privateKey) {
    configured = false;
    return false;
  }

  webpush.setVapidDetails(subject, publicKey, privateKey);
  configured = true;
  return true;
}

function isConfigured() {
  if (!configured) configure();
  return configured;
}

function publicKey() {
  return String(process.env.WEB_PUSH_PUBLIC_KEY || '').trim();
}

function validateSubscription(subscription) {
  if (!subscription || typeof subscription !== 'object') return false;
  const endpoint = typeof subscription.endpoint === 'string' ? subscription.endpoint.trim() : '';
  const p256dh = subscription.keys?.p256dh;
  const auth = subscription.keys?.auth;
  return Boolean(
    endpoint &&
    /^https:\/\//i.test(endpoint) &&
    typeof p256dh === 'string' && p256dh.length >= 16 &&
    typeof auth === 'string' && auth.length >= 8
  );
}

async function send(subscription, payload) {
  if (!isConfigured()) {
    const error = new Error('Web Push is not configured');
    error.code = 'WEB_PUSH_NOT_CONFIGURED';
    throw error;
  }
  if (!validateSubscription(subscription)) {
    const error = new Error('Invalid Web Push subscription');
    error.code = 'INVALID_WEB_PUSH_SUBSCRIPTION';
    throw error;
  }

  return webpush.sendNotification(
    subscription,
    JSON.stringify({
      title: String(payload?.title || 'OMNICEE'),
      body: String(payload?.body || ''),
      icon: String(payload?.icon || '/icons/icon-192.png'),
      badge: String(payload?.badge || '/icons/icon-192.png'),
      tag: String(payload?.tag || 'omnicee-signal'),
      url: String(payload?.url || '/'),
      signalId: payload?.signalId || null,
      timestamp: Number(payload?.timestamp || Date.now()),
    }),
    { TTL: 300, urgency: 'high' }
  );
}

module.exports = {
  configure,
  isConfigured,
  publicKey,
  validateSubscription,
  send,
};
