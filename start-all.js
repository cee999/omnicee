'use strict';

// Single entry point for running the full OMNICEE stack (REST + Socket.IO
// + the trading engine) in one Node process. Required, not optional:
// index.js and api/server.js share live data through an in-memory
// EventEmitter (api/realtime.js), which only works within one process.
// See render.yaml's startCommand comment and ecosystem.config.js for the
// same constraint documented on other deploy paths.
const { httpServer } = require('./api/server').startServer();

// FIX: Node's httpServer.listen() schedules the actual OS-level bind()
// asynchronously — calling it doesn't block, it just queues the bind onto
// the event loop. Previously this file called startServer() and then
// immediately `require('./index.js')`, whose module-level code runs dozens
// of synchronous class instantiations across 2000+ lines (weight tables,
// regex compilation, agent/engine construction) BEFORE main() is even
// called. On a fast machine that's low tens of milliseconds and invisible.
// On Render's CPU-throttled free tier — especially a first-ever build in a
// new region with no warm cache — that synchronous block can run long
// enough to delay the pending listen() bind past Render's port-scan
// timeout, which fails the deploy with "no open ports detected" even
// though the server would have started fine given a few more seconds.
// Deferring index.js's require (and all its top-level work) until the
// 'listening' event actually fires guarantees the port is genuinely bound
// and accepting connections first, no matter how long index.js's own
// startup takes after that.
httpServer.on('listening', () => {
  require('./index.js').main();
});
