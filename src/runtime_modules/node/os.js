import * as nodeConstants from "./constants.js";
import { Buffer } from "./buffer.js";

const startMs = Date.now();

function shell(command) {
  try {
    const result = cottontail.spawnSync(cottontail.platform() === "win32" ? "cmd" : "sh", cottontail.platform() === "win32" ? ["/d", "/s", "/c", command] : ["-c", command], { stdio: "pipe" });
    return result.status === 0 ? String(result.stdout || "").trim() : "";
  } catch {
    return "";
  }
}

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
  if (platform() === "win32") return shell("ver");
  return shell("uname -r");
}

export function homedir() {
  return cottontail.env("HOME") || cottontail.env("USERPROFILE") || "/";
}

function cpuModel() {
  if (platform() === "linux" && cottontail.existsSync?.("/proc/cpuinfo")) {
    const match = String(cottontail.readFile("/proc/cpuinfo")).match(/^model name\s*:\s*(.+)$/m);
    if (match) return match[1].trim();
  }
  if (platform() === "darwin") return shell("sysctl -n machdep.cpu.brand_string") || machine();
  if (platform() === "win32") return cottontail.env("PROCESSOR_IDENTIFIER") || machine();
  return machine();
}

function cpuSpeed() {
  if (platform() === "linux" && cottontail.existsSync?.("/proc/cpuinfo")) {
    const match = String(cottontail.readFile("/proc/cpuinfo")).match(/^cpu MHz\s*:\s*(.+)$/m);
    const mhz = Number(match?.[1]);
    if (Number.isFinite(mhz) && mhz > 0) return Math.round(mhz);
  }
  if (platform() === "darwin") {
    const hz = Number(shell("sysctl -n hw.cpufrequency"));
    if (Number.isFinite(hz) && hz > 0) return Math.round(hz / 1000000);
  }
  return 0;
}

function linuxCpuTimes() {
  if (platform() !== "linux" || !cottontail.existsSync?.("/proc/stat")) return [];
  const lines = String(cottontail.readFile("/proc/stat")).split(/\r?\n/);
  const output = [];
  for (const line of lines) {
    const match = line.match(/^cpu(\d+)\s+(.+)$/);
    if (!match) continue;
    const values = match[2].trim().split(/\s+/).map((value) => Number(value) * 10);
    output[Number(match[1])] = {
      user: values[0] || 0,
      nice: values[1] || 0,
      sys: values[2] || 0,
      idle: values[3] || 0,
      irq: values[5] || 0,
    };
  }
  return output;
}

export function cpus() {
  const count = Number(cottontail.cpuCount?.() || 1);
  const model = cpuModel();
  const speed = cpuSpeed();
  const times = linuxCpuTimes();
  return Array.from({ length: Math.max(1, count) }, () => ({
    model,
    speed,
    times: times.shift() ?? {
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

export function availableParallelism() {
  return Math.max(1, Number(cottontail.cpuCount?.() || 1));
}

export function freemem() {
  return Number(globalThis.process?.availableMemory?.() ?? 0);
}

export function totalmem() {
  return Number(globalThis.process?.constrainedMemory?.() || freemem() || 0);
}

export function loadavg() {
  if (platform() === "win32") return [0, 0, 0];
  const linux = cottontail.existsSync?.("/proc/loadavg") ? cottontail.readFile("/proc/loadavg") : "";
  const source = linux || shell("sysctl -n vm.loadavg");
  const matches = String(source).match(/[-+]?\d+(?:\.\d+)?/g) ?? [];
  return [0, 1, 2].map((index) => Number(matches[index] ?? 0));
}

export function machine() {
  if (arch() === "x64") return "x86_64";
  if (arch() === "ia32" || arch() === "x86") return "i386";
  return arch();
}

export function uptime() {
  if (cottontail.existsSync?.("/proc/uptime")) {
    const value = Number(String(cottontail.readFile("/proc/uptime")).split(/\s+/)[0]);
    if (Number.isFinite(value)) return value;
  }
  const bootTime = shell("sysctl -n kern.boottime");
  const match = bootTime.match(/sec\\s*=\\s*(\\d+)/);
  if (match) return Math.max(0, Date.now() / 1000 - Number(match[1]));
  return Math.max(0, (Date.now() - startMs) / 1000);
}

export function userInfo(options = {}) {
  const encoding = options?.encoding ?? "utf8";
  const username = cottontail.env("USER") || cottontail.env("USERNAME") || "";
  const shellPath = cottontail.env("SHELL") || (platform() === "win32" ? cottontail.env("ComSpec") || "cmd.exe" : "/bin/sh");
  const info = {
    uid: typeof globalThis.process?.getuid === "function" ? globalThis.process.getuid() : -1,
    gid: typeof globalThis.process?.getgid === "function" ? globalThis.process.getgid() : -1,
    username,
    homedir: homedir(),
    shell: shellPath,
  };
  if (encoding === "buffer") {
    return {
      uid: info.uid,
      gid: info.gid,
      username: Buffer.from(info.username),
      homedir: Buffer.from(info.homedir),
      shell: Buffer.from(info.shell),
    };
  }
  return info;
}

function parseIfconfig(text) {
  const output = {};
  let current = null;
  for (const line of String(text).split(/\r?\n/)) {
    const header = line.match(/^([^\s:]+):/);
    if (header) {
      current = header[1];
      output[current] ??= [];
    }
    if (!current) continue;
    const ipv4 = line.match(/\binet\s+(\d+\.\d+\.\d+\.\d+)/);
    if (ipv4) {
      const internal = ipv4[1].startsWith("127.");
      output[current].push({ address: ipv4[1], netmask: "255.255.255.255", family: "IPv4", mac: "00:00:00:00:00:00", internal, cidr: null });
    }
    const ipv6 = line.match(/\binet6\s+([0-9a-fA-F:]+)/);
    if (ipv6) {
      const internal = ipv6[1] === "::1";
      output[current].push({ address: ipv6[1], netmask: "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", family: "IPv6", mac: "00:00:00:00:00:00", internal, cidr: null, scopeid: 0 });
    }
  }
  for (const key of Object.keys(output)) {
    if (output[key].length === 0) delete output[key];
  }
  return output;
}

export function networkInterfaces() {
  if (typeof cottontail.osNetworkInterfaces === "function") {
    const output = {};
    for (const entry of cottontail.osNetworkInterfaces()) {
      const name = String(entry.name);
      output[name] ??= [];
      const item = {
        address: String(entry.address),
        netmask: String(entry.netmask ?? ""),
        family: String(entry.family),
        mac: String(entry.mac ?? "00:00:00:00:00:00"),
        internal: Boolean(entry.internal),
        cidr: entry.cidr == null ? null : String(entry.cidr),
      };
      if (item.family === "IPv6") item.scopeid = Number(entry.scopeid ?? 0);
      output[name].push(item);
    }
    return output;
  }
  const output = shell("ifconfig -a 2>/dev/null || ip addr 2>/dev/null");
  return parseIfconfig(output);
}

export function getPriority(pid = 0) {
  const target = Number(pid || globalThis.process?.pid || 0);
  if (typeof cottontail.osGetPriority === "function") return Number(cottontail.osGetPriority(target));
  const value = shell(`ps -o ni= -p ${target || "$$"}`);
  const priority = Number(value.trim());
  return Number.isFinite(priority) ? priority : 0;
}

export function setPriority(pid, priority = undefined) {
  if (priority === undefined) {
    priority = pid;
    pid = globalThis.process?.pid ?? 0;
  }
  const target = Number(pid || globalThis.process?.pid || 0);
  if (typeof cottontail.osSetPriority === "function") {
    cottontail.osSetPriority(target, Number(priority));
    return;
  }
  const result = shell(`renice -n ${Number(priority)} -p ${target || "$$"} >/dev/null 2>&1; echo $?`);
  if (result && Number(result) !== 0) throw new Error("setPriority failed");
}

export function version() {
  if (platform() === "win32") return shell("ver");
  return shell("uname -v");
}

export const EOL = platform() === "win32" ? "\r\n" : "\n";
export const devNull = platform() === "win32" ? "\\\\.\\nul" : "/dev/null";
export const constants = {
  UV_UDP_REUSEADDR: 4,
  dlopen: {
    RTLD_LAZY: nodeConstants.RTLD_LAZY,
    RTLD_NOW: nodeConstants.RTLD_NOW,
    RTLD_GLOBAL: nodeConstants.RTLD_GLOBAL,
    RTLD_LOCAL: nodeConstants.RTLD_LOCAL,
  },
  errno: Object.fromEntries(Object.entries(nodeConstants).filter(([name, value]) => /^E[A-Z0-9]+$/.test(name) && typeof value === "number")),
  signals: Object.fromEntries(Object.entries(nodeConstants).filter(([name, value]) => /^SIG[A-Z0-9]+$/.test(name) && typeof value === "number")),
  priority: {
    PRIORITY_LOW: nodeConstants.PRIORITY_LOW,
    PRIORITY_BELOW_NORMAL: nodeConstants.PRIORITY_BELOW_NORMAL,
    PRIORITY_NORMAL: nodeConstants.PRIORITY_NORMAL,
    PRIORITY_ABOVE_NORMAL: nodeConstants.PRIORITY_ABOVE_NORMAL,
    PRIORITY_HIGH: nodeConstants.PRIORITY_HIGH,
    PRIORITY_HIGHEST: nodeConstants.PRIORITY_HIGHEST,
  },
};

export default {
  EOL,
  arch,
  availableParallelism,
  constants,
  cpus,
  devNull,
  endianness,
  freemem,
  getPriority,
  hostname,
  homedir,
  loadavg,
  machine,
  networkInterfaces,
  platform,
  release,
  setPriority,
  tmpdir,
  totalmem,
  type,
  uptime,
  userInfo,
  version,
};
