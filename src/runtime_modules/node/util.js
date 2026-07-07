export function parseArgs(options = {}) {
  const input = options.args || [];
  const values = {};
  const positionals = [];
  for (let index = 0; index < input.length; index += 1) {
    const arg = input[index];
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = arg.slice(2, eq === -1 ? undefined : eq);
      const spec = options.options?.[name] || {};
      if (spec.type === "boolean") {
        values[name] = eq === -1 ? true : arg.slice(eq + 1) !== "false";
      } else if (eq !== -1) {
        values[name] = arg.slice(eq + 1);
      } else {
        values[name] = input[++index];
      }
    } else if (options.allowPositionals) {
      positionals.push(arg);
    }
  }
  return { values, positionals };
}

export default { parseArgs };
