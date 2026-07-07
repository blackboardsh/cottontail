export function platform() {
  return cottontail.platform();
}

export function arch() {
  return cottontail.arch();
}

export function tmpdir() {
  return cottontail.env("TMPDIR") || cottontail.env("TEMP") || "/tmp";
}

export function homedir() {
  return cottontail.env("HOME") || cottontail.env("USERPROFILE") || "/";
}

export default { arch, homedir, platform, tmpdir };
