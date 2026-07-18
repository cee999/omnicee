'use strict';

// Single entry point for running the full OMNICEE stack (REST + Socket.IO
// + the trading engine) in one Node process. Required, not optional:
// index.js and api/server.js share live data through an in-memory
// EventEmitter (api/realtime.js), which only works within one process.
// See render.yaml's startCommand comment and ecosystem.config.js for the
// same constraint documented on other deploy paths.
require('./api/server').startServer();
require('./index.js').main();
