const events = require("./events.js");

// Node's events module exports the EventEmitter constructor itself, so CJS
// consumers can do `class X extends require("events")`.
const EventEmitter = events.default ?? events.EventEmitter;
module.exports = EventEmitter;
