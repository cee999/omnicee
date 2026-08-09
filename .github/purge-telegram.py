from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]

# index.js: replace the Telegram dispatcher with the web notification transport.
p = ROOT / 'index.js'
s = p.read_text(encoding='utf-8')
s = re.sub(r"^const BOT_TOKEN\s*=.*\nconst CHAT_IDS\s*=.*\n", "", s, flags=re.M)
s = s.replace("const { AlertDispatcher }    = loadModule('./signal-pipeline/alert-dispatcher',  'AlertDispatcher')    || {};", "const { WebNotifier } = loadModule('./api/web-notifier', 'WebNotifier') || {};")
s = re.sub(r"let dispatcher,", "let notifier,", s, count=1)
s = re.sub(r"\bdispatcher\b", "notifier", s)
s = s.replace('AlertDispatcher', 'WebNotifier')
# Replace the old Telegram initialization block with deterministic web notifier setup.
s = re.sub(
    r"  if \(WebNotifier && BOT_TOKEN\) \{.*?\n  if \(DrawdownGuard\) \{",
    "  notifier = WebNotifier ? new WebNotifier() : null;\n  if (notifier) {\n    notifier.sendMessage?.('OMNICEE Online — web alerts active', { title: 'OMNICEE' }).catch?.(() => {});\n    try { require('./api/realtime').setDispatcher(notifier); } catch (_) {}\n  }\n\n  if (DrawdownGuard) {",
    s,
    count=1,
    flags=re.S,
)
# Remove any remaining Telegram-specific init remnants.
s = re.sub(r"\n\s*try \{\n\s*await notifier\.init\(\);.*?\n\s*\}\n", "\n", s, flags=re.S)
s = s.replace('Telegram command', 'web app action').replace('Telegram output', 'web notifications').replace('Telegram init failed', 'Web notification initialization failed')
s = s.replace('Telegram bot initialised', 'Web notification transport initialized')
s = re.sub(r"\n\s*const BOT_TOKEN\b.*\n", "\n", s)
s = re.sub(r"\n\s*const CHAT_IDS\b.*\n", "\n", s)
p.write_text(s, encoding='utf-8')

# server.js: switch REST/socket auth to web/app-token auth and remove Telegram routes.
p = ROOT / 'api/server.js'
s = p.read_text(encoding='utf-8')
s = s.replace(
    "const { telegramAuthMiddleware, validateTelegramInitData, validateAppToken } = require('./telegram-auth');",
    "const { appTokenMiddleware, validateAppToken } = require('./web-auth');",
)
s = s.replace('telegramAuthMiddleware(req, res, next)', 'appTokenMiddleware(req, res, next)')
s = s.replace('req.telegramUser', 'req.user').replace('socket.telegramUser', 'socket.user')
s = s.replace("    const validation = validateTelegramInitData(initData, process.env.TELEGRAM_BOT_TOKEN);\n    if (!validation.ok) return next(new Error(validation.reason));\n    socket.user = validation.user;\n    socket.authMethod = 'telegram';\n    // FIX: same silent-swallow pattern as the REST /api/auth/telegram route above — a DB failure here was invisible.\n    try { await db.upsertTelegramUser(validation.user); } catch (err) { console.warn('[API] upsertTelegramUser failed (socket auth):', err.message); }\n    return next();",
    "    return next(new Error('Authentication required'));",
)
# Remove the Telegram REST authentication endpoint.
s = re.sub(r"\n\s*app\.post\('/api/auth/telegram'.*?\n\s*\}\);\n", "\n", s, flags=re.S)
# Socket auth no longer accepts Telegram initData.
s = re.sub(r"\n\s*const initData = socket\.handshake\.auth\?\.initData.*?\n\s*if \(!initData && !appToken && process\.env\.NODE_ENV !== 'production'\) return next\(\);", "\n    if (!appToken && process.env.NODE_ENV !== 'production') return next();", s)
s = s.replace("const appToken = socket.handshake.auth?.appToken || socket.handshake.query?.appToken;", "const appToken = socket.handshake.auth?.appToken || socket.handshake.query?.appToken;")
# Broadcast web notifications to connected browsers.
needle = "  forward('balance_update', 'balance');"
if needle in s and "forward('notification', 'notification'" not in s:
    s = s.replace(needle, needle + "\n  forward('notification', 'notification');")
p.write_text(s, encoding='utf-8')

# Remove obsolete Telegram-only implementation files.
for rel in ['api/telegram-auth.js', 'signal-pipeline/alert-dispatcher.js']:
    target = ROOT / rel
    if target.exists(): target.unlink()

# Remove Telegram environment configuration and references from docs/config examples.
for rel in ['.env.example', 'webapp-react/.env.example', 'render.yaml', 'README.md', 'webapp-react/README.md']:
    target = ROOT / rel
    if not target.exists():
        continue
    lines = target.read_text(encoding='utf-8').splitlines()
    cleaned = []
    for line in lines:
        if 'TELEGRAM_' in line or 'Telegram' in line or 'telegram' in line:
            continue
        cleaned.append(line)
    target.write_text('\n'.join(cleaned) + '\n', encoding='utf-8')

# No production source may retain Telegram references.
allowed = {'.git', 'node_modules', 'dist', 'build'}
hits = []
for path in ROOT.rglob('*'):
    if not path.is_file() or any(part in allowed for part in path.parts):
        continue
    try:
        text = path.read_text(encoding='utf-8')
    except (UnicodeDecodeError, OSError):
        continue
    if re.search(r'telegram', text, flags=re.I):
        hits.append(str(path.relative_to(ROOT)))
if hits:
    raise SystemExit('Telegram references remain in: ' + ', '.join(sorted(hits)))

print('Telegram purge complete; web notification transport installed.')
