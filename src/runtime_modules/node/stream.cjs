const stream = require("./stream.js");

// The default export is the legacy Stream constructor carrying every
// public property (Readable, Writable, promises getter, ...).
module.exports = stream.default ?? stream;
