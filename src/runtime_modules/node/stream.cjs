const stream = require("./stream.js");

const Stream = stream.default;
Object.assign(Stream, stream);
Stream.Stream = Stream;

module.exports = Stream;
