export {
  Assert,
  AssertionError,
  CallTracker,
  deepEqual,
  deepStrictEqual,
  doesNotMatch,
  doesNotReject,
  doesNotThrow,
  equal,
  fail,
  ifError,
  match,
  notDeepEqual,
  notDeepStrictEqual,
  notEqual,
  notStrictEqual,
  ok,
  partialDeepStrictEqual,
  rejects,
  strict,
  strictEqual,
  throws,
} from "../assert.js";
import assert from "../assert.js";

export default assert.strict ?? assert;
