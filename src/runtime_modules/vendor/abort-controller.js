// abort-controller compatibility shim (Bun aliases the npm package to the
// built-in globals; upstream regression 09739 asserts identity with the
// global AbortController).

const AbortController = globalThis.AbortController;
const AbortSignal = globalThis.AbortSignal;

// Bun's package replacement is the global constructor itself for require(),
// while still exposing the package's named and default export properties.
Object.defineProperties(AbortController, {
  AbortController: { value: AbortController, enumerable: true, configurable: true },
  AbortSignal: { value: AbortSignal, enumerable: true, configurable: true },
  default: {
    value: { AbortController, AbortSignal },
    enumerable: true,
    configurable: true,
  },
});

export { AbortController, AbortSignal };
export default AbortController;
