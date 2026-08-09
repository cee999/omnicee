'use strict';

const { httpServer } = require('./api/server').startServer();

// FIX: Node's httpServer.listen() schedules the actual OS-level bind() asynchronously — calling it doesn't block, it just queues the bind onto the event loop.
httpServer.on('listening', () => {
  require('./index.js').main();
});
