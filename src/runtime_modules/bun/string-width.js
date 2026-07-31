const bunRuntime = globalThis[Symbol.for("cottontail.internal.bunRuntimeBridge")];
if (bunRuntime?.abiVersion !== 1) throw new Error("Cottontail Bun runtime bridge ABI mismatch");
const { stringWidth } = bunRuntime;

export default stringWidth;
export { stringWidth };
