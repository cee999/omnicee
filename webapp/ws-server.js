'use strict';

// Backward-compatible bridge. The trading engine still imports this path,
// while the implementation now lives in the production REST + Socket.IO API.
module.exports = require('../api/server');
