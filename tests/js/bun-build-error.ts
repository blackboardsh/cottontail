function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

let buildMessage: any;
try {
  await import("./fixtures/invalid-dynamic-module.js");
} catch (error) {
  buildMessage = error;
}

assert(buildMessage?.name === "BuildMessage", "dynamic import should reject with BuildMessage");
buildMessage.message = "updated build message";
assert(buildMessage.message === "updated build message", "BuildMessage.message should be mutable");

let resolveMessage: any;
try {
  await import("./fixtures/missing-dependency-module.js");
} catch (error) {
  resolveMessage = error;
}
assert(resolveMessage?.name === "ResolveMessage", "dynamic missing import should reject with ResolveMessage");
assert(resolveMessage.code === "ERR_MODULE_NOT_FOUND", "dynamic missing import code mismatch");
assert(resolveMessage.line >= 0 && resolveMessage.column >= 0, "ResolveMessage location mismatch");
assert(resolveMessage.position && typeof resolveMessage.position === "object", "ResolveMessage position mismatch");

console.log("bun build error passed");
