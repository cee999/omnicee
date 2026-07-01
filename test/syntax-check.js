'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIRS = ['api', 'agents', 'orchestrator', 'signal-pipeline', 'risk-engine', 'feeds', 'webapp'];
const files = ['index.js'];

for (const dir of DIRS) {
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) continue;
  for (const name of fs.readdirSync(full)) {
    if (name.endsWith('.js')) files.push(path.join(dir, name));
  }
}

let failed = 0;
for (const file of files) {
  const res = spawnSync(process.execPath, ['--check', path.join(ROOT, file)], { encoding: 'utf8' });
  if (res.status !== 0) {
    failed++;
    process.stderr.write(`\n[syntax] ${file}\n${res.stderr || res.stdout}`);
  }
}

if (failed) process.exit(1);
console.log(`[syntax] ${files.length} files OK`);
