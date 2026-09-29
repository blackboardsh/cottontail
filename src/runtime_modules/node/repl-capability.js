// Static imports use the same capability instance as dynamic import and require.
const namespace = globalThis[Symbol.for("cottontail.capabilityRequire")]("node:repl");
export const { REPLServer, REPL_MODE_SLOPPY, REPL_MODE_STRICT, Recoverable, _builtinLibs, builtinModules, isValidSyntax, start, writer, runBuiltinCLI, runBuiltinEval } = namespace;
export default namespace.default;
