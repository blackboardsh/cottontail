function illegalAccessor() {
  throw new TypeError("Illegal invocation");
}

class StreamWrap {}

for (const property of ["bytesRead", "fd", "_externalStream"]) {
  Object.defineProperty(StreamWrap.prototype, property, {
    get: illegalAccessor,
    enumerable: false,
    configurable: true,
  });
}

class TTY extends StreamWrap {}

class UDP {}

Object.defineProperty(UDP.prototype, "fd", {
  get: illegalAccessor,
  enumerable: false,
  configurable: true,
});

class SecureContext {}

Object.defineProperty(SecureContext.prototype, "_external", {
  get: illegalAccessor,
  enumerable: false,
  configurable: true,
});

export function internalBinding(name) {
  switch (String(name)) {
    case "tty_wrap":
      return { TTY };
    case "udp_wrap":
      return { UDP };
    case "crypto":
      return { SecureContext };
    default:
      throw new Error(`No such internal binding: ${name}`);
  }
}

export default {
  internalBinding,
};
