'use strict';

module.exports = {
  apps: [
    {
      name: 'omnicee-api',
      script: 'api/server.js',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '350M',
      env: {
        NODE_ENV: 'production',
        PORT: 3001,
      },
    },
    {
      name: 'omnicee-engine',
      script: 'index.js',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '450M',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
