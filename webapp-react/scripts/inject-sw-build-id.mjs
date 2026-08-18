// Stamp service-worker cache version after vite build.
// Soft-fails: a missing SW must not fail the whole deploy (UI still serves).

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const DIST = path.resolve(process.cwd(), 'dist');
const SW_PATH = path.join(DIST, 'sw.js');
const ASSETS_DIR = path.join(DIST, 'assets');

function warn(msg) {
  console.warn(`[inject-sw-build-id] ${msg}`);
}

if (!existsSync(path.join(DIST, 'index.html'))) {
  console.error('[inject-sw-build-id] FATAL: dist/index.html missing — vite build failed');
  process.exit(1);
}

if (!existsSync(SW_PATH)) {
  warn(`${SW_PATH} not found — skipping SW stamp (UI still OK)`);
  process.exit(0);
}
if (!existsSync(ASSETS_DIR)) {
  warn(`${ASSETS_DIR} not found — skipping SW stamp`);
  process.exit(0);
}

const assetNames = readdirSync(ASSETS_DIR).sort();
const buildId = createHash('sha256').update(assetNames.join(',')).digest('hex').slice(0, 10);

const sw = readFileSync(SW_PATH, 'utf8');
if (!sw.includes('__BUILD_ID__')) {
  warn('__BUILD_ID__ placeholder missing in sw.js — leaving file unchanged');
  process.exit(0);
}
writeFileSync(SW_PATH, sw.replaceAll('__BUILD_ID__', buildId));
console.log(`[inject-sw-build-id] CACHE_VERSION → omnicee-shell-${buildId}`);
