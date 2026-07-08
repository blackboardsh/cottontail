export function platform() {
  return cottontail.platform();
}

export function arch() {
  return cottontail.arch();
}

export function hostname() {
  return cottontail.hostname();
}

export function tmpdir() {
  return cottontail.env("TMPDIR") || cottontail.env("TEMP") || "/tmp";
}

export function type() {
  const name = platform();
  if (name === "darwin") return "Darwin";
  if (name === "win32") return "Windows_NT";
  if (name === "linux") return "Linux";
  return name;
}

export function release() {
  return "";
}

export function homedir() {
  return cottontail.env("HOME") || cottontail.env("USERPROFILE") || "/";
}

export function cpus() {
  const count = Number(cottontail.cpuCount?.() || 1);
  return Array.from({ length: Math.max(1, count) }, () => ({
    model: "",
    speed: 0,
    times: {
      user: 0,
      nice: 0,
      sys: 0,
      idle: 0,
      irq: 0,
    },
  }));
}

export function endianness() {
  return "LE";
}

export const EOL = platform() === "win32" ? "\r\n" : "\n";

export default { EOL, arch, cpus, endianness, hostname, homedir, platform, release, tmpdir, type };
