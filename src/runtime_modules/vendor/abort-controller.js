// abort-controller compatibility shim (Bun aliases the npm package to the
// built-in globals; upstream regression 09739 asserts identity with the
// global AbortController).

const AbortController = globalThis.AbortController;
const AbortSignal = globalThis.AbortSignal;

export { AbortController, AbortSignal };
export default AbortController;
