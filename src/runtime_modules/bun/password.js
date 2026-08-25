import { asBuffer } from "./web-buffer-utils.js";

const passwordAlgorithmIds = { argon2id: 0, argon2i: 1, argon2d: 2, bcrypt: 3 };

function passwordBytes(value, name) {
  if (typeof value === "symbol") throw new TypeError(`${name} must be a string or BufferSource`);
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return asBuffer(value);
  return new TextEncoder().encode(String(value));
}

function passwordAlgorithm(value = undefined) {
  let label = "argon2id";
  let timeCost = 2;
  let memoryCost = 65536;
  let cost = 10;
  if (value !== undefined) {
    if (typeof value === "string") {
      label = value;
    } else if (value && typeof value === "object") {
      if (typeof value.algorithm !== "string") throw new TypeError("options.algorithm must be a string");
      label = value.algorithm;
      if (label === "bcrypt" && value.cost !== undefined) cost = Number(value.cost);
      if (label !== "bcrypt") {
        if (value.timeCost !== undefined) timeCost = Number(value.timeCost);
        if (value.memoryCost !== undefined) memoryCost = Number(value.memoryCost);
      }
    } else {
      throw new TypeError("algorithm must be a string or options object");
    }
  }
  if (!(label in passwordAlgorithmIds)) throw new TypeError("Unsupported password algorithm");
  if (label === "bcrypt") {
    if (!Number.isInteger(cost) || cost < 4 || cost > 31) throw new RangeError("Rounds must be between 4 and 31");
  } else {
    if (!Number.isInteger(timeCost) || timeCost < 1) throw new RangeError("Time cost must be greater than 0");
    if (!Number.isInteger(memoryCost) || memoryCost < 1) throw new RangeError("Memory cost must be greater than 0");
  }
  return { id: passwordAlgorithmIds[label], label, timeCost, memoryCost, cost };
}

function passwordHashSync(value, algorithm = undefined) {
  if (arguments.length === 0) throw new TypeError("password is required");
  const bytes = passwordBytes(value, "password");
  if (bytes.byteLength === 0) throw new TypeError("password must not be empty");
  const options = passwordAlgorithm(algorithm);
  return passwordNativeCall(() => cottontail.passwordHashSync(options.id, bytes, options.timeCost, options.memoryCost, options.cost));
}

function passwordHash(value, algorithm = undefined) {
  if (arguments.length === 0) throw new TypeError("password is required");
  const bytes = passwordBytes(value, "password");
  if (bytes.byteLength === 0) throw new TypeError("password must not be empty");
  const options = passwordAlgorithm(algorithm);
  return Promise.resolve().then(() => passwordNativeCall(() => cottontail.passwordHashSync(options.id, bytes, options.timeCost, options.memoryCost, options.cost)));
}

function inferPasswordAlgorithm(hash) {
  if (hash.startsWith("$argon2id$")) return "argon2id";
  if (hash.startsWith("$argon2i$")) return "argon2i";
  if (hash.startsWith("$argon2d$")) return "argon2d";
  if (hash.startsWith("$2") || hash.startsWith("$bcrypt$")) return "bcrypt";
  throw new TypeError("Unsupported password algorithm");
}

const passwordHashPatterns = {
  argon2id: /^\$argon2id\$v=\d+\$m=\d+,t=\d+,p=\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/,
  argon2i: /^\$argon2i\$v=\d+\$m=\d+,t=\d+,p=\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/,
  argon2d: /^\$argon2d\$v=\d+\$m=\d+,t=\d+,p=\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/,
  bcrypt: /^\$2[aby]?\$\d{2}\$[./A-Za-z0-9]{53}$/,
};
function passwordNativeCall(operation) {
  try {
    return operation();
  } catch (thrown) {
    if (thrown instanceof Error) throw thrown;
    throw new Error(typeof thrown === "string" ? thrown : "Password operation failed");
  }
}

function assertPasswordHashFormat(label, hash) {
  if (!passwordHashPatterns[label].test(hash)) {
    throw new Error("Password operation failed: InvalidEncoding");
  }
}

function passwordVerifySync(value, hashValue, algorithm = undefined) {
  if (arguments.length < 2) throw new TypeError("password and hash are required");
  const bytes = passwordBytes(value, "password");
  const hashBytes = passwordBytes(hashValue, "hash");
  if (bytes.byteLength === 0 || hashBytes.byteLength === 0) return false;
  const hash = new TextDecoder().decode(hashBytes);
  const options = passwordAlgorithm(algorithm === undefined ? inferPasswordAlgorithm(hash) : algorithm);
  assertPasswordHashFormat(options.label, hash);
  return passwordNativeCall(() => cottontail.passwordVerifySync(options.id, bytes, hashBytes));
}

function passwordVerify(value, hashValue, algorithm = undefined) {
  if (arguments.length < 2) throw new TypeError("password and hash are required");
  const bytes = passwordBytes(value, "password");
  const hashBytes = passwordBytes(hashValue, "hash");
  if (bytes.byteLength === 0 || hashBytes.byteLength === 0) return Promise.resolve(false);
  const hash = new TextDecoder().decode(hashBytes);
  const options = passwordAlgorithm(algorithm === undefined ? inferPasswordAlgorithm(hash) : algorithm);
  assertPasswordHashFormat(options.label, hash);
  return Promise.resolve().then(() => passwordNativeCall(() => cottontail.passwordVerifySync(options.id, bytes, hashBytes)));
}

export const password = {
  hash: passwordHash,
  hashSync: passwordHashSync,
  verify: passwordVerify,
  verifySync: passwordVerifySync,
};
