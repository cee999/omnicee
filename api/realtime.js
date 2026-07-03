'use strict';

const EventEmitter = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(200);

// Shared reference for cross-module access (set by index.js)
let _dispatcher = null;
function setDispatcher(d) { _dispatcher = d; }
function getDispatcher() { return _dispatcher; }

module.exports = { bus, setDispatcher, getDispatcher };
