// Use the capability instance shared by the runtime module loader.
const namespace = globalThis.Cottontail.toml;
export const { parse, stringify, TOML } = namespace;
export default namespace.default;
