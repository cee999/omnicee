'use strict';

const EventEmitter = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(200);

// Shared reference for cross-module access (set by index.js)
let _dispatcher = null;
function setDispatcher(d) { _dispatcher = d; }
function getDispatcher() { return _dispatcher; }

// FIX: index.js and api/server.js each independently instantiated their own
// AdaptiveLearningEngine (and bayesianEngine/walkForward/institutionalGates/
// drawdownGuard were never fed outcomes AT ALL — see api/server.js). Since
// `new AdaptiveLearningEngine()` creates a fresh object each time, the two
// instances never shared state even when running in the same process via
// `npm run start:all`: real trade outcomes recorded through /api/outcomes
// updated a Q-table/blacklist/cache that index.js's live signal-scoring
// pipeline never consulted. This registry lets index.js publish the actual
// live singleton instances so /api/outcomes can update the ones that matter.
let _engines = {};
function setEngines(e) { _engines = e || {}; }
function getEngines() { return _engines; }

module.exports = { bus, setDispatcher, getDispatcher, setEngines, getEngines };
