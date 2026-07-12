const path = require("../path.js");

// require("path/win32") must be the exact same object as require("path").win32.
module.exports = (path.default ?? path).win32;
