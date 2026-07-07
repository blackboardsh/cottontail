const process = globalThis.process ?? {
  argv: ["cottontail", ...(cottontail.args || [])],
  argv0: "cottontail",
  env: cottontail.env(),
  platform: cottontail.platform(),
  arch: cottontail.arch(),
  cwd: () => cottontail.cwd(),
  exit: (code = 0) => cottontail.exit(code),
  on: () => process,
};

globalThis.process = process;

export const argv = process.argv;
export const argv0 = process.argv0;
export const env = process.env;
export const platform = process.platform;
export const arch = process.arch;
export const cwd = process.cwd;
export const exit = process.exit;
export default process;
