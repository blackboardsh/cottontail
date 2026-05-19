import * as hookModule from "./__MODULE_NAME__";

const maybeHook = hookModule.default;

if (typeof maybeHook === "function") {
  const result = maybeHook();
  if (result && typeof result.then === "function") {
    await result;
  }
}
