export function internalBinding(name) {
  const key = String(name);
  const binding = globalThis.process?.binding;
  if (typeof binding !== "function") {
    throw new Error("process.binding is unavailable");
  }
  return binding.call(globalThis.process, key);
}

export default {
  internalBinding,
};
