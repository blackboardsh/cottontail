// Picomatch reads `process` while this shim is being evaluated. The selective
// runtime enriches this same object later in its bootstrap sequence.
const runtimeProcess = globalThis.process ??= {};
runtimeProcess.platform ??= globalThis.cottontail?.platform?.() ?? "linux";
runtimeProcess.version ??= "v24.11.1";

const sep = runtimeProcess.platform === "win32" ? "\\" : "/";

function basename(value) {
  let text = String(value);
  while (text.length > 1 && /[\\/]/.test(text[text.length - 1])) text = text.slice(0, -1);
  const slash = text.lastIndexOf("/");
  const backslash = text.lastIndexOf("\\");
  const index = Math.max(slash, backslash);
  return index >= 0 ? text.slice(index + 1) : text;
}

export { sep, basename };
export default { sep, basename };
