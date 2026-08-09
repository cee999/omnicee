// never invalidate its cache — that would silently reintroduce the exact stale-shell bug this whole mechanism exists to prevent.

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const DIST = path.resolve(process.cwd(), 'dist');
const SW_PATH = path.join(DIST, 'sw.js');
const ASSETS_DIR = path.join(DIST, 'assets');

function fail(msg) {
  console.error(`[inject-sw-build-id] FATAL: ${msg}`);
  process.exit(1);
}

if (!existsSync(SW_PATH)) fail(`${SW_PATH} not found — did the Vite build run first?`);
if (!existsSync(ASSETS_DIR)) fail(`${ASSETS_DIR} not found — no hashed assets to fingerprint.`);

const assetNames = readdirSync(ASSETS_DIR).sort();
const buildId = createHash('sha256').update(assetNames.join(',')).digest('hex').slice(0, 10);

const sw = readFileSync(SW_PATH, 'utf8');
if (!sw.includes('__BUILD_ID__')) {
  fail('__BUILD_ID__ placeholder not found in dist/sw.js — public/sw.js may have been edited without keeping the placeholder.');
}
writeFileSync(SW_PATH, sw.replaceAll('__BUILD_ID__', buildId));
console.log(`[inject-sw-build-id] CACHE_VERSION → omnicee-shell-${buildId}`);
