const path = require("../path.js");

// require("path/posix") must be the exact same object as require("path").posix.
module.exports = (path.default ?? path).posix;
