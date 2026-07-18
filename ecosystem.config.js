'use strict';

// IMPORTANT: index.js (the trading/signal engine) and api/server.js (REST +
// Socket.IO) share live data — signals, risk updates, market ticks — through
// an in-memory EventEmitter (api/realtime.js's `bus`), not a network
// transport. That only works if both run inside the SAME Node process.
//
// FIX: this file previously ran them as two separate PM2 apps in `fork`
// mode, which means two separate OS processes with two separate memory
// spaces — the EventEmitter bridge between them is invisible across that
// boundary. The engine would run and log signals fine, but nothing would
// ever reach the Mini App dashboard or Telegram over Socket.IO: no crash,
// just silence. See render.yaml's startCommand for the same constraint
// documented on the Render deploy path — this file now mirrors it exactly.
module.exports = {
  apps: [
    {
      name: 'omnicee',
      script: 'start-all.js',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '700M',
      env: {
        NODE_ENV: 'production',
        PORT: 3001,
      },
    },
  ],
};
