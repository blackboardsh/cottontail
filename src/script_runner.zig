const std = @import("std");
const builtin = @import("builtin");
const runtime = @import("runtime.zig");

const esbuild_version = "0.28.0";

const Context = struct {
    io: std.Io,
    allocator: std.mem.Allocator,
    environ_map: *std.process.Environ.Map,
    cottontail_home: []const u8,
    project_root: []const u8,

    fn writeStdout(self: *const Context, comptime fmt: []const u8, args: anytype) void {
        var buffer: [2048]u8 = undefined;
        var writer = std.Io.File.stdout().writer(self.io, &buffer);
        const stdout = &writer.interface;
        stdout.print(fmt, args) catch {};
        stdout.flush() catch {};
    }

    fn writeStderr(self: *const Context, comptime fmt: []const u8, args: anytype) void {
        var buffer: [2048]u8 = undefined;
        var writer = std.Io.File.stderr().writer(self.io, &buffer);
        const stderr = &writer.interface;
        stderr.print(fmt, args) catch {};
        stderr.flush() catch {};
    }
};

pub fn run(init: std.process.Init, script_path: [:0]const u8, script_args: []const [:0]const u8) !u8 {
    const allocator = init.arena.allocator();
    const exe_dir = try std.process.executableDirPathAlloc(init.io, allocator);
    const ctx = Context{
        .io = init.io,
        .allocator = allocator,
        .environ_map = init.environ_map,
        .cottontail_home = try findCottontailHome(init, allocator, exe_dir),
        .project_root = try std.Io.Dir.cwd().realPathFileAlloc(init.io, ".", allocator),
    };

    const runnable_path = if (isTypescriptPath(script_path))
        try bundleTypescript(&ctx, script_path)
    else
        try allocator.dupe(u8, script_path);

    const runnable_path_z = try allocator.dupeZ(u8, runnable_path);

    var js_runtime = runtime.Runtime.init(init.io, allocator) catch {
        ctx.writeStderr("cottontail: failed to initialize the embedded QuickJS runtime\n", .{});
        return 1;
    };
    defer js_runtime.deinit();

    js_runtime.setArgs(script_args) catch {
        ctx.writeStderr("cottontail: failed to initialize cottontail.args\n", .{});
        return 1;
    };

    return js_runtime.runFile(runnable_path_z);
}

fn isTypescriptPath(path: []const u8) bool {
    return std.mem.endsWith(u8, path, ".ts") or
        std.mem.endsWith(u8, path, ".tsx") or
        std.mem.endsWith(u8, path, ".mts") or
        std.mem.endsWith(u8, path, ".cts");
}

fn bundleTypescript(ctx: *const Context, script_path: []const u8) ![]const u8 {
    try ensureEsbuild(ctx);

    const tmp_dir = try ensureTempDir(ctx);
    try writeShimModules(ctx, tmp_dir);

    const script_abs = try resolvePathForCwd(ctx.io, ctx.allocator, script_path);
    const bundle_path = try std.fs.path.join(ctx.allocator, &.{ tmp_dir, "script.bundle.mjs" });
    const esbuild_bin = try esbuildBinaryPath(ctx);

    const bun_shim = try std.fs.path.join(ctx.allocator, &.{ tmp_dir, "bun-shim.mjs" });
    const fs_shim = try std.fs.path.join(ctx.allocator, &.{ tmp_dir, "fs-shim.mjs" });
    const os_shim = try std.fs.path.join(ctx.allocator, &.{ tmp_dir, "os-shim.mjs" });
    const path_shim = try std.fs.path.join(ctx.allocator, &.{ tmp_dir, "path-shim.mjs" });
    const process_shim = try std.fs.path.join(ctx.allocator, &.{ tmp_dir, "process-shim.mjs" });
    const util_shim = try std.fs.path.join(ctx.allocator, &.{ tmp_dir, "util-shim.mjs" });

    const args = [_][]const u8{
        esbuild_bin,
        script_abs,
        "--bundle",
        "--platform=neutral",
        "--format=esm",
        "--target=es2022",
        try std.fmt.allocPrint(ctx.allocator, "--outfile={s}", .{bundle_path}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:bun={s}", .{bun_shim}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:fs={s}", .{fs_shim}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:os={s}", .{os_shim}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:path={s}", .{path_shim}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:process={s}", .{process_shim}),
        try std.fmt.allocPrint(ctx.allocator, "--alias:util={s}", .{util_shim}),
    };

    const result = try std.process.run(ctx.allocator, ctx.io, .{
        .argv = &args,
        .cwd = .{ .path = ctx.project_root },
        .create_no_window = true,
    });
    defer ctx.allocator.free(result.stdout);
    defer ctx.allocator.free(result.stderr);

    if (termExitCode(result.term) != 0) {
        if (result.stdout.len > 0) ctx.writeStdout("{s}", .{result.stdout});
        if (result.stderr.len > 0) ctx.writeStderr("{s}", .{result.stderr});
        return error.EsbuildFailed;
    }

    return bundle_path;
}

fn writeShimModules(ctx: *const Context, tmp_dir: []const u8) !void {
    try writeFile(ctx, tmp_dir, "bun-shim.mjs", bun_shim_source);
    try writeFile(ctx, tmp_dir, "fs-shim.mjs", fs_shim_source);
    try writeFile(ctx, tmp_dir, "os-shim.mjs", os_shim_source);
    try writeFile(ctx, tmp_dir, "path-shim.mjs", path_shim_source);
    try writeFile(ctx, tmp_dir, "process-shim.mjs", process_shim_source);
    try writeFile(ctx, tmp_dir, "util-shim.mjs", util_shim_source);
}

fn writeFile(ctx: *const Context, dir: []const u8, name: []const u8, data: []const u8) !void {
    try std.Io.Dir.cwd().writeFile(ctx.io, .{
        .sub_path = try std.fs.path.join(ctx.allocator, &.{ dir, name }),
        .data = data,
    });
}

fn ensureTempDir(ctx: *const Context) ![]const u8 {
    const tmp_dir = try std.fs.path.join(ctx.allocator, &.{ ctx.project_root, ".cottontail-tmp", "run" });
    try std.Io.Dir.cwd().createDirPath(ctx.io, tmp_dir);
    return tmp_dir;
}

fn findCottontailHome(init: std.process.Init, allocator: std.mem.Allocator, exe_dir: []const u8) ![]const u8 {
    if (init.environ_map.get("COTTONTAIL_HOME")) |home| {
        return try resolvePathForCwd(init.io, allocator, home);
    }

    if (init.environ_map.get("DASH_COTTONTAIL_ROOT")) |home| {
        return try resolvePathForCwd(init.io, allocator, home);
    }

    var current: []const u8 = try allocator.dupe(u8, exe_dir);
    while (true) {
        if (looksLikeCottontailHome(init.io, allocator, current)) return current;
        const parent = std.fs.path.dirname(current) orelse break;
        if (std.mem.eql(u8, parent, current)) break;
        current = parent;
    }

    return try allocator.dupe(u8, exe_dir);
}

fn looksLikeCottontailHome(io: std.Io, allocator: std.mem.Allocator, candidate: []const u8) bool {
    const package_json = std.fs.path.join(allocator, &.{ candidate, "package.json" }) catch return false;
    defer allocator.free(package_json);
    const src_main = std.fs.path.join(allocator, &.{ candidate, "src", "main.zig" }) catch return false;
    defer allocator.free(src_main);
    return pathExists(io, package_json) and pathExists(io, src_main);
}

fn resolvePathForCwd(io: std.Io, allocator: std.mem.Allocator, path: []const u8) ![]const u8 {
    if (std.fs.path.isAbsolute(path)) return try allocator.dupe(u8, path);
    return try std.Io.Dir.cwd().realPathFileAlloc(io, path, allocator);
}

fn pathExists(io: std.Io, path: []const u8) bool {
    if (std.fs.path.isAbsolute(path)) {
        std.Io.Dir.accessAbsolute(io, path, .{}) catch return false;
    } else {
        std.Io.Dir.cwd().access(io, path, .{}) catch return false;
    }
    return true;
}

fn ensureEsbuild(ctx: *const Context) !void {
    const vendor_dir = try std.fs.path.join(ctx.allocator, &.{ ctx.cottontail_home, "vendors", "esbuild" });
    const version_file = try std.fs.path.join(ctx.allocator, &.{ vendor_dir, ".esbuild-version" });
    const esbuild_bin = try std.fs.path.join(ctx.allocator, &.{ vendor_dir, esbuildBinaryName() });

    if (pathExists(ctx.io, version_file) and pathExists(ctx.io, esbuild_bin)) {
        const current_version = std.Io.Dir.cwd().readFileAlloc(ctx.io, version_file, ctx.allocator, .limited(64)) catch "";
        if (std.mem.eql(u8, std.mem.trim(u8, current_version, " \r\n\t"), esbuild_version)) return;
    }

    if (pathExists(ctx.io, vendor_dir)) {
        std.Io.Dir.cwd().deleteTree(ctx.io, vendor_dir) catch {};
    }
    try std.Io.Dir.cwd().createDirPath(ctx.io, vendor_dir);

    const package_name = try esbuildPackageName();
    const tarball_name = try esbuildTarballName();
    const url = try std.fmt.allocPrint(ctx.allocator, "https://registry.npmjs.org/@esbuild/{s}/-/{s}-{s}.tgz", .{ package_name, tarball_name, esbuild_version });
    const tarball_path = try std.fs.path.join(ctx.allocator, &.{ vendor_dir, "esbuild.tgz" });
    const extract_dir = try std.fs.path.join(ctx.allocator, &.{ vendor_dir, "extract" });

    ctx.writeStdout("Vendoring esbuild {s} ({s})...\n", .{ esbuild_version, package_name });

    try runInherited(ctx, &[_][]const u8{ "curl", "-L", "--fail", "-o", tarball_path, url }, ctx.cottontail_home);
    try std.Io.Dir.cwd().createDirPath(ctx.io, extract_dir);
    try runInherited(ctx, &[_][]const u8{ "tar", "-xzf", tarball_path, "-C", extract_dir }, ctx.cottontail_home);

    const extracted_bin = try std.fs.path.join(ctx.allocator, &.{ extract_dir, "package", "bin", esbuildBinaryName() });
    try std.Io.Dir.copyFileAbsolute(extracted_bin, esbuild_bin, ctx.io, .{});
    if (builtin.os.tag != .windows) {
        try runInherited(ctx, &[_][]const u8{ "chmod", "+x", esbuild_bin }, ctx.cottontail_home);
    }

    std.Io.Dir.cwd().deleteFile(ctx.io, tarball_path) catch {};
    std.Io.Dir.cwd().deleteTree(ctx.io, extract_dir) catch {};
    try std.Io.Dir.cwd().writeFile(ctx.io, .{ .sub_path = version_file, .data = esbuild_version ++ "\n" });
}

fn esbuildBinaryPath(ctx: *const Context) ![]const u8 {
    return try std.fs.path.join(ctx.allocator, &.{ ctx.cottontail_home, "vendors", "esbuild", esbuildBinaryName() });
}

fn esbuildBinaryName() []const u8 {
    return if (builtin.os.tag == .windows) "esbuild.exe" else "esbuild";
}

fn esbuildPackageName() ![]const u8 {
    return switch (builtin.os.tag) {
        .macos => switch (builtin.cpu.arch) {
            .aarch64 => "darwin-arm64",
            .x86_64 => "darwin-x64",
            else => error.UnsupportedEsbuildPlatform,
        },
        .linux => switch (builtin.cpu.arch) {
            .aarch64 => "linux-arm64",
            .x86_64 => "linux-x64",
            else => error.UnsupportedEsbuildPlatform,
        },
        .windows => switch (builtin.cpu.arch) {
            .aarch64 => "win32-arm64",
            .x86_64 => "win32-x64",
            else => error.UnsupportedEsbuildPlatform,
        },
        else => error.UnsupportedEsbuildPlatform,
    };
}

fn esbuildTarballName() ![]const u8 {
    return switch (builtin.os.tag) {
        .windows => switch (builtin.cpu.arch) {
            .aarch64 => "win32-arm64",
            .x86_64 => "win32-x64",
            else => error.UnsupportedEsbuildPlatform,
        },
        else => try esbuildPackageName(),
    };
}

fn runInherited(ctx: *const Context, argv: []const []const u8, cwd: []const u8) !void {
    var child = try std.process.spawn(ctx.io, .{
        .argv = argv,
        .cwd = .{ .path = cwd },
        .stdin = .inherit,
        .stdout = .inherit,
        .stderr = .inherit,
        .create_no_window = true,
    });
    defer child.kill(ctx.io);

    const term = try child.wait(ctx.io);
    if (termExitCode(term) != 0) return error.ProcessFailed;
}

fn termExitCode(term: std.process.Child.Term) u8 {
    return switch (term) {
        .exited => |code| @intCast(@min(code, 255)),
        .signal => 1,
        .stopped => 1,
        .unknown => 1,
    };
}

const bun_shim_source =
    \\function shellEscape(value) {
    \\  const text = String(value);
    \\  if (/^[A-Za-z0-9_\/:.,=+@%-]+$/.test(text)) return text;
    \\  return "'" + text.replace(/'/g, "'\\''") + "'";
    \\}
    \\
    \\function interpolate(strings, values) {
    \\  let out = "";
    \\  for (let i = 0; i < strings.length; i++) {
    \\    out += strings[i];
    \\    if (i < values.length) {
    \\      const value = values[i];
    \\      if (Array.isArray(value)) out += value.map(shellEscape).join(" ");
    \\      else out += shellEscape(value);
    \\    }
    \\  }
    \\  return out;
    \\}
    \\
    \\function runShell(command, capture) {
    \\  const isWin = cottontail.platform() === "win32";
    \\  const file = isWin ? "cmd" : "sh";
    \\  const args = isWin ? ["/d", "/s", "/c", command] : ["-c", command];
    \\  const result = cottontail.spawnSync(file, args, { stdio: capture ? "pipe" : "inherit" });
    \\  const output = { exitCode: result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
    \\  if (result.status !== 0) {
    \\    const error = new Error(`Command failed (${result.status}): ${command}`);
    \\    error.exitCode = result.status;
    \\    error.stdout = output.stdout;
    \\    error.stderr = output.stderr;
    \\    throw error;
    \\  }
    \\  return output;
    \\}
    \\
    \\class ShellCommand {
    \\  constructor(command) {
    \\    this.command = command;
    \\    this.capture = false;
    \\    this.promise = null;
    \\  }
    \\  quiet() {
    \\    this.capture = true;
    \\    return this;
    \\  }
    \\  run(capture = this.capture) {
    \\    if (!this.promise || capture !== this.capture) {
    \\      this.promise = Promise.resolve().then(() => runShell(this.command, capture));
    \\    }
    \\    return this.promise;
    \\  }
    \\  text() {
    \\    return this.run(true).then((result) => result.stdout);
    \\  }
    \\  then(resolve, reject) {
    \\    return this.run().then(resolve, reject);
    \\  }
    \\  catch(reject) {
    \\    return this.run().catch(reject);
    \\  }
    \\}
    \\
    \\export function $(strings, ...values) {
    \\  return new ShellCommand(interpolate(strings, values));
    \\}
    \\
    \\function pathJoin(...parts) {
    \\  return parts.filter(Boolean).join("/").replace(/\/+/g, "/");
    \\}
    \\
    \\function bunBinary() {
    \\  const exe = cottontail.platform() === "win32" ? "bun.exe" : "bun";
    \\  const candidate = pathJoin(cottontail.cwd(), "vendors", "bun", exe);
    \\  return cottontail.existsSync(candidate) ? candidate : exe;
    \\}
    \\
    \\function ensureDir(path) {
    \\  cottontail.mkdirSync(path, true);
    \\}
    \\
    \\const bunBuildDriver = `
    \\const spec = await Bun.file(process.argv[2]).json();
    \\const result = await Bun.build(spec);
    \\const outputs = [];
    \\for (const output of result.outputs || []) {
    \\  outputs.push({ path: output.path || "", text: await output.text() });
    \\}
    \\console.log(JSON.stringify({ success: result.success !== false, logs: result.logs || [], outputs }));
    \\`;
    \\
    \\async function build(options) {
    \\  const tmp = pathJoin(cottontail.cwd(), ".cottontail-tmp", "bun-build");
    \\  ensureDir(tmp);
    \\  const id = `${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
    \\  const specPath = pathJoin(tmp, `build-${id}.json`);
    \\  const driverPath = pathJoin(tmp, "bun-build-driver.mjs");
    \\  cottontail.writeFile(specPath, JSON.stringify(options));
    \\  cottontail.writeFile(driverPath, bunBuildDriver);
    \\  const result = cottontail.spawnSync(bunBinary(), [driverPath, specPath], { stdio: "pipe" });
    \\  if (result.status !== 0) {
    \\    const error = new Error(result.stderr || result.stdout || "Bun.build failed");
    \\    error.exitCode = result.status;
    \\    throw error;
    \\  }
    \\  const parsed = JSON.parse(result.stdout);
    \\  return {
    \\    success: parsed.success,
    \\    logs: parsed.logs,
    \\    outputs: (parsed.outputs || []).map((output) => ({
    \\      path: output.path,
    \\      text: async () => output.text,
    \\    })),
    \\  };
    \\}
    \\
    \\if (!globalThis.setTimeout) {
    \\  globalThis.setTimeout = (fn, ms, ...args) => {
    \\    const seconds = Math.max(0, Number(ms) || 0) / 1000;
    \\    if (seconds > 0) cottontail.spawnSync("sleep", [String(seconds)], { stdio: "pipe" });
    \\    fn(...args);
    \\    return 0;
    \\  };
    \\}
    \\
    \\globalThis.Bun = {
    \\  argv: ["dash", "build.ts", ...(cottontail.args || [])],
    \\  build,
    \\};
    \\console.warn ||= console.error;
    \\console.info ||= console.log;
    \\console.debug ||= console.log;
    \\
    \\export { build };
    \\export default globalThis.Bun;
    \\
;

const fs_shim_source =
    \\function assertOk(result, action) {
    \\  if (result.status !== 0) throw new Error(`${action}: ${result.stderr || result.stdout}`);
    \\  return result;
    \\}
    \\
    \\function shellEscape(value) {
    \\  const text = String(value);
    \\  return "'" + text.replace(/'/g, "'\\''") + "'";
    \\}
    \\
    \\export function existsSync(path) {
    \\  return cottontail.existsSync(path);
    \\}
    \\
    \\export function readFileSync(path, encoding) {
    \\  const text = cottontail.readFile(path);
    \\  if (encoding) return text;
    \\  return { toString: () => text };
    \\}
    \\
    \\export function writeFileSync(path, data) {
    \\  cottontail.writeFile(path, String(data));
    \\}
    \\
    \\export function mkdirSync(path, options = {}) {
    \\  cottontail.mkdirSync(path, Boolean(options.recursive));
    \\}
    \\
    \\export function unlinkSync(path) {
    \\  cottontail.unlinkSync(path);
    \\}
    \\
    \\export function renameSync(oldPath, newPath) {
    \\  assertOk(cottontail.spawnSync("mv", [oldPath, newPath], { stdio: "pipe" }), "renameSync");
    \\}
    \\
    \\export function readdirSync(path, options = undefined) {
    \\  const result = assertOk(cottontail.spawnSync("ls", ["-A", path], { stdio: "pipe" }), "readdirSync");
    \\  const names = result.stdout.split("\\n").filter(Boolean);
    \\  if (!options || !options.withFileTypes) return names;
    \\  return names.map((name) => ({
    \\    name,
    \\    isDirectory: () => cottontail.spawnSync("sh", ["-c", `test -d ${shellEscape(path + "/" + name)}`], { stdio: "pipe" }).status === 0,
    \\    isFile: () => cottontail.spawnSync("sh", ["-c", `test -f ${shellEscape(path + "/" + name)}`], { stdio: "pipe" }).status === 0,
    \\  }));
    \\}
    \\
    \\export function statSync(path) {
    \\  const result = assertOk(cottontail.spawnSync("sh", ["-c", `wc -c < ${shellEscape(path)}`], { stdio: "pipe" }), "statSync");
    \\  return { size: Number(result.stdout.trim()) || 0 };
    \\}
    \\
;

const os_shim_source =
    \\export function platform() {
    \\  return cottontail.platform();
    \\}
    \\
    \\export function arch() {
    \\  return cottontail.arch();
    \\}
    \\
;

const process_shim_source =
    \\const process = {
    \\  argv: ["dash", "build.ts", ...(cottontail.args || [])],
    \\  env: cottontail.env(),
    \\  platform: cottontail.platform(),
    \\  arch: cottontail.arch(),
    \\  cwd: () => cottontail.cwd(),
    \\  exit: (code = 0) => cottontail.exit(code),
    \\};
    \\
    \\globalThis.process = process;
    \\export default process;
    \\
;

const path_shim_source =
    \\function normalize(path) {
    \\  const absolute = path.startsWith("/");
    \\  const parts = [];
    \\  for (const part of path.split("/")) {
    \\    if (!part || part === ".") continue;
    \\    if (part === "..") parts.pop();
    \\    else parts.push(part);
    \\  }
    \\  return (absolute ? "/" : "") + parts.join("/");
    \\}
    \\
    \\export function join(...parts) {
    \\  return normalize(parts.filter((part) => part !== "").join("/"));
    \\}
    \\
    \\export function resolve(...parts) {
    \\  let path = "";
    \\  for (const part of parts) {
    \\    if (!part) continue;
    \\    path = String(part).startsWith("/") ? String(part) : join(path || cottontail.cwd(), String(part));
    \\  }
    \\  return normalize(path || cottontail.cwd());
    \\}
    \\
    \\export function dirname(path) {
    \\  const normalized = normalize(String(path));
    \\  const index = normalized.lastIndexOf("/");
    \\  if (index <= 0) return normalized.startsWith("/") ? "/" : ".";
    \\  return normalized.slice(0, index);
    \\}
    \\
    \\export function basename(path) {
    \\  const normalized = normalize(String(path));
    \\  const index = normalized.lastIndexOf("/");
    \\  return index >= 0 ? normalized.slice(index + 1) : normalized;
    \\}
    \\
    \\export function relative(from, to) {
    \\  const fromParts = resolve(from).split("/").filter(Boolean);
    \\  const toParts = resolve(to).split("/").filter(Boolean);
    \\  while (fromParts.length && toParts.length && fromParts[0] === toParts[0]) {
    \\    fromParts.shift();
    \\    toParts.shift();
    \\  }
    \\  return [...fromParts.map(() => ".."), ...toParts].join("/") || ".";
    \\}
    \\
;

const util_shim_source =
    \\export function parseArgs(options = {}) {
    \\  const input = options.args || [];
    \\  const values = {};
    \\  const positionals = [];
    \\  for (let i = 0; i < input.length; i++) {
    \\    const arg = input[i];
    \\    if (arg.startsWith("--")) {
    \\      const eq = arg.indexOf("=");
    \\      const name = arg.slice(2, eq === -1 ? undefined : eq);
    \\      const spec = options.options?.[name] || {};
    \\      if (spec.type === "boolean") {
    \\        values[name] = eq === -1 ? true : arg.slice(eq + 1) !== "false";
    \\      } else if (eq !== -1) {
    \\        values[name] = arg.slice(eq + 1);
    \\      } else {
    \\        values[name] = input[++i];
    \\      }
    \\    } else if (options.allowPositionals) {
    \\      positionals.push(arg);
    \\    }
    \\  }
    \\  return { values, positionals };
    \\}
    \\
;
