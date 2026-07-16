const std = @import("std");
const builtin = @import("builtin");
const cottontail_compiler = @import("cottontail_compiler");
const cottontail_bundler = @import("cottontail_bundler.zig");
const cottontail_hash = @import("cottontail_hash.zig");
const cottontail_markdown = @import("cottontail_markdown.zig");
const cottontail_password = @import("cottontail_password.zig");
const cottontail_transpiler = @import("cottontail_transpiler.zig");
const host = @import("host.zig");
const script_runner = @import("script_runner.zig");

comptime {
    cottontail_bundler.forceLink();
    cottontail_hash.forceLink();
    cottontail_markdown.forceLink();
    cottontail_password.forceLink();
    cottontail_transpiler.forceLink();
    host.forceLink();
}

const version = @import("version.zig").version;
// Build-metadata suffix reported by `--revision` (`<version>+<suffix>`),
// mirroring how bun reports `<version>+<git sha>`.
const revision_suffix = "cottontail";
const completion_commands = [_][]const u8{ "run", "test", "build", "exec", "getcompletes" };
const help_text_template =
    \\cottontail {s}
    \\Tiny Zig-based JavaScript runtime.
    \\
    \\Usage:
    \\  cottontail <entrypoint.js|entrypoint.ts> [args...]
    \\  cottontail run <entrypoint.js|entrypoint.ts> [args...]
    \\  cottontail test [args...]
    \\  cottontail -e|--eval <script> [args...]
    \\  cottontail -p|--print <expression> [args...]
    \\  cottontail --help
    \\  cottontail --version
    \\
    \\Status:
    \\  JavaScriptCore is embedded with ESM imports, async job draining, and a small cottontail host API.
    \\  Entry points can be classic scripts, ESM modules, or TypeScript compiled natively.
    \\
;

fn printHelp(writer: anytype) !void {
    try writer.print(help_text_template, .{version});
}

const CliMode = enum { script, eval, print, stdin };

const RunScriptFlags = struct {
    if_present: bool = false,
    silent: bool = false,
};

const CliInvocation = struct {
    mode: CliMode,
    payload: [:0]const u8,
    args: []const [:0]const u8,
    exec_args: []const [:0]const u8,
    flags: RunScriptFlags = .{},
};

const CliParseError = error{
    MissingEntrypoint,
    MissingEvalSource,
    MissingPrintSource,
};

fn appendExecArg(exec_args: [][:0]const u8, exec_len: *usize, arg: [:0]const u8) void {
    exec_args[exec_len.*] = arg;
    exec_len.* += 1;
}

fn argAfterPrefix(allocator: std.mem.Allocator, arg: [:0]const u8, prefix: []const u8) ![:0]const u8 {
    return try allocator.dupeZ(u8, arg[prefix.len..]);
}

fn appendBunOptionsEnv(
    allocator: std.mem.Allocator,
    options: []const u8,
    args: *std.array_list.Managed([:0]const u8),
) !void {
    var index: usize = 0;
    while (index < options.len) {
        while (index < options.len and std.ascii.isWhitespace(options[index])) : (index += 1) {}
        if (index >= options.len) break;

        const start = index;
        var end = index;
        const is_option = end + 2 <= options.len and options[end] == '-' and options[end + 1] == '-';
        if (is_option) {
            while (end < options.len and !std.ascii.isWhitespace(options[end]) and options[end] != '=') : (end += 1) {}
            const end_of_flag = end;
            var has_equals = false;
            if (end < options.len and options[end] == '=') {
                has_equals = true;
                end += 1;
            } else if (end < options.len and std.ascii.isWhitespace(options[end])) {
                end += 1;
                while (end < options.len and std.ascii.isWhitespace(options[end])) : (end += 1) {}
            }

            if (end < options.len and (options[end] == '\'' or options[end] == '"')) {
                const quote = options[end];
                end += 1;
                while (end < options.len and options[end] != quote) : (end += 1) {}
                if (end < options.len) end += 1;
            } else if (has_equals) {
                while (end < options.len and !std.ascii.isWhitespace(options[end])) : (end += 1) {}
            } else {
                end = end_of_flag;
            }

            try args.append(try allocator.dupeZ(u8, options[start..end]));
            index = end;
            continue;
        }

        var token: std.ArrayList(u8) = .empty;
        var in_single = false;
        var in_double = false;
        var escaped = false;
        while (index < options.len) : (index += 1) {
            const byte = options[index];
            if (escaped) {
                try token.append(allocator, byte);
                escaped = false;
                continue;
            }
            if (byte == '\\') {
                escaped = true;
                continue;
            }
            if (in_single) {
                if (byte == '\'') in_single = false else try token.append(allocator, byte);
                continue;
            }
            if (in_double) {
                if (byte == '"') in_double = false else try token.append(allocator, byte);
                continue;
            }
            if (byte == '\'') {
                in_single = true;
            } else if (byte == '"') {
                in_double = true;
            } else if (std.ascii.isWhitespace(byte)) {
                break;
            } else {
                try token.append(allocator, byte);
            }
        }
        try token.append(allocator, 0);
        const owned = try token.toOwnedSlice(allocator);
        try args.append(owned[0 .. owned.len - 1 :0]);
    }
}

fn argsWithBunOptions(
    allocator: std.mem.Allocator,
    process_args: []const [:0]const u8,
    environ_map: *std.process.Environ.Map,
) ![]const [:0]const u8 {
    const options = environ_map.get("BUN_OPTIONS") orelse return process_args;
    if (options.len == 0) return process_args;

    var args = try std.array_list.Managed([:0]const u8).initCapacity(allocator, process_args.len + 4);
    try args.append(process_args[0]);
    try appendBunOptionsEnv(allocator, options, &args);
    try args.appendSlice(process_args[1..]);
    return try args.toOwnedSlice();
}

fn runCommandFlagTakesValue(arg: []const u8) bool {
    if (runtimeFlagTakesValue(arg)) return true;
    if (std.mem.indexOfScalar(u8, arg, '=') != null) return false;
    const value_flags = [_][]const u8{
        "--cwd",
        "--shell",
        "--elide-lines",
        "--filter",
        "--preload",
        "--port",
        "--define",
    };
    for (value_flags) |candidate| {
        if (std.mem.eql(u8, arg, candidate)) return true;
    }
    return false;
}

fn runtimeFlagTakesValue(arg: []const u8) bool {
    if (std.mem.indexOfScalar(u8, arg, '=') != null) return false;
    const value_flags = [_][]const u8{
        "-r",
        "--require",
        "--import",
        "--loader",
        "--experimental-loader",
        "--conditions",
        "--console-depth",
        "--cpu-prof-dir",
        "--cpu-prof-name",
        "--cpu-prof-interval",
        "--input-type",
        "--experimental-default-type",
        "--inspect-publish-uid",
        "--icu-data-dir",
        "--env-file",
        "--env-file-if-exists",
        "--tsconfig-override",
        "--diagnostic-dir",
        "--redirect-warnings",
        "--snapshot-blob",
        "--test-name-pattern",
        "--test-reporter",
        "--test-reporter-destination",
        "--test-shard",
    };
    for (value_flags) |candidate| {
        if (std.mem.eql(u8, arg, candidate)) return true;
    }
    return false;
}

fn isRuntimeFlag(arg: []const u8) bool {
    if (std.mem.eql(u8, arg, "-r")) return true;
    return std.mem.startsWith(u8, arg, "--");
}

fn testFlagTakesValue(arg: []const u8) bool {
    if (std.mem.indexOfScalar(u8, arg, '=') != null) return false;
    const value_flags = [_][]const u8{
        "-t",
        "--bail",
        "--coverage-dir",
        "--coverage-reporter",
        "--max-concurrency",
        "--preload",
        "--reporter",
        "--reporter-outfile",
        "--rerun-each",
        "--seed",
        "--test-name-pattern",
        "--timeout",
    };
    for (value_flags) |candidate| {
        if (std.mem.eql(u8, arg, candidate)) return true;
    }
    return false;
}

fn testEntrypointIndex(args: []const [:0]const u8) ?usize {
    var index: usize = 2;
    while (index < args.len) {
        const arg = args[index];
        if (!std.mem.startsWith(u8, arg, "-")) return index;
        index += if (testFlagTakesValue(arg) and index + 1 < args.len) 2 else 1;
    }
    return null;
}

fn resolveTestEntrypoint(io: std.Io, allocator: std.mem.Allocator, requested: [:0]const u8) ![:0]const u8 {
    std.Io.Dir.cwd().access(io, requested, .{}) catch {
        if (std.fs.path.extension(requested).len > 0) return requested;
        const directory = try std.Io.Dir.cwd().openDir(io, ".", .{ .iterate = true });
        defer directory.close(io);
        var iterator = directory.iterate();
        while (try iterator.next(io)) |entry| {
            if (entry.kind != .file or !isTestEntrypoint(entry.name)) continue;
            if (std.mem.startsWith(u8, entry.name, requested)) return try allocator.dupeZ(u8, entry.name);
        }
    };
    return requested;
}

fn testScriptArgs(
    allocator: std.mem.Allocator,
    args: []const [:0]const u8,
    entrypoint_index: usize,
) ![]const [:0]const u8 {
    const result = try allocator.alloc([:0]const u8, args.len - 3);
    var output_index: usize = 0;
    for (args[2..], 2..) |arg, index| {
        if (index == entrypoint_index) continue;
        result[output_index] = arg;
        output_index += 1;
    }
    return result;
}

fn testEntrypointMask(allocator: std.mem.Allocator, args: []const [:0]const u8) ![]bool {
    const mask = try allocator.alloc(bool, args.len);
    @memset(mask, false);
    var index: usize = 2;
    while (index < args.len) {
        const arg = args[index];
        if (std.mem.startsWith(u8, arg, "-")) {
            index += if (testFlagTakesValue(arg) and index + 1 < args.len) 2 else 1;
            continue;
        }
        mask[index] = true;
        index += 1;
    }
    return mask;
}

fn childExitCode(term: std.process.Child.Term) u8 {
    return switch (term) {
        .exited => |code| @intCast(@min(code, 255)),
        .signal, .stopped, .unknown => 1,
    };
}

fn isBunShellScript(path: []const u8) bool {
    return std.mem.endsWith(u8, path, ".sh");
}

fn cliPathExists(io: std.Io, path: []const u8) bool {
    if (std.fs.path.isAbsolute(path)) {
        std.Io.Dir.accessAbsolute(io, path, .{}) catch return false;
        return true;
    }
    std.Io.Dir.cwd().access(io, path, .{}) catch return false;
    return true;
}

const PackageScripts = struct {
    dir: []const u8,
    pre: ?[]const u8,
    main: []const u8,
    post: ?[]const u8,
    name: []const u8,
};

fn jsonScriptValue(scripts: std.json.Value, name: []const u8) ?[]const u8 {
    const value = scripts.object.get(name) orelse return null;
    return switch (value) {
        .string => |text| text,
        else => null,
    };
}

fn findPackageScripts(
    io: std.Io,
    allocator: std.mem.Allocator,
    name: []const u8,
) !?PackageScripts {
    const cwd_abs = std.Io.Dir.cwd().realPathFileAlloc(io, ".", allocator) catch return null;
    const package_json = try std.fs.path.join(allocator, &.{ cwd_abs, "package.json" });
    if (!cliPathExists(io, package_json)) return null;
    const source = std.Io.Dir.cwd().readFileAlloc(
        io,
        package_json,
        allocator,
        .limited(16 * 1024 * 1024),
    ) catch return null;
    const parsed = std.json.parseFromSlice(std.json.Value, allocator, source, .{}) catch return null;
    const root = parsed.value;
    if (root != .object) return null;
    const scripts = root.object.get("scripts") orelse return null;
    if (scripts != .object) return null;
    const main_command = jsonScriptValue(scripts, name) orelse return null;
    const pre_name = try std.mem.concat(allocator, u8, &.{ "pre", name });
    const post_name = try std.mem.concat(allocator, u8, &.{ "post", name });
    return .{
        .dir = try allocator.dupe(u8, cwd_abs),
        .pre = jsonScriptValue(scripts, pre_name),
        .main = try allocator.dupe(u8, main_command),
        .post = jsonScriptValue(scripts, post_name),
        .name = name,
    };
}

fn shellEscapeArg(allocator: std.mem.Allocator, arg: []const u8) ![]const u8 {
    var plain = arg.len > 0;
    for (arg) |byte| {
        const safe = std.ascii.isAlphanumeric(byte) or switch (byte) {
            '-', '_', '.', '/', ':', '=', '@', '%', '+', ',' => true,
            else => false,
        };
        if (!safe) {
            plain = false;
            break;
        }
    }
    if (plain) return arg;
    var buffer = std.array_list.Managed(u8).init(allocator);
    try buffer.append('\'');
    for (arg) |byte| {
        if (byte == '\'') {
            try buffer.appendSlice("'\\''");
        } else {
            try buffer.append(byte);
        }
    }
    try buffer.append('\'');
    return buffer.items;
}

fn runOnePackageScript(
    init: std.process.Init,
    env: *std.process.Environ.Map,
    dir: []const u8,
    stage_name: []const u8,
    command: []const u8,
    silent: bool,
) !u8 {
    try env.put("npm_lifecycle_event", stage_name);
    try env.put("npm_lifecycle_script", command);
    if (!silent) {
        var stderr_buffer: [4096]u8 = undefined;
        var stderr_writer = std.Io.File.stderr().writer(init.io, &stderr_buffer);
        const stderr = &stderr_writer.interface;
        try stderr.print("$ {s}\n", .{command});
        try stderr.flush();
    }
    var child = try std.process.spawn(init.io, .{
        .argv = &.{ "/bin/sh", "-c", command },
        .cwd = .{ .path = dir },
        .environ_map = env,
        .stdin = .inherit,
        .stdout = .inherit,
        .stderr = .inherit,
        .create_no_window = true,
    });
    defer child.kill(init.io);
    return childExitCode(try child.wait(init.io));
}

fn runPackageScripts(
    init: std.process.Init,
    pkg: PackageScripts,
    flags: RunScriptFlags,
    extra_args: []const [:0]const u8,
) !u8 {
    const allocator = init.arena.allocator();
    var env = try init.environ_map.clone(allocator);

    const bin_dir = try std.fs.path.join(allocator, &.{ pkg.dir, "node_modules", ".bin" });
    const separator: u8 = if (builtin.os.tag == .windows) ';' else ':';
    const old_path = env.get("PATH") orelse "";
    const new_path = try std.fmt.allocPrint(allocator, "{s}{c}{s}", .{ bin_dir, separator, old_path });
    try env.put("PATH", new_path);

    if (pkg.pre) |pre_command| {
        const code = try runOnePackageScript(init, &env, pkg.dir, try std.mem.concat(allocator, u8, &.{ "pre", pkg.name }), pre_command, flags.silent);
        if (code != 0) return code;
    }

    var main_command: []const u8 = pkg.main;
    if (extra_args.len > 0) {
        var buffer = std.array_list.Managed(u8).init(allocator);
        try buffer.appendSlice(pkg.main);
        for (extra_args) |extra| {
            try buffer.append(' ');
            try buffer.appendSlice(try shellEscapeArg(allocator, extra));
        }
        main_command = buffer.items;
    }
    const main_code = try runOnePackageScript(init, &env, pkg.dir, pkg.name, main_command, flags.silent);
    if (main_code != 0) return main_code;

    if (pkg.post) |post_command| {
        const code = try runOnePackageScript(init, &env, pkg.dir, try std.mem.concat(allocator, u8, &.{ "post", pkg.name }), post_command, flags.silent);
        if (code != 0) return code;
    }
    return 0;
}

const fake_node_extensions = [_][]const u8{ ".tsx", ".jsx", ".mts", ".ts", ".cts", ".js", ".mjs", ".cjs" };

fn pathIsFile(io: std.Io, path: []const u8) bool {
    const stat = std.Io.Dir.cwd().statFile(io, path, .{}) catch return false;
    return stat.kind == .file;
}

fn resolveFakeNodeEntry(io: std.Io, allocator: std.mem.Allocator, entry: []const u8) !?[:0]const u8 {
    if (pathIsFile(io, entry)) return try allocator.dupeZ(u8, entry);
    for (fake_node_extensions) |extension| {
        const candidate = try std.mem.concat(allocator, u8, &.{ entry, extension });
        if (pathIsFile(io, candidate)) return try allocator.dupeZ(u8, candidate);
    }
    return null;
}

fn runFakeNode(init: std.process.Init, node_args: []const [:0]const u8) !u8 {
    const allocator = init.arena.allocator();
    const io = init.io;

    var stderr_buffer: [1024]u8 = undefined;
    var stderr_writer = std.Io.File.stderr().writer(io, &stderr_buffer);
    const stderr = &stderr_writer.interface;

    const empty_exec_args: [0][:0]const u8 = .{};
    var index: usize = 0;
    while (index < node_args.len) {
        const arg = node_args[index];
        if (std.mem.eql(u8, arg, "-e") or std.mem.eql(u8, arg, "--eval")) {
            if (index + 1 >= node_args.len) {
                try stderr.print("cottontail: -e requires an argument\n", .{});
                try stderr.flush();
                return 9;
            }
            return try script_runner.runEval(init, node_args[index + 1], node_args[index + 2 ..], empty_exec_args[0..], false);
        }
        if (std.mem.eql(u8, arg, "-p") or std.mem.eql(u8, arg, "--print")) {
            if (index + 1 >= node_args.len) {
                try stderr.print("cottontail: -p requires an argument\n", .{});
                try stderr.flush();
                return 9;
            }
            return try script_runner.runEval(init, node_args[index + 1], node_args[index + 2 ..], empty_exec_args[0..], true);
        }
        if (std.mem.startsWith(u8, arg, "-") and arg.len > 1) {
            index += if (runtimeFlagTakesValue(arg) and index + 1 < node_args.len) 2 else 1;
            continue;
        }

        const entry = arg;
        const resolved = (try resolveFakeNodeEntry(io, allocator, entry)) orelse {
            try stderr.print("error: Cannot find module \"{s}\"\n", .{entry});
            try stderr.flush();
            return 1;
        };
        const display = blk: {
            if (std.fs.path.isAbsolute(entry)) break :blk try allocator.dupeZ(u8, entry);
            const cwd_abs = std.Io.Dir.cwd().realPathFileAlloc(io, ".", allocator) catch break :blk try allocator.dupeZ(u8, entry);
            break :blk try allocator.dupeZ(u8, try std.fs.path.join(allocator, &.{ cwd_abs, entry }));
        };
        return try script_runner.runWithExecArgvDisplay(init, resolved, display, node_args[index + 1 ..], empty_exec_args[0..]);
    }

    try stderr.print("cottontail: the node REPL is not supported\n", .{});
    try stderr.flush();
    return 1;
}

fn writeBuildFile(io: std.Io, path: []const u8, contents: []const u8) !void {
    if (std.fs.path.dirname(path)) |parent| {
        if (parent.len > 0) try std.Io.Dir.cwd().createDirPath(io, parent);
    }
    try std.Io.Dir.cwd().writeFile(io, .{ .sub_path = path, .data = contents });
}

const standalone_magic = "COTTONTAIL-STAND";
const standalone_trailer_len = @sizeOf(u64) + standalone_magic.len;

fn loadStandaloneSource(init: std.process.Init) !?[]const u8 {
    const allocator = init.arena.allocator();
    const executable_path = try std.process.executablePathAlloc(init.io, allocator);
    const executable = try std.Io.Dir.cwd().openFile(init.io, executable_path, .{});
    defer executable.close(init.io);
    const executable_len = try executable.length(init.io);
    if (executable_len < standalone_trailer_len) return null;

    var trailer: [standalone_trailer_len]u8 = undefined;
    const trailer_offset = executable_len - standalone_trailer_len;
    if (try executable.readPositionalAll(init.io, &trailer, trailer_offset) != trailer.len) return null;
    if (!std.mem.eql(u8, trailer[@sizeOf(u64)..], standalone_magic)) return null;

    const source_len = std.mem.readInt(u64, trailer[0..@sizeOf(u64)], .little);
    if (source_len > trailer_offset or source_len > 512 * 1024 * 1024) return error.InvalidStandaloneExecutable;
    const source = try allocator.alloc(u8, @intCast(source_len));
    const source_offset = trailer_offset - source_len;
    if (try executable.readPositionalAll(init.io, source, source_offset) != source.len) return error.InvalidStandaloneExecutable;
    return source;
}

fn writeStandaloneExecutable(init: std.process.Init, output_path: []const u8, source: []const u8) !void {
    const executable_path = try std.process.executablePathAlloc(init.io, init.arena.allocator());
    try std.Io.Dir.copyFile(
        std.Io.Dir.cwd(),
        executable_path,
        std.Io.Dir.cwd(),
        output_path,
        init.io,
        .{ .make_path = true },
    );

    const output = try std.Io.Dir.cwd().openFile(init.io, output_path, .{ .mode = .read_write });
    defer output.close(init.io);
    const executable_len = try output.length(init.io);
    try output.writePositionalAll(init.io, source, executable_len);
    var trailer: [standalone_trailer_len]u8 = undefined;
    std.mem.writeInt(u64, trailer[0..@sizeOf(u64)], @intCast(source.len), .little);
    @memcpy(trailer[@sizeOf(u64)..], standalone_magic);
    try output.writePositionalAll(init.io, &trailer, executable_len + source.len);
}

fn runStandaloneIfPresent(
    init: std.process.Init,
    args: []const [:0]const u8,
) !?u8 {
    const source = (try loadStandaloneSource(init)) orelse return null;
    const allocator = init.arena.allocator();
    var exec_args = try allocator.alloc([:0]const u8, args.len);
    var exec_len: usize = 0;
    var script_start = args.len;
    var index: usize = 1;
    while (index < args.len) {
        const arg = args[index];
        if (std.mem.eql(u8, arg, "--")) {
            script_start = index + 1;
            break;
        }
        if (!isRuntimeFlag(arg)) {
            script_start = index;
            break;
        }
        exec_args[exec_len] = arg;
        exec_len += 1;
        if (runtimeFlagTakesValue(arg) and index + 1 < args.len) {
            index += 1;
            exec_args[exec_len] = args[index];
            exec_len += 1;
        }
        index += 1;
    }
    return try script_runner.runEmbedded(
        init,
        args[0],
        source,
        args[script_start..],
        exec_args[0..exec_len],
    );
}

fn nativeBuild(init: std.process.Init, args: []const [:0]const u8) !u8 {
    const allocator = init.arena.allocator();
    var stdout_buffer: [1024]u8 = undefined;
    var stdout_writer = std.Io.File.stdout().writer(init.io, &stdout_buffer);
    const stdout = &stdout_writer.interface;
    var stderr_buffer: [1024]u8 = undefined;
    var stderr_writer = std.Io.File.stderr().writer(init.io, &stderr_buffer);
    const stderr = &stderr_writer.interface;

    var options: cottontail_bundler.BundleOptions = .{ .target = .browser };
    if (init.environ_map.get("NODE_ENV")) |node_env| {
        options.production = std.ascii.eqlIgnoreCase(node_env, "production");
    }
    var entries: std.ArrayList([]const u8) = .empty;
    var external: std.ArrayList([]const u8) = .empty;
    var drop: std.ArrayList([]const u8) = .empty;
    var conditions: std.ArrayList([]const u8) = .empty;
    var define_keys: std.ArrayList([]const u8) = .empty;
    var define_values: std.ArrayList([]const u8) = .empty;
    var outdir: ?[]const u8 = null;
    var outfile: ?[]const u8 = null;
    var metafile_json_path: ?[]const u8 = null;
    var metafile_markdown_path: ?[]const u8 = null;
    var compile = false;
    var index: usize = 2;
    while (index < args.len) : (index += 1) {
        const arg: []const u8 = args[index];
        if (std.mem.eql(u8, arg, "--compile")) {
            compile = true;
        } else if (std.mem.eql(u8, arg, "--no-bundle")) {
            options.transform_only = true;
        } else if (std.mem.eql(u8, arg, "--bytecode")) {
            options.bytecode = true;
        } else if (std.mem.eql(u8, arg, "--production")) {
            options.production = true;
            options.minify_whitespace = true;
            options.minify_identifiers = true;
            options.minify_syntax = true;
        } else if (std.mem.eql(u8, arg, "--minify")) {
            options.minify_whitespace = true;
            options.minify_identifiers = true;
            options.minify_syntax = true;
        } else if (std.mem.eql(u8, arg, "--minify-whitespace")) {
            options.minify_whitespace = true;
        } else if (std.mem.eql(u8, arg, "--minify-identifiers")) {
            options.minify_identifiers = true;
        } else if (std.mem.eql(u8, arg, "--minify-syntax")) {
            options.minify_syntax = true;
        } else if (std.mem.eql(u8, arg, "--ignore-dce-annotations")) {
            options.ignore_dce_annotations = true;
        } else if (std.mem.eql(u8, arg, "--emit-dce-annotations")) {
            options.emit_dce_annotations = true;
        } else if (std.mem.startsWith(u8, arg, "--jsx-runtime=")) {
            const runtime = arg["--jsx-runtime=".len..];
            options.jsx_runtime = if (std.ascii.eqlIgnoreCase(runtime, "classic"))
                .classic
            else if (std.ascii.eqlIgnoreCase(runtime, "automatic"))
                .automatic
            else {
                try stderr.print("error: invalid JSX runtime \"{s}\"\n", .{runtime});
                try stderr.flush();
                return 1;
            };
        } else if (std.mem.eql(u8, arg, "--jsx-runtime") and index + 1 < args.len) {
            index += 1;
            const runtime: []const u8 = args[index];
            options.jsx_runtime = if (std.ascii.eqlIgnoreCase(runtime, "classic"))
                .classic
            else if (std.ascii.eqlIgnoreCase(runtime, "automatic"))
                .automatic
            else {
                try stderr.print("error: invalid JSX runtime \"{s}\"\n", .{runtime});
                try stderr.flush();
                return 1;
            };
        } else if (std.mem.startsWith(u8, arg, "--jsx-factory=")) {
            options.jsx_factory = arg["--jsx-factory=".len..];
        } else if (std.mem.eql(u8, arg, "--jsx-factory") and index + 1 < args.len) {
            index += 1;
            options.jsx_factory = args[index];
        } else if (std.mem.startsWith(u8, arg, "--jsx-fragment=")) {
            options.jsx_fragment = arg["--jsx-fragment=".len..];
        } else if (std.mem.eql(u8, arg, "--jsx-fragment") and index + 1 < args.len) {
            index += 1;
            options.jsx_fragment = args[index];
        } else if (std.mem.startsWith(u8, arg, "--jsx-import-source=")) {
            options.jsx_import_source = arg["--jsx-import-source=".len..];
        } else if (std.mem.eql(u8, arg, "--jsx-import-source") and index + 1 < args.len) {
            index += 1;
            options.jsx_import_source = args[index];
        } else if (std.mem.eql(u8, arg, "--jsx-side-effects")) {
            options.jsx_side_effects = true;
        } else if (std.mem.eql(u8, arg, "--jsx-dev")) {
            options.jsx_development = true;
        } else if (std.mem.eql(u8, arg, "--packages=external")) {
            options.external_packages = true;
        } else if (std.mem.eql(u8, arg, "--packages") and index + 1 < args.len) {
            index += 1;
            options.external_packages = std.mem.eql(u8, args[index], "external");
        } else if (std.mem.startsWith(u8, arg, "--conditions=")) {
            var iterator = std.mem.splitScalar(u8, arg["--conditions=".len..], ',');
            while (iterator.next()) |condition| {
                if (condition.len > 0) try conditions.append(allocator, condition);
            }
        } else if (std.mem.eql(u8, arg, "--conditions") and index + 1 < args.len) {
            index += 1;
            try conditions.append(allocator, args[index]);
        } else if (std.mem.startsWith(u8, arg, "--define=") or std.mem.startsWith(u8, arg, "--define:")) {
            const prefix_len = if (std.mem.startsWith(u8, arg, "--define=")) "--define=".len else "--define:".len;
            const define = arg[prefix_len..];
            const equals = std.mem.indexOfScalar(u8, define, '=') orelse {
                try stderr.print("error: invalid define \"{s}\", expected key=value\n", .{define});
                try stderr.flush();
                return 1;
            };
            try define_keys.append(allocator, define[0..equals]);
            try define_values.append(allocator, define[equals + 1 ..]);
        } else if (std.mem.eql(u8, arg, "--define") and index + 1 < args.len) {
            index += 1;
            const define: []const u8 = args[index];
            const equals = std.mem.indexOfScalar(u8, define, '=') orelse {
                try stderr.print("error: invalid define \"{s}\", expected key=value\n", .{define});
                try stderr.flush();
                return 1;
            };
            try define_keys.append(allocator, define[0..equals]);
            try define_values.append(allocator, define[equals + 1 ..]);
        } else if (std.mem.startsWith(u8, arg, "--drop=")) {
            try drop.append(allocator, arg["--drop=".len..]);
        } else if (std.mem.eql(u8, arg, "--drop") and index + 1 < args.len) {
            index += 1;
            try drop.append(allocator, args[index]);
        } else if (std.mem.startsWith(u8, arg, "--env=")) {
            const env = arg["--env=".len..];
            if (std.mem.eql(u8, env, "inline") or std.mem.eql(u8, env, "1")) {
                options.env_behavior = .load_all;
            } else if (std.mem.eql(u8, env, "disable") or std.mem.eql(u8, env, "0")) {
                options.env_behavior = .load_all_without_inlining;
            } else if (std.mem.indexOfScalar(u8, env, '*')) |asterisk| {
                options.env_behavior = if (asterisk == 0) .load_all else .prefix;
                options.env_prefix = env[0..asterisk];
            } else {
                try stderr.writeAll("error: --env must be 'inline', 'disable', or a prefix ending in '*\n");
                try stderr.flush();
                return 1;
            }
        } else if (std.mem.eql(u8, arg, "--env") and index + 1 < args.len) {
            index += 1;
            const env: []const u8 = args[index];
            if (std.mem.eql(u8, env, "inline") or std.mem.eql(u8, env, "1")) {
                options.env_behavior = .load_all;
            } else if (std.mem.eql(u8, env, "disable") or std.mem.eql(u8, env, "0")) {
                options.env_behavior = .load_all_without_inlining;
            } else if (std.mem.indexOfScalar(u8, env, '*')) |asterisk| {
                options.env_behavior = if (asterisk == 0) .load_all else .prefix;
                options.env_prefix = env[0..asterisk];
            } else {
                try stderr.writeAll("error: --env must be 'inline', 'disable', or a prefix ending in '*\n");
                try stderr.flush();
                return 1;
            }
        } else if (std.mem.eql(u8, arg, "--splitting")) {
            options.code_splitting = true;
        } else if (std.mem.eql(u8, arg, "--metafile")) {
            metafile_json_path = "meta.json";
        } else if (std.mem.startsWith(u8, arg, "--metafile=")) {
            metafile_json_path = arg["--metafile=".len..];
        } else if (std.mem.eql(u8, arg, "--metafile-md")) {
            metafile_markdown_path = "meta.md";
        } else if (std.mem.startsWith(u8, arg, "--metafile-md=")) {
            metafile_markdown_path = arg["--metafile-md=".len..];
        } else if (std.mem.startsWith(u8, arg, "--external=")) {
            try external.append(allocator, arg["--external=".len..]);
        } else if (std.mem.eql(u8, arg, "--external") and index + 1 < args.len) {
            index += 1;
            try external.append(allocator, args[index]);
        } else if (std.mem.startsWith(u8, arg, "--outdir=")) {
            outdir = arg["--outdir=".len..];
        } else if (std.mem.eql(u8, arg, "--outdir") and index + 1 < args.len) {
            index += 1;
            outdir = args[index];
        } else if (std.mem.startsWith(u8, arg, "--outfile=")) {
            outfile = arg["--outfile=".len..];
        } else if (std.mem.eql(u8, arg, "--outfile") and index + 1 < args.len) {
            index += 1;
            outfile = args[index];
        } else if (std.mem.startsWith(u8, arg, "--banner=")) {
            options.banner = arg["--banner=".len..];
        } else if (std.mem.eql(u8, arg, "--banner") and index + 1 < args.len) {
            index += 1;
            options.banner = args[index];
        } else if (std.mem.startsWith(u8, arg, "--footer=")) {
            options.footer = arg["--footer=".len..];
        } else if (std.mem.eql(u8, arg, "--footer") and index + 1 < args.len) {
            index += 1;
            options.footer = args[index];
        } else if (std.mem.startsWith(u8, arg, "--public-path=")) {
            options.public_path = arg["--public-path=".len..];
        } else if (std.mem.eql(u8, arg, "--public-path") and index + 1 < args.len) {
            index += 1;
            options.public_path = args[index];
        } else if (std.mem.startsWith(u8, arg, "--entry-naming=")) {
            options.entry_naming = arg["--entry-naming=".len..];
        } else if (std.mem.eql(u8, arg, "--entry-naming") and index + 1 < args.len) {
            index += 1;
            options.entry_naming = args[index];
        } else if (std.mem.startsWith(u8, arg, "--chunk-naming=")) {
            options.chunk_naming = arg["--chunk-naming=".len..];
        } else if (std.mem.eql(u8, arg, "--chunk-naming") and index + 1 < args.len) {
            index += 1;
            options.chunk_naming = args[index];
        } else if (std.mem.startsWith(u8, arg, "--asset-naming=")) {
            options.asset_naming = arg["--asset-naming=".len..];
        } else if (std.mem.eql(u8, arg, "--asset-naming") and index + 1 < args.len) {
            index += 1;
            options.asset_naming = args[index];
        } else if (std.mem.startsWith(u8, arg, "--format=")) {
            options.output_format = cottontail_compiler.options.Format.fromString(arg["--format=".len..]) orelse {
                try stderr.print("error: invalid build format \"{s}\"\n", .{arg["--format=".len..]});
                try stderr.flush();
                return 1;
            };
        } else if (std.mem.startsWith(u8, arg, "--target=")) {
            const target = arg["--target=".len..];
            options.target = if (std.mem.eql(u8, target, "browser"))
                .browser
            else if (std.mem.eql(u8, target, "node"))
                .node
            else if (std.mem.eql(u8, target, "bun"))
                .bun
            else {
                try stderr.print("error: invalid build target \"{s}\"\n", .{target});
                try stderr.flush();
                return 1;
            };
        } else if (std.mem.eql(u8, arg, "--sourcemap") or std.mem.eql(u8, arg, "--sourcemap=linked")) {
            options.source_map = .linked;
        } else if (std.mem.eql(u8, arg, "--sourcemap=inline")) {
            options.source_map = .@"inline";
        } else if (std.mem.eql(u8, arg, "--sourcemap=external")) {
            options.source_map = .external;
        } else if (std.mem.startsWith(u8, arg, "-")) {
            try stderr.print("error: unsupported cottontail build option \"{s}\"\n", .{arg});
            try stderr.flush();
            return 1;
        } else {
            try entries.append(allocator, arg);
        }
    }

    if (entries.items.len == 0) {
        try stderr.print("error: cottontail build requires at least one entrypoint\n", .{});
        try stderr.flush();
        return 1;
    }
    if (outfile != null and entries.items.len != 1) {
        try stderr.print("error: --outfile requires exactly one entrypoint\n", .{});
        try stderr.flush();
        return 1;
    }

    options.external = external.items;
    options.drop = drop.items;
    options.conditions = conditions.items;
    options.define_keys = define_keys.items;
    options.define_values = define_values.items;
    if (options.bytecode) {
        try stderr.writeAll("error: Bun build bytecode requires a JavaScriptCore cached-bytecode API\n");
        try stderr.flush();
        return 1;
    }
    if (compile) {
        if (entries.items.len != 1) {
            try stderr.print("error: --compile requires exactly one entrypoint\n", .{});
            try stderr.flush();
            return 1;
        }
        options.target = .bun;
        options.output_format = .esm;
        const entry_z = try allocator.dupeZ(u8, entries.items[0]);
        const source = script_runner.compileStandaloneSource(init, entry_z, options) catch |err| {
            try stderr.print("error: standalone build failed: {s}\n", .{@errorName(err)});
            try stderr.flush();
            return 1;
        };
        const default_basename = std.fs.path.stem(entries.items[0]);
        const default_name = if (builtin.os.tag == .windows)
            try std.fmt.allocPrint(allocator, "{s}.exe", .{default_basename})
        else
            default_basename;
        const destination = outfile orelse default_name;
        try writeStandaloneExecutable(init, destination, source);
        try stdout.print("{s}\n", .{destination});
        try stdout.flush();
        return 0;
    }

    const cwd_abs = try std.Io.Dir.cwd().realPathFileAlloc(init.io, ".", allocator);
    for (entries.items) |entry| {
        const entry_abs = if (std.fs.path.isAbsolute(entry)) entry else try std.fs.path.join(allocator, &.{ cwd_abs, entry });
        std.Io.Dir.cwd().access(init.io, entry_abs, .{}) catch {
            try stderr.print("error: Module not found \"{s}\"\n", .{entry});
            try stderr.flush();
            return 1;
        };
    }

    const MetafileRequest = struct { json: []const u8, markdown: []const u8 };
    const MinifyRequest = struct { whitespace: bool, identifiers: bool, syntax: bool };
    const JsxRequest = struct {
        runtime: ?[]const u8,
        factory: ?[]const u8,
        fragment: ?[]const u8,
        importSource: ?[]const u8,
        development: ?bool,
        sideEffects: ?bool,
    };
    const NamingRequest = struct { entry: []const u8, chunk: []const u8, asset: []const u8 };
    const env_option: ?[]const u8 = switch (options.env_behavior) {
        .load_all => "inline",
        .load_all_without_inlining => "disable",
        .prefix => try std.mem.concat(allocator, u8, &.{ options.env_prefix, "*" }),
        else => null,
    };
    var define_object: std.json.ObjectMap = .{};
    for (options.define_keys, options.define_values) |key, value| {
        try define_object.put(allocator, key, .{ .string = value });
    }
    const request = .{
        .entrypoints = entries.items,
        .target = @tagName(options.target),
        .format = @tagName(options.output_format),
        .sourcemap = @tagName(options.source_map),
        .packages = if (options.external_packages) "external" else "bundle",
        .external = options.external,
        .drop = options.drop,
        .publicPath = options.public_path,
        .bundle = !options.transform_only,
        .env = env_option,
        .naming = NamingRequest{
            .entry = if (outfile) |path| std.fs.path.basename(path) else options.entry_naming,
            .chunk = options.chunk_naming,
            .asset = options.asset_naming,
        },
        .conditions = options.conditions,
        .define = std.json.Value{ .object = define_object },
        .splitting = options.code_splitting,
        .banner = options.banner,
        .footer = options.footer,
        .bytecode = options.bytecode,
        .ignoreDCEAnnotations = options.ignore_dce_annotations,
        .emitDCEAnnotations = options.emit_dce_annotations,
        .minify = MinifyRequest{
            .whitespace = options.minify_whitespace,
            .identifiers = options.minify_identifiers,
            .syntax = options.minify_syntax,
        },
        .production = options.production,
        .jsx = JsxRequest{
            .runtime = if (options.jsx_runtime) |runtime| @tagName(runtime) else null,
            .factory = options.jsx_factory,
            .fragment = options.jsx_fragment,
            .importSource = options.jsx_import_source,
            .development = options.jsx_development,
            .sideEffects = options.jsx_side_effects,
        },
        .metafile = if (metafile_json_path != null or metafile_markdown_path != null)
            MetafileRequest{
                .json = metafile_json_path orelse "",
                .markdown = metafile_markdown_path orelse "",
            }
        else
            null,
    };
    const request_json = try std.json.Stringify.valueAlloc(allocator, request, .{});
    var error_message: ?[*:0]u8 = null;
    const result_json = cottontail_bundler.buildEntryPointsJson(request_json, cwd_abs, &error_message) catch |err| {
        if (error_message) |message| {
            defer cottontail_bundler.ct_bundle_string_free(message);
            try stderr.print("error: {s}\n", .{std.mem.span(message)});
        } else {
            try stderr.print("error: build failed: {s}\n", .{@errorName(err)});
        }
        try stderr.flush();
        return 1;
    };
    defer cottontail_bundler.ct_bundle_free(result_json.ptr, result_json.len);

    const parsed = try std.json.parseFromSlice(std.json.Value, allocator, result_json, .{});
    const result = parsed.value.object;
    if (result.get("success")) |success| {
        if (success == .bool and !success.bool) {
            if (result.get("logs")) |logs| {
                if (logs == .array) for (logs.array.items) |log| {
                    if (log == .object) {
                        if (log.object.get("message")) |message| {
                            if (message == .string) try stderr.print("error: {s}\n", .{message.string});
                        }
                    }
                };
            }
            try stderr.flush();
            return 1;
        }
    }

    if (result.get("outputs")) |outputs| {
        if (outputs == .array) for (outputs.array.items) |output| {
            if (output != .object) continue;
            const path_value = output.object.get("path") orelse continue;
            const b64_value = output.object.get("b64") orelse continue;
            if (path_value != .string or b64_value != .string) continue;
            const decoded_len = try std.base64.standard.Decoder.calcSizeForSlice(b64_value.string);
            const decoded = try allocator.alloc(u8, decoded_len);
            try std.base64.standard.Decoder.decode(decoded, b64_value.string);

            const output_kind = output.object.get("kind");
            const is_entry = output_kind != null and output_kind.? == .string and std.mem.eql(u8, output_kind.?.string, "entry-point");
            const relative_path = if (std.mem.startsWith(u8, path_value.string, "./")) path_value.string[2..] else path_value.string;
            const destination = if (outfile != null and is_entry)
                outfile
            else if (outdir) |dir|
                try std.fs.path.join(allocator, &.{ dir, relative_path })
            else if (outfile) |path|
                try std.fs.path.join(allocator, &.{ std.fs.path.dirname(path) orelse ".", relative_path })
            else
                null;
            if (destination) |path| {
                try writeBuildFile(init.io, path, decoded);
                try stdout.print("{s}\n", .{path});
            } else if (is_entry) {
                try stdout.writeAll(decoded);
                if (decoded.len == 0 or decoded[decoded.len - 1] != '\n') try stdout.writeByte('\n');
            }
        };
    }

    if (metafile_json_path) |path| {
        if (result.get("metafile")) |metafile| {
            if (metafile == .string) try writeBuildFile(init.io, path, metafile.string);
        }
    }
    if (metafile_markdown_path) |path| {
        if (result.get("metafileMarkdown")) |metafile| {
            if (metafile == .string) try writeBuildFile(init.io, path, metafile.string);
        }
    }
    try stdout.flush();
    return 0;
}

fn runBunShellScript(init: std.process.Init, script_path: [:0]const u8, script_args: []const [:0]const u8) !u8 {
    const allocator = init.arena.allocator();
    const argv = try allocator.alloc([]const u8, script_args.len + 2);
    argv[0] = "sh";
    argv[1] = script_path;
    for (script_args, 0..) |arg, index| {
        argv[index + 2] = arg;
    }
    var child = try std.process.spawn(init.io, .{
        .argv = argv,
        .stdin = .inherit,
        .stdout = .inherit,
        .stderr = .inherit,
        .create_no_window = true,
    });
    defer child.kill(init.io);
    return childExitCode(try child.wait(init.io));
}

fn runMultipleTestFiles(init: std.process.Init, args: []const [:0]const u8) !?u8 {
    if (args.len < 2 or !std.mem.eql(u8, args[1], "test")) return null;
    const allocator = init.arena.allocator();
    const entrypoints = try testEntrypointMask(allocator, args);
    var test_files: std.ArrayList([:0]const u8) = .empty;
    for (entrypoints, 0..) |is_entrypoint, index| {
        if (is_entrypoint) try test_files.append(allocator, args[index]);
    }
    const explicit_entrypoint_count = test_files.items.len;
    if (explicit_entrypoint_count == 0) {
        var directory = try std.Io.Dir.cwd().openDir(init.io, ".", .{ .iterate = true });
        defer directory.close(init.io);
        var walker = try directory.walk(allocator);
        defer walker.deinit();
        while (try walker.next(init.io)) |entry| {
            if (entry.kind == .directory) {
                if ((entry.basename.len > 0 and entry.basename[0] == '.') or
                    std.mem.eql(u8, entry.basename, "node_modules"))
                {
                    walker.leave(init.io);
                }
                continue;
            }
            if (entry.kind != .file or !isTestEntrypoint(entry.basename)) continue;
            try test_files.append(allocator, try allocator.dupeZ(u8, entry.path));
        }
        std.mem.sort([:0]const u8, test_files.items, {}, struct {
            fn lessThan(_: void, left: [:0]const u8, right: [:0]const u8) bool {
                return std.mem.order(u8, left, right) == .lt;
            }
        }.lessThan);
    }
    const entrypoint_count = test_files.items.len;
    if (entrypoint_count <= 1) return null;

    var stdout_buffer: [256]u8 = undefined;
    var stdout_writer = std.Io.File.stdout().writer(init.io, &stdout_buffer);
    try stdout_writer.interface.print("bun test {s} (cottontail)\n", .{version});
    try stdout_writer.interface.flush();
    try init.environ_map.put("COTTONTAIL_TEST_CLI_HEADER_PRINTED", "1");

    var summary_id: [8]u8 = undefined;
    init.io.random(&summary_id);
    const summary_path = try std.fmt.allocPrint(allocator, ".cottontail-test-summary-{x}", .{summary_id});
    try std.Io.Dir.cwd().writeFile(init.io, .{ .sub_path = summary_path, .data = "" });
    defer std.Io.Dir.cwd().deleteFile(init.io, summary_path) catch {};
    try init.environ_map.put("COTTONTAIL_TEST_AGGREGATE_FILE", summary_path);
    defer _ = init.environ_map.swapRemove("COTTONTAIL_TEST_AGGREGATE_FILE");

    var exit_code: u8 = 0;
    var failed_files: usize = 0;
    var executed_files: usize = 0;
    const bail_limit = testBailLimit(args);
    var dots_mode = false;
    for (args[2..]) |arg| {
        if (std.mem.eql(u8, arg, "--dots")) {
            dots_mode = true;
            break;
        }
    }
    for (test_files.items) |test_file| {
        const child_args = try allocator.alloc(
            []const u8,
            if (explicit_entrypoint_count > 0) args.len - explicit_entrypoint_count + 1 else args.len + 1,
        );
        child_args[0] = args[0];
        child_args[1] = args[1];
        child_args[2] = test_file;
        var child_index: usize = 3;
        for (args[2..], 2..) |arg, index| {
            if (entrypoints[index]) continue;
            child_args[child_index] = arg;
            child_index += 1;
        }
        var child = try std.process.spawn(init.io, .{
            .argv = child_args,
            .environ_map = init.environ_map,
            .stdin = .inherit,
            .stdout = .inherit,
            .stderr = .inherit,
            .create_no_window = true,
        });
        defer child.kill(init.io);
        const code = childExitCode(try child.wait(init.io));
        executed_files += 1;
        if (code != 0) {
            exit_code = code;
            failed_files += 1;
            if (bail_limit) |limit| {
                if (limit > 0 and failed_files >= limit) break;
            }
        }
    }

    const summaries = try std.Io.Dir.cwd().readFileAlloc(
        init.io,
        summary_path,
        allocator,
        .limited(1024 * 1024),
    );
    var totals = [_]u64{0} ** 6;
    var lines = std.mem.splitScalar(u8, summaries, '\n');
    while (lines.next()) |line| {
        if (line.len == 0) continue;
        var fields = std.mem.splitScalar(u8, line, '\t');
        for (&totals) |*total| {
            const field = fields.next() orelse break;
            total.* += std.fmt.parseUnsigned(u64, field, 10) catch 0;
        }
    }
    var stderr_buffer: [1024]u8 = undefined;
    var stderr_writer = std.Io.File.stderr().writer(init.io, &stderr_buffer);
    const stderr = &stderr_writer.interface;
    if (bail_limit) |limit| {
        if (limit > 0 and failed_files >= limit and executed_files < entrypoint_count) {
            try stderr.print("\nBailed out after {d} failure{s}\n", .{ limit, if (limit == 1) "" else "s" });
        }
    }
    try stderr.print("{s}{d} pass\n", .{ if (dots_mode) "\n\n" else "\n ", totals[0] });
    const summary_indent = if (dots_mode) "" else " ";
    if (totals[1] > 0) try stderr.print("{s}{d} skip\n", .{ summary_indent, totals[1] });
    if (totals[2] > 0) try stderr.print("{s}{d} todo\n", .{ summary_indent, totals[2] });
    try stderr.print("{s}{d} fail\n", .{ summary_indent, totals[3] });
    if (totals[4] > 0) try stderr.print("{s}{d} error\n", .{ summary_indent, totals[4] });
    if (!dots_mode and totals[5] > 0) try stderr.print(" {d} expect() calls\n", .{totals[5]});
    const total_tests = totals[0] + totals[1] + totals[2] + totals[3];
    try stderr.print(
        "Ran {d} {s} across {d} files.\n",
        .{ total_tests, if (total_tests == 1) "test" else "tests", executed_files },
    );
    try stderr.flush();
    return exit_code;
}

fn testBailLimit(args: []const [:0]const u8) ?usize {
    for (args[2..], 2..) |arg, index| {
        if (std.mem.startsWith(u8, arg, "--bail=")) {
            return std.fmt.parseUnsigned(usize, arg["--bail=".len..], 10) catch null;
        }
        if (std.mem.eql(u8, arg, "--bail")) {
            if (index + 1 < args.len and !std.mem.startsWith(u8, args[index + 1], "-")) {
                return std.fmt.parseUnsigned(usize, args[index + 1], 10) catch 1;
            }
            return 1;
        }
    }
    return null;
}

fn parseRunInvocation(
    io: std.Io,
    args: []const [:0]const u8,
    start_index: usize,
    exec_args_storage: [][:0]const u8,
    exec_len: *usize,
    flags: *RunScriptFlags,
) !CliInvocation {
    var index: usize = start_index;
    while (index < args.len) {
        const arg = args[index];
        if (std.mem.eql(u8, arg, "--")) {
            index += 1;
            break;
        }
        if (!std.mem.startsWith(u8, arg, "-")) break;
        if (std.mem.eql(u8, arg, "--if-present")) {
            flags.if_present = true;
            index += 1;
            continue;
        }
        if (std.mem.eql(u8, arg, "--silent")) {
            flags.silent = true;
            index += 1;
            continue;
        }
        if (std.mem.eql(u8, arg, "--bun") or std.mem.eql(u8, arg, "-b")) {
            appendExecArg(exec_args_storage, exec_len, arg);
            index += 1;
            continue;
        }
        if (std.mem.eql(u8, arg, "--cwd") and index + 1 < args.len) {
            std.process.setCurrentPath(io, args[index + 1]) catch {};
            index += 2;
            continue;
        }
        if (std.mem.startsWith(u8, arg, "--cwd=")) {
            std.process.setCurrentPath(io, arg["--cwd=".len..]) catch {};
            index += 1;
            continue;
        }
        appendExecArg(exec_args_storage, exec_len, arg);
        if (runCommandFlagTakesValue(arg) and index + 1 < args.len) {
            appendExecArg(exec_args_storage, exec_len, args[index + 1]);
            index += 2;
        } else {
            index += 1;
        }
    }
    if (index >= args.len) return CliParseError.MissingEntrypoint;
    return .{
        .mode = .script,
        .payload = args[index],
        .args = args[index + 1 ..],
        .exec_args = exec_args_storage[0..exec_len.*],
        .flags = flags.*,
    };
}

fn parseInvocation(io: std.Io, allocator: std.mem.Allocator, args: []const [:0]const u8) !CliInvocation {
    if (args.len <= 1) return CliParseError.MissingEntrypoint;

    const exec_args_storage = try allocator.alloc([:0]const u8, args.len);
    var exec_len: usize = 0;
    var flags: RunScriptFlags = .{};

    if (std.mem.eql(u8, args[1], "run")) {
        if (args.len <= 2) return CliParseError.MissingEntrypoint;
        return parseRunInvocation(io, args, 2, exec_args_storage, &exec_len, &flags);
    }

    if (std.mem.eql(u8, args[1], "test")) {
        if (testEntrypointIndex(args)) |entrypoint_index| {
            return .{
                .mode = .script,
                .payload = try resolveTestEntrypoint(io, allocator, args[entrypoint_index]),
                .args = try testScriptArgs(allocator, args, entrypoint_index),
                .exec_args = exec_args_storage[0..0],
            };
        }
        return .{
            .mode = .script,
            .payload = try defaultTestEntrypoint(io, allocator),
            .args = args[2..],
            .exec_args = exec_args_storage[0..0],
        };
    }

    var index: usize = 1;
    while (index < args.len) {
        const arg = args[index];

        if (std.mem.eql(u8, arg, "--")) {
            index += 1;
            if (index >= args.len) return CliParseError.MissingEntrypoint;
            return .{
                .mode = .script,
                .payload = args[index],
                .args = args[index + 1 ..],
                .exec_args = exec_args_storage[0..exec_len],
                .flags = flags,
            };
        }

        if (std.mem.eql(u8, arg, "-e") or std.mem.eql(u8, arg, "--eval")) {
            if (index + 1 >= args.len) return CliParseError.MissingEvalSource;
            appendExecArg(exec_args_storage, &exec_len, arg);
            appendExecArg(exec_args_storage, &exec_len, args[index + 1]);
            return .{
                .mode = .eval,
                .payload = args[index + 1],
                .args = args[index + 2 ..],
                .exec_args = exec_args_storage[0..exec_len],
            };
        }

        if (std.mem.startsWith(u8, arg, "--eval=")) {
            appendExecArg(exec_args_storage, &exec_len, arg);
            return .{
                .mode = .eval,
                .payload = try argAfterPrefix(allocator, arg, "--eval="),
                .args = args[index + 1 ..],
                .exec_args = exec_args_storage[0..exec_len],
            };
        }

        if (std.mem.eql(u8, arg, "-p") or std.mem.eql(u8, arg, "--print")) {
            if (index + 1 >= args.len) return CliParseError.MissingPrintSource;
            appendExecArg(exec_args_storage, &exec_len, arg);
            appendExecArg(exec_args_storage, &exec_len, args[index + 1]);
            return .{
                .mode = .print,
                .payload = args[index + 1],
                .args = args[index + 2 ..],
                .exec_args = exec_args_storage[0..exec_len],
            };
        }

        if (std.mem.startsWith(u8, arg, "--print=")) {
            appendExecArg(exec_args_storage, &exec_len, arg);
            return .{
                .mode = .print,
                .payload = try argAfterPrefix(allocator, arg, "--print="),
                .args = args[index + 1 ..],
                .exec_args = exec_args_storage[0..exec_len],
            };
        }

        if (std.mem.eql(u8, arg, "--if-present")) {
            flags.if_present = true;
            index += 1;
            continue;
        }

        if (std.mem.eql(u8, arg, "--silent")) {
            flags.silent = true;
            index += 1;
            continue;
        }

        if (std.mem.eql(u8, arg, "--bun") or std.mem.eql(u8, arg, "-b")) {
            appendExecArg(exec_args_storage, &exec_len, arg);
            index += 1;
            continue;
        }

        if (std.mem.eql(u8, arg, "--cwd") and index + 1 < args.len) {
            std.process.setCurrentPath(io, args[index + 1]) catch {};
            index += 2;
            continue;
        }

        if (std.mem.startsWith(u8, arg, "--cwd=")) {
            std.process.setCurrentPath(io, arg["--cwd=".len..]) catch {};
            index += 1;
            continue;
        }

        if (isRuntimeFlag(arg)) {
            appendExecArg(exec_args_storage, &exec_len, arg);
            if (runtimeFlagTakesValue(arg) and index + 1 < args.len) {
                appendExecArg(exec_args_storage, &exec_len, args[index + 1]);
                index += 2;
            } else {
                index += 1;
            }
            continue;
        }

        if (std.mem.eql(u8, arg, "run") and index + 1 < args.len) {
            return parseRunInvocation(io, args, index + 1, exec_args_storage, &exec_len, &flags);
        }

        return .{
            .mode = .script,
            .payload = arg,
            .args = args[index + 1 ..],
            .exec_args = exec_args_storage[0..exec_len],
            .flags = flags,
        };
    }

    if (exec_len > 0) {
        return .{
            .mode = .stdin,
            .payload = try allocator.dupeZ(u8, ""),
            .args = args[args.len..],
            .exec_args = exec_args_storage[0..exec_len],
        };
    }

    return CliParseError.MissingEntrypoint;
}

fn isTestEntrypoint(name: []const u8) bool {
    const extensions = [_][]const u8{ ".js", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts" };
    const extension = std.fs.path.extension(name);
    if (extension.len == 0) return false;
    const stem = name[0 .. name.len - extension.len];
    const has_test_suffix = std.mem.endsWith(u8, stem, ".test") or
        std.mem.endsWith(u8, stem, "_test") or
        std.mem.endsWith(u8, stem, ".spec") or
        std.mem.endsWith(u8, stem, "_spec");
    if (!has_test_suffix) return false;
    for (extensions) |candidate_extension| {
        if (std.mem.eql(u8, extension, candidate_extension)) return true;
    }
    return false;
}

fn defaultTestEntrypoint(io: std.Io, allocator: std.mem.Allocator) ![:0]const u8 {
    const candidates = [_][]const u8{
        "index.test.ts",
        "index.test.tsx",
        "index.test.js",
        "index.test.mjs",
        "index.test.cjs",
        "test.ts",
        "test.js",
    };
    for (candidates) |candidate| {
        std.Io.Dir.cwd().access(io, candidate, .{}) catch continue;
        return try allocator.dupeZ(u8, candidate);
    }

    const directory = try std.Io.Dir.cwd().openDir(io, ".", .{ .iterate = true });
    defer directory.close(io);
    var iterator = directory.iterate();
    var selected: ?[]const u8 = null;
    while (try iterator.next(io)) |entry| {
        if (entry.kind != .file or !isTestEntrypoint(entry.name)) continue;
        if (selected == null or std.mem.order(u8, entry.name, selected.?) == .lt) {
            selected = try allocator.dupe(u8, entry.name);
        }
    }
    if (selected) |name| return try allocator.dupeZ(u8, name);
    return CliParseError.MissingEntrypoint;
}

fn consumeSpawnGate(allocator: std.mem.Allocator, process_args: []const [:0]const u8) ![]const [:0]const u8 {
    if (comptime builtin.os.tag == .windows) return process_args;
    const prefix = "--cottontail-spawn-gate=";
    if (process_args.len < 2 or !std.mem.startsWith(u8, process_args[1], prefix)) return process_args;

    const fd = std.fmt.parseInt(std.posix.fd_t, process_args[1][prefix.len..], 10) catch return process_args;
    var byte: [1]u8 = undefined;
    _ = std.posix.read(fd, byte[0..]) catch 0;
    _ = std.c.close(fd);

    const visible_args = try allocator.alloc([:0]const u8, process_args.len - 1);
    visible_args[0] = process_args[0];
    @memcpy(visible_args[1..], process_args[2..]);
    return visible_args;
}

fn runMacroEvaluator(init: std.process.Init, args: []const [:0]const u8) !u8 {
    if (args.len != 5) return 1;
    const allocator = init.arena.allocator();
    const module_literal = try std.json.Stringify.valueAlloc(allocator, args[2], .{});
    const export_literal = try std.json.Stringify.valueAlloc(allocator, args[3], .{});
    const source = try std.fmt.allocPrintSentinel(
        allocator,
        \\import * as __ctModule from {s};
        \\Object.defineProperty(globalThis, Symbol.for("cottontail.macroMode"), {{ value: true, configurable: true }});
        \\const __ctExportName = {s};
        \\const __ctMacro = __ctModule[__ctExportName];
        \\if (typeof __ctMacro !== "function") throw new TypeError(`Macro export ${{JSON.stringify(__ctExportName)}} is not a function`);
        \\const __ctEncode = (value, stack = new Set()) => {{
        \\  if (value === undefined) return {{ t: "undefined" }};
        \\  if (value === null) return {{ t: "null" }};
        \\  const type = typeof value;
        \\  if (type === "boolean") return {{ t: "boolean", v: value }};
        \\  if (type === "number") return {{ t: "number", v: Object.is(value, -0) ? "-0" : String(value) }};
        \\  if (type === "string") return {{ t: "string", v: value }};
        \\  if (type !== "object") throw new TypeError(`Cannot serialize macro result of type ${{type}}`);
        \\  if (typeof value.toJSON === "function") value = value.toJSON();
        \\  if (stack.has(value)) throw new TypeError("Cannot serialize a circular macro result");
        \\  stack.add(value);
        \\  try {{
        \\    if (Array.isArray(value)) return {{ t: "array", v: value.map(item => __ctEncode(item, stack)) }};
        \\    return {{ t: "object", v: Object.keys(value).map(key => [key, __ctEncode(value[key], stack)]) }};
        \\  }} finally {{
        \\    stack.delete(value);
        \\  }}
        \\}};
        \\const __ctResult = await __ctMacro(...({s}));
        \\console.log("\x1eCOTTONTAIL_MACRO_RESULT:" + JSON.stringify(__ctEncode(__ctResult)));
        \\
    ,
        .{ module_literal, export_literal, args[4] },
        0,
    );
    return try script_runner.runEval(init, source, &.{}, &.{"--cottontail-macro-mode"}, false);
}

pub fn main(init: std.process.Init) !void {
    const allocator = init.arena.allocator();
    var process_args = try init.minimal.args.toSlice(allocator);
    process_args = try consumeSpawnGate(allocator, process_args);
    if (process_args.len > 1 and std.mem.eql(u8, process_args[1], "--cottontail-macro-eval")) {
        const exit_code = try runMacroEvaluator(init, process_args);
        if (exit_code != 0) std.process.exit(exit_code);
        return;
    }
    const args = try argsWithBunOptions(allocator, process_args, init.environ_map);

    if (try runStandaloneIfPresent(init, args)) |exit_code| {
        if (exit_code != 0) std.process.exit(exit_code);
        return;
    }

    var stdout_buffer: [1024]u8 = undefined;
    var stdout_writer = std.Io.File.stdout().writer(init.io, &stdout_buffer);
    const stdout = &stdout_writer.interface;

    var stderr_buffer: [1024]u8 = undefined;
    var stderr_writer = std.Io.File.stderr().writer(init.io, &stderr_buffer);
    const stderr = &stderr_writer.interface;

    if (args.len <= 1) {
        try printHelp(stdout);
        try stdout.flush();
        return;
    }

    const arg = args[1];

    if (std.mem.eql(u8, arg, "--help") or std.mem.eql(u8, arg, "-h")) {
        try printHelp(stdout);
        try stdout.flush();
        return;
    }

    if (std.mem.eql(u8, arg, "--version") or std.mem.eql(u8, arg, "-v")) {
        try stdout.print("{s}\n", .{version});
        try stdout.flush();
        return;
    }

    if (std.mem.eql(u8, arg, "--revision")) {
        try stdout.print("{s}+{s}\n", .{ version, revision_suffix });
        try stdout.flush();
        return;
    }

    if (std.mem.eql(u8, arg, "getcompletes")) {
        // Mirrors `bun getcompletes`: emit completion candidates (builtin
        // commands plus package.json scripts), one per line.
        for (completion_commands) |name| {
            try stdout.print("{s}\n", .{name});
        }
        if (std.Io.Dir.cwd().readFileAlloc(
            init.io,
            "package.json",
            init.arena.allocator(),
            .limited(16 * 1024 * 1024),
        ) catch null) |source| {
            if (std.json.parseFromSlice(std.json.Value, init.arena.allocator(), source, .{}) catch null) |parsed| {
                if (parsed.value == .object) {
                    if (parsed.value.object.get("scripts")) |scripts| {
                        if (scripts == .object) {
                            for (scripts.object.keys()) |script_name| {
                                try stdout.print("{s}\n", .{script_name});
                            }
                        }
                    }
                }
            }
        }
        try stdout.flush();
        return;
    }

    if (std.mem.eql(u8, arg, "exec")) {
        if (args.len <= 2) {
            try stderr.print("cottontail: exec requires a command\n", .{});
            try stderr.flush();
            std.process.exit(1);
        }
        if (builtin.os.tag == .windows) {
            try stderr.print("cottontail: exec is unavailable on this platform yet\n", .{});
            try stderr.flush();
            std.process.exit(1);
        }

        const command_parts = try allocator.alloc([]const u8, args.len - 2);
        for (command_parts, 0..) |*part, index| {
            part.* = args[index + 2];
        }
        const command = try std.mem.joinZ(allocator, " ", command_parts);
        const shell = "/bin/sh";
        const shell_arg = "-c";
        const exec_args = [_:null]?[*:0]const u8{ shell.ptr, shell_arg.ptr, command.ptr };
        _ = std.c.execve(shell.ptr, &exec_args, @ptrCast(std.c.environ));
        try stderr.print("cottontail: exec failed\n", .{});
        try stderr.flush();
        std.process.exit(127);
    }

    if (std.mem.eql(u8, arg, "build")) {
        const exit_code = try nativeBuild(init, args);
        if (exit_code != 0) std.process.exit(exit_code);
        return;
    }

    if (try runMultipleTestFiles(init, args)) |exit_code| {
        if (exit_code != 0) std.process.exit(exit_code);
        return;
    }

    if (std.mem.eql(u8, arg, "test")) {
        if (init.environ_map.get("COTTONTAIL_TEST_CLI_HEADER_PRINTED") == null) {
            try stdout.print("bun test {s} (cottontail)\n", .{version});
            try stdout.flush();
        }
        try init.environ_map.put("COTTONTAIL_TEST_CLI_HEADER_PRINTED", "1");
    }

    const invocation = parseInvocation(init.io, init.arena.allocator(), args) catch |err| switch (err) {
        CliParseError.MissingEntrypoint => {
            try stderr.print("cottontail: expected an entrypoint script, -e script, or -p expression\n", .{});
            try stderr.flush();
            std.process.exit(1);
        },
        CliParseError.MissingEvalSource => {
            try stderr.print("cottontail: -e/--eval requires a script argument\n", .{});
            try stderr.flush();
            std.process.exit(1);
        },
        CliParseError.MissingPrintSource => {
            try stderr.print("cottontail: -p/--print requires an expression argument\n", .{});
            try stderr.flush();
            std.process.exit(1);
        },
        else => return err,
    };

    if (invocation.mode == .script and std.mem.eql(u8, invocation.payload, "node") and !cliPathExists(init.io, invocation.payload)) {
        const node_exit = try runFakeNode(init, invocation.args);
        if (node_exit != 0) {
            try stderr.flush();
            std.process.exit(node_exit);
        }
        return;
    }

    if (invocation.mode == .script and !std.mem.eql(u8, arg, "test") and !cliPathExists(init.io, invocation.payload)) {
        const payload = invocation.payload;
        const path_like = std.mem.indexOfScalar(u8, payload, '/') != null or
            std.mem.indexOfScalar(u8, payload, '\\') != null;
        if (!path_like) {
            if (try findPackageScripts(init.io, init.arena.allocator(), payload)) |pkg| {
                const script_exit = try runPackageScripts(init, pkg, invocation.flags, invocation.args);
                if (script_exit != 0) std.process.exit(script_exit);
                return;
            }
        }
        if (invocation.flags.if_present) return;
        if (!path_like and std.fs.path.extension(payload).len == 0) {
            try stderr.print("error: Script not found \"{s}\"\n", .{payload});
        } else {
            try stderr.print("error: Module not found \"{s}\"\n", .{payload});
        }
        try stderr.flush();
        std.process.exit(1);
    }

    const exit_code = switch (invocation.mode) {
        .script => if (isBunShellScript(invocation.payload))
            try runBunShellScript(init, invocation.payload, invocation.args)
        else
            try script_runner.runWithExecArgv(init, invocation.payload, invocation.args, invocation.exec_args),
        .eval => try script_runner.runEval(init, invocation.payload, invocation.args, invocation.exec_args, false),
        .print => try script_runner.runEval(init, invocation.payload, invocation.args, invocation.exec_args, true),
        .stdin => try script_runner.runStdin(init, invocation.args, invocation.exec_args),
    };
    if (exit_code != 0) {
        try stderr.flush();
        std.process.exit(@intCast(exit_code));
    }
}

test "help text mentions cottontail and script usage" {
    try std.testing.expect(std.mem.indexOf(u8, help_text_template, "cottontail") != null);
    try std.testing.expect(std.mem.indexOf(u8, help_text_template, "JavaScriptCore") != null);
    try std.testing.expect(std.mem.indexOf(u8, help_text_template, "<entrypoint.js|entrypoint.ts>") != null);
}

test "test entrypoint names use supported test extensions" {
    try std.testing.expect(isTestEntrypoint("example.test.ts"));
    try std.testing.expect(isTestEntrypoint("example.test.cjs"));
    try std.testing.expect(!isTestEntrypoint("example.ts"));
    try std.testing.expect(!isTestEntrypoint("example.test.txt"));
}

test "test flags can precede the entrypoint" {
    const args = [_][:0]const u8{ "cottontail", "test", "--max-concurrency", "3", "suite.test.ts" };
    try std.testing.expectEqual(@as(?usize, 4), testEntrypointIndex(&args));
    try std.testing.expectEqual(@as(?usize, null), testEntrypointIndex(args[0..4]));
}

test "test flag values are not treated as additional entrypoints" {
    const args = [_][:0]const u8{
        "cottontail",
        "test",
        "first.test.ts",
        "second.test.ts",
        "--dots",
        "-t",
        "filterin",
    };
    const mask = try testEntrypointMask(std.testing.allocator, &args);
    defer std.testing.allocator.free(mask);
    try std.testing.expect(mask[2]);
    try std.testing.expect(mask[3]);
    try std.testing.expect(!mask[4]);
    try std.testing.expect(!mask[5]);
    try std.testing.expect(!mask[6]);
}

test {
    _ = script_runner;
}
