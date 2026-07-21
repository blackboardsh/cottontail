const assert = require("node:assert"); module.exports = function captureFailure() { try { assert.ok(false); } catch (error) { return error; } throw new Error("assert.ok(false) did not throw"); };
