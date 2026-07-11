const sep = globalThis.process?.platform === "win32" ? "\\" : "/";

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
