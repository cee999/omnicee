'use strict';

// FIX: this file previously ran them as two separate PM2 apps in `fork` mode, which means two separate OS processes with two separate memory spaces — the EventEmitter bridge between them is invisible...
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
