export function internalBinding(name) {
  const key = String(name);
  // Bun's internal/test/binding reaches bindings that process.binding()
  // refuses to expose publicly (signal_wrap, os, spawn_sync, zlib, ...).
  const binding = globalThis.process?.__cottontailBindingInternal ?? globalThis.process?.binding;
  if (typeof binding !== "function") {
    throw new Error("process.binding is unavailable");
  }
  return binding.call(globalThis.process, key);
}

export default {
  internalBinding,
};
