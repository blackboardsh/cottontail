// Static imports use the same capability instance as dynamic import and require.
const namespace = globalThis[Symbol.for("cottontail.capabilityRequire")]("node:inspector/promises");
export const { Network, NetworkResources, Session, close, console, open, url, waitForDebugger } = namespace;
export default namespace.default;
