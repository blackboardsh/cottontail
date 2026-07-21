import { isUtf8 } from "../node/buffer.js";

// COTTONTAIL-COMPAT: Bun replaces the optional utf-8-validate native addon
// with the runtime's Buffer UTF-8 validator.
export default function utf8Validate(input) {
  return isUtf8(input);
}
