// Static imports use the same capability instance as dynamic import and require.
const namespace = globalThis[Symbol.for("cottontail.capabilityRequire")]("node:sea");
export const { getAsset, getAssetAsBlob, getAssetKeys, getRawAsset, isSea } = namespace;
export default namespace.default;
