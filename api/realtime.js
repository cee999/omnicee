'use strict';

const EventEmitter = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(200);

let _dispatcher = null;
function setDispatcher(d) { _dispatcher = d; }
function getDispatcher() { return _dispatcher; }

// FIX: index.js and api/server.js each independently instantiated their own AdaptiveLearningEngine (and bayesianEngine/walkForward/institutionalGates/ drawdownGuard were never fed outcomes AT ALL — see...
let _engines = {};
function setEngines(e) { _engines = e || {}; }
function getEngines() { return _engines; }

module.exports = { bus, setDispatcher, getDispatcher, setEngines, getEngines };
