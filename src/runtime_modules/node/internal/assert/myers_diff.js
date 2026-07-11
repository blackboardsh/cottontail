import { diff } from "../../util.js";

function outOfRange(size) {
  const error = new RangeError(
    `The value of "myersDiff input size" is out of range. It must be < 2^31. Received ${size}`,
  );
  error.code = "ERR_OUT_OF_RANGE";
  return error;
}

export function myersDiff(actual, expected) {
  const size = Number(actual?.length ?? 0) + Number(expected?.length ?? 0);
  if (size >= 2 ** 31) throw outOfRange(size);
  return diff(actual, expected);
}

export default {
  myersDiff,
};
