const bunRuntime = globalThis[Symbol.for("cottontail.internal.bunRuntimeBridge")];
if (bunRuntime?.abiVersion !== 1) throw new Error("Cottontail Bun runtime bridge ABI mismatch");
const { stripANSI } = bunRuntime;

export default stripANSI;
export { stripANSI };
