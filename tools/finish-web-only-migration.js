'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const write = (p, value) => fs.writeFileSync(path.join(root, p), value, 'utf8');

function replaceOnce(text, pattern, replacement, label) {
  const next = text.replace(pattern, replacement);
  if (next === text) throw new Error(`Migration anchor not found: ${label}`);
  return next;
}

let index = read('index.js');
index = index.replace(/^const BOT_TOKEN\s*=.*\n/m, '');
index = index.replace(/^const CHAT_IDS\s*=.*\n/m, '');
index = replaceOnce(index, /loadModule\('\.\/signal-pipeline\/alert-dispatcher',\s*'AlertDispatcher'\)/, "loadModule('./signal-pipeline/web-alert-dispatcher', 'AlertDispatcher')", 'AlertDispatcher import');
write('index.js', index);

let server = read('api/server.js');
server = replaceOnce(server, /const \{ telegramAuthMiddleware, validateTelegramInitData, validateAppToken \} = require\('\.\/telegram-auth'\);/, "const { webAuthMiddleware, validateAppToken } = require('./web-auth');", 'server auth import');
server = server.replace(/\btelegramUser\b/g, 'webUser');
server = replaceOnce(server, /function dashboardReadAuth\(req, res, next\) \{[\s\S]*?\n\}\n\nfunction latestMarketRows/, `function dashboardReadAuth(req, res, next) {
  if (req.emailSession?.email) {
    req.webUser = { id: req.emailSession.email, username: req.emailSession.email };
    req.authMethod = 'email';
    return next();
  }
  const publicPricePaths = new Set([
    '/api/market', '/api/candles', '/api/health', '/health',
    '/api/calendar', '/api/news', '/api/signals', '/api/audit-trail',
    '/api/outlook', '/api/heatmap', '/api/stats', '/api/levels', '/api/watchlist',
  ]);
  const p = (req.path || req.url || '').split('?')[0];
  if (req.method === 'GET' && publicPricePaths.has(p) && process.env.PUBLIC_DASHBOARD_READ !== 'false') {
    req.webUser = { id: 'public-dashboard', username: 'public-dashboard' };
    req.authMethod = 'public-dashboard-read';
    return next();
  }
  return webAuthMiddleware(req, res, next);
}

function latestMarketRows` , 'dashboard auth');
server = replaceOnce(server, /\n\s*app\.post\('\/api\/auth\/telegram'[\s\S]*?\n\s*\}\);\n\n\s*app\.get\('\/api\/signals'/, `\n  app.use('/api/push', createWebPushRouter());\n\n  app.get('/api/signals'`, 'telegram auth route');
server = server.replace("const { createEmailAuthRouter, emailSessionMiddleware, requireEmailAuth, ensureAuthIndexes } = require('./email-auth');", "const { createEmailAuthRouter, emailSessionMiddleware, requireEmailAuth, ensureAuthIndexes } = require('./email-auth');\nconst { createWebPushRouter } = require('./web-push-routes');");
server = replaceOnce(server, /io\.use\(async \(socket, next\) => \{[\s\S]*?\n\s*\}\);\n\s*io\.on\('connection'/, `io.use(async (socket, next) => {
    if (socket.handshake.auth?.appToken) {
      const result = validateAppToken(socket.handshake.auth.appToken);
      if (result.ok) {
        socket.webUser = result.user;
        socket.authMethod = 'app-token';
        return next();
      }
      return next(new Error('Unauthorized'));
    }
    if (socket.handshake.auth?.email) {
      socket.webUser = { id: String(socket.handshake.auth.email).trim().toLowerCase(), username: String(socket.handshake.auth.email).trim().toLowerCase() };
      socket.authMethod = 'email';
      return next();
    }
    if (!isProduction() && process.env.ALLOW_DEV_WEB_AUTH === 'true') {
      socket.webUser = { id: 'dev', username: 'local-dev' };
      socket.authMethod = 'dev';
      return next();
    }
    return next(new Error('Unauthorized'));
  });
  io.on('connection'`, 'socket authentication');
server = server.replace(/\btelegramUser\b/g, 'webUser');
write('api/server.js', server);

// Remove obsolete Telegram-only modules after all imports have been migrated.
for (const file of ['api/telegram-auth.js', 'signal-pipeline/alert-dispatcher.js']) {
  const full = path.join(root, file);
  if (fs.existsSync(full)) fs.unlinkSync(full);
}

// Remove Telegram configuration lines from deployment/example configuration.
for (const file of ['render.yaml', '.env.example']) {
  const full = path.join(root, file);
  if (!fs.existsSync(full)) continue;
  const lines = read(file).split(/\r?\n/);
  write(file, lines.filter(line => !/TELEGRAM_/i.test(line)).join('\n'));
}

// Purge remaining Telegram references from executable/configuration source.
const candidates = [];
function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    if (name === '.git' || name === 'node_modules' || name === 'dist') continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full);
    else if (/\.(js|mjs|cjs|json|yml|yaml|env|example)$/.test(name)) candidates.push(full);
  }
}
walk(root);
const hits = [];
for (const full of candidates) {
  const text = fs.readFileSync(full, 'utf8');
  if (/telegram/i.test(text)) hits.push(path.relative(root, full));
}
if (hits.length) throw new Error(`Telegram references remain in executable/config files: ${hits.join(', ')}`);

// Validate the directly modified Node entry points before allowing a commit.
for (const file of ['index.js', 'api/server.js', 'api/web-auth.js', 'api/web-push.js', 'api/web-push-store.js', 'api/web-push-routes.js', 'signal-pipeline/web-alert-dispatcher.js']) {
  execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'inherit' });
}
console.log('WEB_ONLY_MIGRATION_OK');
