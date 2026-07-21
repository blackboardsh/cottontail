const std = @import("std");
const builtin = @import("builtin");
const cottontail_compiler = @import("cottontail_compiler");
const cottontail_bundler = @import("cottontail_bundler.zig");
const cottontail_diff = @import("cottontail_diff.zig");
const cottontail_hash = @import("cottontail_hash.zig");
const cottontail_markdown = @import("cottontail_markdown.zig");
const cottontail_password = @import("cottontail_password.zig");
const package_manager_bun_lockfile = @import("package_manager_bun_lockfile.zig");
const package_manager_bunx = @import("package_manager_bunx.zig");
const package_manager_cli = @import("package_manager_cli.zig");
const repl = @import("repl.zig");
const cottontail_transpiler = @import("cottontail_transpiler.zig");
const completions = @import("completions.zig");
const host = @import("host.zig");
const cli_run = @import("cli_run.zig");
const script_runner = @import("script_runner.zig");

comptime {
    cottontail_bundler.forceLink();
    cottontail_diff.forceLink();
    cottontail_hash.forceLink();
    cottontail_markdown.forceLink();
    cottontail_password.forceLink();
    cottontail_transpiler.forceLink();
    host.forceLink();
}

const version = @import("version.zig").version;
const bun_compat_version = "1.3.10";
// Build-metadata suffix reported by `--revision` (`<version>+<suffix>`),
// mirroring how bun reports `<version>+<git sha>`.
const revision_suffix = "cottontail";
const completion_commands = [_][]const u8{ "run", "test", "build", "repl", "x", "exec", "completions", "getcompletes" };
extern "c" fn setenv(name: [*:0]const u8, value: [*:0]const u8, overwrite: c_int) c_int;

fn testRunnerDisplayVersion(init: std.process.Init) []const u8 {
    return init.environ_map.get("COTTONTAIL_UPSTREAM_VERSION") orelse bun_compat_version;
}

fn commandDisplayVersion(init: std.process.Init) []const u8 {
    return init.environ_map.get("COTTONTAIL_UPSTREAM_VERSION") orelse version;
}
const help_text_template =
    \\cottontail {s}
    \\Bun is a fast JavaScript runtime, package manager, bundler, and test runner.
    \\Cottontail provides a Bun-compatible Zig and JavaScriptCore implementation.
    \\
    \\Usage:
    \\  cottontail <entrypoint.js|entrypoint.ts> [args...]
    \\  cottontail run <entrypoint.js|entrypoint.ts> [args...]
    \\  cottontail test [args...]
    \\  cottontail repl [-e|--eval <script> | -p|--print <expression>]
    \\  cottontail install|add|remove|update [packages...] [flags]
    \\  cottontail x [--package <package>] <package-or-bin> [args...]
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

fn normalizeLeadingTestRuntimeFlags(
    allocator: std.mem.Allocator,
    args: []const [:0]const u8,
) ![]const [:0]const u8 {
    if (args.len < 3 or !isRuntimeFlag(args[1])) return args;

    var command_index: usize = 1;
    while (command_index < args.len and isRuntimeFlag(args[command_index])) {
        const flag = args[command_index];
        command_index += 1;
        if (runtimeFlagTakesValue(flag) and command_index < args.len) command_index += 1;
    }
    if (command_index >= args.len or !std.mem.eql(u8, args[command_index], "test")) return args;

    const normalized = try allocator.alloc([:0]const u8, args.len);
    normalized[0] = args[0];
    normalized[1] = args[command_index];
    @memcpy(normalized[2 .. command_index + 1], args[1..command_index]);
    @memcpy(normalized[command_index + 1 ..], args[command_index + 1 ..]);
    return normalized;
}

fn normalizeLeadingPackageManagerConfig(
    allocator: std.mem.Allocator,
    args: []const [:0]const u8,
) ![]const [:0]const u8 {
    if (args.len < 3) return args;
    const first = args[1];
    const command_index: usize = if (std.mem.startsWith(u8, first, "-c=") or
        std.mem.startsWith(u8, first, "--config="))
        2
    else if ((std.mem.eql(u8, first, "-c") or std.mem.eql(u8, first, "--config")) and args.len > 3)
        3
    else
        return args;
    if (command_index >= args.len or !package_manager_cli.recognizes(args[command_index])) return args;

    const normalized = try allocator.alloc([:0]const u8, args.len);
    normalized[0] = args[0];
    normalized[1] = args[command_index];
    @memcpy(normalized[2 .. command_index + 1], args[1..command_index]);
    @memcpy(normalized[command_index + 1 ..], args[command_index + 1 ..]);
    return normalized;
}

fn runCommandFlagTakesValue(arg: []const u8) bool {
    if (runtimeFlagTakesValue(arg)) return true;
    if (std.mem.indexOfScalar(u8, arg, '=') != null) return false;
    const value_flags = [_][]const u8{
        "-e",
        "-p",
        "--cwd",
        "--eval",
        "--shell",
        "--elide-lines",
        "--filter",
        "--print",
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
        "--feature",
        "--fetch-preconnect",
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
    if (std.mem.eql(u8, arg, "-r") or std.mem.eql(u8, arg, "-i")) return true;
    return std.mem.startsWith(u8, arg, "--");
}

fn testFlagTakesValue(arg: []const u8) bool {
    if (std.mem.indexOfScalar(u8, arg, '=') != null) return false;
    const value_flags = [_][]const u8{
        "-t",
        "--bail",
        "--coverage-dir",
        "--coverage-reporter",
        "--feature",
        "--max-concurrency",
        "--preload",
        "--reporter",
        "--reporter-outfile",
        "--rerun-each",
        "--retry",
        "--seed",
        "--test-name-pattern",
        "--timeout",
    };
    for (value_flags) |candidate| {
        if (std.mem.eql(u8, arg, candidate)) return true;
    }
    return false;
}

fn testFlagSpan(args: []const [:0]const u8, index: usize) usize {
    const arg = args[index];
    if (!testFlagTakesValue(arg) or index + 1 >= args.len) return 1;
    // `--bail` has an optional numeric value. A following path/filter belongs
    // to test discovery, while `--bail 3` consumes the number.
    if (std.mem.eql(u8, arg, "--bail")) {
        const value = args[index + 1];
        _ = std.fmt.parseUnsigned(usize, value, 10) catch return 1;
    }
    return 2;
}

fn testEntrypointIndex(args: []const [:0]const u8) ?usize {
    var index: usize = 2;
    while (index < args.len) {
        const arg = args[index];
        if (!std.mem.startsWith(u8, arg, "-")) return index;
        index += testFlagSpan(args, index);
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
            index += testFlagSpan(args, index);
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

fn unsupportedEntrypointLoader(path: []const u8) ?[]const u8 {
    const extension = std.fs.path.extension(path);
    if (std.ascii.eqlIgnoreCase(extension, ".css")) return "css";
    return null;
}

fn cliPathExists(io: std.Io, path: []const u8) bool {
    if (std.fs.path.isAbsolute(path)) {
        std.Io.Dir.accessAbsolute(io, path, .{}) catch return false;
        return true;
    }
    std.Io.Dir.cwd().access(io, path, .{}) catch return false;
    return true;
}

fn cliBunEntrypointExists(io: std.Io, allocator: std.mem.Allocator, path: []const u8) !bool {
    if (cliPathExists(io, path)) return true;
    const extension = std.fs.path.extension(path);
    const replacements = script_runner.bunEntrypointFallbackExtensions(path);
    if (replacements.len == 0) return false;

    const stem = path[0 .. path.len - extension.len];
    for (replacements) |replacement| {
        const candidate = try std.mem.concat(allocator, u8, &.{ stem, replacement });
        if (cliPathExists(io, candidate)) return true;
    }
    return false;
}

fn isHtmlEntrypoint(path: []const u8) bool {
    const extension = std.fs.path.extension(path);
    return std.ascii.eqlIgnoreCase(extension, ".html") or std.ascii.eqlIgnoreCase(extension, ".htm");
}

fn wildcardPathMatch(pattern: []const u8, path: []const u8) bool {
    var pattern_index: usize = 0;
    var path_index: usize = 0;
    var star_index: ?usize = null;
    var star_path_index: usize = 0;
    while (path_index < path.len) {
        if (pattern_index < pattern.len and (pattern[pattern_index] == '?' or pattern[pattern_index] == path[path_index])) {
            pattern_index += 1;
            path_index += 1;
        } else if (pattern_index < pattern.len and pattern[pattern_index] == '*') {
            star_index = pattern_index;
            pattern_index += 1;
            star_path_index = path_index;
        } else if (star_index) |star| {
            pattern_index = star + 1;
            star_path_index += 1;
            path_index = star_path_index;
        } else {
            return false;
        }
    }
    while (pattern_index < pattern.len and pattern[pattern_index] == '*') pattern_index += 1;
    return pattern_index == pattern.len;
}

fn appendHtmlEntrypointPattern(
    init: std.process.Init,
    allocator: std.mem.Allocator,
    requested: []const u8,
    entries: *std.ArrayList([:0]const u8),
) !void {
    if (std.mem.indexOfAny(u8, requested, "*?") == null) {
        if (isHtmlEntrypoint(requested) and cliPathExists(init.io, requested)) {
            try entries.append(allocator, try allocator.dupeZ(u8, requested));
        }
        return;
    }

    const directory_path = std.fs.path.dirname(requested) orelse ".";
    const name_pattern = std.fs.path.basename(requested);
    var directory = if (std.fs.path.isAbsolute(directory_path))
        std.Io.Dir.openDirAbsolute(init.io, directory_path, .{ .iterate = true }) catch return
    else
        std.Io.Dir.cwd().openDir(init.io, directory_path, .{ .iterate = true }) catch return;
    defer directory.close(init.io);
    var iterator = directory.iterate();
    var matches: std.ArrayList([:0]const u8) = .empty;
    while (try iterator.next(init.io)) |entry| {
        if (entry.kind != .file or !wildcardPathMatch(name_pattern, entry.name) or !isHtmlEntrypoint(entry.name)) continue;
        const path = if (std.mem.eql(u8, directory_path, "."))
            try allocator.dupe(u8, entry.name)
        else
            try std.fs.path.join(allocator, &.{ directory_path, entry.name });
        try matches.append(allocator, try allocator.dupeZ(u8, path));
    }
    std.mem.sort([:0]const u8, matches.items, {}, struct {
        fn lessThan(_: void, left: [:0]const u8, right: [:0]const u8) bool {
            return std.mem.order(u8, left, right) == .lt;
        }
    }.lessThan);
    try entries.appendSlice(allocator, matches.items);
}

fn runHtmlEntrypoints(init: std.process.Init, invocation: CliInvocation) !?u8 {
    if (invocation.mode != .script or
        (!isHtmlEntrypoint(invocation.payload) and std.mem.indexOfAny(u8, invocation.payload, "*?") == null)) return null;

    const allocator = init.arena.allocator();
    var entries: std.ArrayList([:0]const u8) = .empty;
    try appendHtmlEntrypointPattern(init, allocator, invocation.payload, &entries);
    for (invocation.args) |arg| {
        if (std.mem.startsWith(u8, arg, "-")) continue;
        if (!isHtmlEntrypoint(arg) and std.mem.indexOfAny(u8, arg, "*?") == null) continue;
        try appendHtmlEntrypointPattern(init, allocator, arg, &entries);
    }
    if (entries.items.len == 0) return null;

    var port: []const u8 = "3000";
    var index: usize = 0;
    while (index < invocation.args.len) : (index += 1) {
        const arg = invocation.args[index];
        if (std.mem.startsWith(u8, arg, "--port=")) {
            const value = arg["--port=".len..];
            if (std.fmt.parseUnsigned(u16, value, 10)) |_| port = value else |_| {}
        } else if (std.mem.eql(u8, arg, "--port") and index + 1 < invocation.args.len) {
            const value = invocation.args[index + 1];
            if (std.fmt.parseUnsigned(u16, value, 10)) |_| port = value else |_| {}
            index += 1;
        }
    }

    var source: std.ArrayList(u8) = .empty;
    try source.appendSlice(allocator,
        \\const server = Bun.serve({
        \\  development: process.env.NODE_ENV !== "production",
        \\  port:
    );
    try source.appendSlice(allocator, port);
    try source.appendSlice(allocator, ",\n  routes: {\n");
    for (entries.items) |entry| {
        const basename = std.fs.path.basename(entry);
        const extension = std.fs.path.extension(basename);
        const stem = basename[0 .. basename.len - extension.len];
        const route = if (std.ascii.eqlIgnoreCase(stem, "index"))
            "/"
        else
            try std.fmt.allocPrint(allocator, "/{s}", .{stem});
        const route_json = try std.json.Stringify.valueAlloc(allocator, route, .{});
        const entry_json = try std.json.Stringify.valueAlloc(allocator, entry, .{});
        try source.appendSlice(allocator, "    ");
        try source.appendSlice(allocator, route_json);
        try source.appendSlice(allocator, ": ");
        try source.appendSlice(allocator, entry_json);
        try source.appendSlice(allocator, ",\n");
    }
    try source.appendSlice(allocator,
        \\  },
        \\});
        \\console.log(`Started development server: ${server.url}`);
        \\
    );
    const source_z = try allocator.dupeZ(u8, source.items);
    return try script_runner.runEval(init, source_z, &.{}, invocation.exec_args, false);
}

const PackageScripts = struct {
    dir: []const u8,
    pre: ?[]const u8,
    main: []const u8,
    post: ?[]const u8,
    name: []const u8,
    config: []const PackageConfigEntry,
};

const PackageConfigEntry = struct {
    name: []const u8,
    value: []const u8,
};

fn packageConfigValue(allocator: std.mem.Allocator, value: std.json.Value) ![]const u8 {
    return switch (value) {
        .string => |text| text,
        .bool => |flag| if (flag) "true" else "false",
        .integer => |number| try std.fmt.allocPrint(allocator, "{d}", .{number}),
        .float => |number| try std.fmt.allocPrint(allocator, "{d}", .{number}),
        .null => "",
        else => try std.json.Stringify.valueAlloc(allocator, value, .{}),
    };
}

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
    var current: []const u8 = cwd_abs;
    while (true) {
        const package_json = try std.fs.path.join(allocator, &.{ current, "package.json" });
        if (cliPathExists(io, package_json)) {
            const source = std.Io.Dir.cwd().readFileAlloc(
                io,
                package_json,
                allocator,
                .limited(16 * 1024 * 1024),
            ) catch null;
            if (source) |contents| {
                const parsed = std.json.parseFromSlice(std.json.Value, allocator, contents, .{}) catch null;
                if (parsed) |document| {
                    const root = document.value;
                    if (root == .object) {
                        if (root.object.get("scripts")) |scripts| {
                            if (scripts == .object) {
                                if (jsonScriptValue(scripts, name)) |main_command| {
                                    const pre_name = try std.mem.concat(allocator, u8, &.{ "pre", name });
                                    const post_name = try std.mem.concat(allocator, u8, &.{ "post", name });
                                    var config_entries = std.array_list.Managed(PackageConfigEntry).init(allocator);
                                    if (root.object.get("config")) |config| {
                                        if (config == .object) {
                                            for (config.object.keys(), config.object.values()) |key, value| {
                                                try config_entries.append(.{
                                                    .name = try std.fmt.allocPrint(allocator, "npm_package_config_{s}", .{key}),
                                                    .value = try packageConfigValue(allocator, value),
                                                });
                                            }
                                        }
                                    }
                                    return .{
                                        .dir = try allocator.dupe(u8, current),
                                        .pre = jsonScriptValue(scripts, pre_name),
                                        .main = try allocator.dupe(u8, main_command),
                                        .post = jsonScriptValue(scripts, post_name),
                                        .name = name,
                                        .config = try config_entries.toOwnedSlice(),
                                    };
                                }
                            }
                        }
                    }
                }
            }
        }
        const parent = std.fs.path.dirname(current) orelse break;
        if (std.mem.eql(u8, parent, current)) break;
        current = parent;
    }
    return null;
}

fn prependAncestorBinPaths(
    allocator: std.mem.Allocator,
    env: *std.process.Environ.Map,
    start_dir: []const u8,
) !void {
    var parts = std.array_list.Managed([]const u8).init(allocator);
    var current = start_dir;
    while (true) {
        try parts.append(try std.fs.path.join(allocator, &.{ current, "node_modules", ".bin" }));
        const parent = std.fs.path.dirname(current) orelse break;
        if (std.mem.eql(u8, parent, current)) break;
        current = parent;
    }
    if (env.get("PATH")) |path| try parts.append(path);
    const separator = if (builtin.os.tag == .windows) ";" else ":";
    try env.put("PATH", try std.mem.join(allocator, separator, parts.items));
}

fn findAncestorBin(io: std.Io, allocator: std.mem.Allocator, name: []const u8) !?[]const u8 {
    const cwd_abs = std.Io.Dir.cwd().realPathFileAlloc(io, ".", allocator) catch return null;
    var current: []const u8 = cwd_abs;
    while (true) {
        const bin_dir = try std.fs.path.join(allocator, &.{ current, "node_modules", ".bin" });
        const candidate = try std.fs.path.join(allocator, &.{ bin_dir, name });
        if (pathIsFile(io, candidate)) return candidate;
        if (builtin.os.tag == .windows) {
            for ([_][]const u8{ ".exe", ".cmd", ".bat" }) |extension| {
                const with_extension = try std.mem.concat(allocator, u8, &.{ candidate, extension });
                if (pathIsFile(io, with_extension)) return with_extension;
            }
        }
        const parent = std.fs.path.dirname(current) orelse break;
        if (std.mem.eql(u8, parent, current)) break;
        current = parent;
    }
    return null;
}

fn runAncestorBin(
    init: std.process.Init,
    executable: []const u8,
    args: []const [:0]const u8,
) !u8 {
    const allocator = init.arena.allocator();
    const cwd_abs = try std.Io.Dir.cwd().realPathFileAlloc(init.io, ".", allocator);
    var env = try init.environ_map.clone(allocator);
    try prependAncestorBinPaths(allocator, &env, cwd_abs);

    const argv = try allocator.alloc([]const u8, args.len + 1);
    argv[0] = executable;
    for (args, 0..) |arg, index| argv[index + 1] = arg;
    var child = try std.process.spawn(init.io, .{
        .argv = argv,
        .environ_map = &env,
        .stdin = .inherit,
        .stdout = .inherit,
        .stderr = .inherit,
        .create_no_window = true,
    });
    defer child.kill(init.io);
    return childExitCode(try child.wait(init.io));
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
    const executable = try std.process.executablePathAlloc(init.io, allocator);
    try env.put("BUN", executable);
    try env.put("npm_execpath", executable);
    try env.put("npm_node_execpath", executable);
    const init_cwd = try std.Io.Dir.cwd().realPathFileAlloc(init.io, ".", allocator);
    try env.put("INIT_CWD", init_cwd);
    try prependAncestorBinPaths(allocator, &env, pkg.dir);
    for (pkg.config) |entry| try env.put(entry.name, entry.value);

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

fn standaloneExtraSourceMapPath(allocator: std.mem.Allocator, output_path: []const u8, map_path: []const u8) ![]const u8 {
    var relative = map_path;
    while (std.mem.startsWith(u8, relative, "./")) relative = relative[2..];
    if (relative.len == 0 or std.fs.path.isAbsolute(relative) or
        std.mem.eql(u8, relative, "..") or std.mem.startsWith(u8, relative, "../"))
    {
        return error.InvalidStandaloneSourceMapPath;
    }
    const output_dir = std.fs.path.dirname(output_path) orelse ".";
    return try std.fs.path.join(allocator, &.{ output_dir, relative });
}

const standalone_magic_v1 = "COTTONTAIL-STAND";
const standalone_magic_v2 = "COTTONTAIL-STAND2";
const standalone_magic = "COTTONTAIL-STAND3";
const standalone_trailer_v1_len = @sizeOf(u64) + standalone_magic_v1.len;
const standalone_trailer_v2_len = @sizeOf(u64) * 2 + standalone_magic_v2.len;
const standalone_trailer_len = @sizeOf(u64) * 3 + standalone_magic.len;

const StandalonePayload = struct {
    source: []const u8,
    source_map: ?[]const u8 = null,
    files: ?[]const u8 = null,
};

fn loadStandalonePayload(init: std.process.Init) !?StandalonePayload {
    const allocator = init.arena.allocator();
    const executable_path = try std.process.executablePathAlloc(init.io, allocator);
    const executable = try std.Io.Dir.cwd().openFile(init.io, executable_path, .{});
    defer executable.close(init.io);
    const executable_len = try executable.length(init.io);

    if (executable_len >= standalone_trailer_len) {
        var trailer: [standalone_trailer_len]u8 = undefined;
        const trailer_offset = executable_len - standalone_trailer_len;
        if (try executable.readPositionalAll(init.io, &trailer, trailer_offset) == trailer.len and
            std.mem.eql(u8, trailer[@sizeOf(u64) * 3 ..], standalone_magic))
        {
            const source_len_u64 = std.mem.readInt(u64, trailer[0..@sizeOf(u64)], .little);
            const map_len_u64 = std.mem.readInt(u64, trailer[@sizeOf(u64) .. @sizeOf(u64) * 2], .little);
            const files_len_u64 = std.mem.readInt(u64, trailer[@sizeOf(u64) * 2 .. @sizeOf(u64) * 3], .little);
            const source_len = std.math.cast(usize, source_len_u64) orelse return error.InvalidStandaloneExecutable;
            const map_len = std.math.cast(usize, map_len_u64) orelse return error.InvalidStandaloneExecutable;
            const files_len = std.math.cast(usize, files_len_u64) orelse return error.InvalidStandaloneExecutable;
            if (source_len > 512 * 1024 * 1024 or map_len > 512 * 1024 * 1024 or files_len > 512 * 1024 * 1024 or
                source_len > trailer_offset or map_len > trailer_offset - source_len or
                files_len > trailer_offset - source_len - map_len)
            {
                return error.InvalidStandaloneExecutable;
            }
            const payload_offset = trailer_offset - source_len - map_len - files_len;
            const source = try allocator.alloc(u8, source_len);
            if (try executable.readPositionalAll(init.io, source, payload_offset) != source.len)
                return error.InvalidStandaloneExecutable;
            const source_map = if (map_len > 0) blk: {
                const map = try allocator.alloc(u8, map_len);
                if (try executable.readPositionalAll(init.io, map, payload_offset + source_len) != map.len)
                    return error.InvalidStandaloneExecutable;
                break :blk map;
            } else null;
            const files = if (files_len > 0) blk: {
                const files = try allocator.alloc(u8, files_len);
                if (try executable.readPositionalAll(init.io, files, payload_offset + source_len + map_len) != files.len)
                    return error.InvalidStandaloneExecutable;
                break :blk files;
            } else null;
            return .{ .source = source, .source_map = source_map, .files = files };
        }
    }

    if (executable_len >= standalone_trailer_v2_len) {
        var trailer: [standalone_trailer_v2_len]u8 = undefined;
        const trailer_offset = executable_len - standalone_trailer_v2_len;
        if (try executable.readPositionalAll(init.io, &trailer, trailer_offset) == trailer.len and
            std.mem.eql(u8, trailer[@sizeOf(u64) * 2 ..], standalone_magic_v2))
        {
            const source_len_u64 = std.mem.readInt(u64, trailer[0..@sizeOf(u64)], .little);
            const map_len_u64 = std.mem.readInt(u64, trailer[@sizeOf(u64) .. @sizeOf(u64) * 2], .little);
            const source_len = std.math.cast(usize, source_len_u64) orelse return error.InvalidStandaloneExecutable;
            const map_len = std.math.cast(usize, map_len_u64) orelse return error.InvalidStandaloneExecutable;
            if (source_len > 512 * 1024 * 1024 or map_len > 512 * 1024 * 1024 or
                source_len > trailer_offset or map_len > trailer_offset - source_len)
            {
                return error.InvalidStandaloneExecutable;
            }
            const payload_offset = trailer_offset - source_len - map_len;
            const source = try allocator.alloc(u8, source_len);
            if (try executable.readPositionalAll(init.io, source, payload_offset) != source.len)
                return error.InvalidStandaloneExecutable;
            const source_map = if (map_len > 0) blk: {
                const map = try allocator.alloc(u8, map_len);
                if (try executable.readPositionalAll(init.io, map, payload_offset + source_len) != map.len)
                    return error.InvalidStandaloneExecutable;
                break :blk map;
            } else null;
            return .{ .source = source, .source_map = source_map };
        }
    }

    if (executable_len < standalone_trailer_v1_len) return null;
    var trailer: [standalone_trailer_v1_len]u8 = undefined;
    const trailer_offset = executable_len - standalone_trailer_v1_len;
    if (try executable.readPositionalAll(init.io, &trailer, trailer_offset) != trailer.len) return null;
    if (!std.mem.eql(u8, trailer[@sizeOf(u64)..], standalone_magic_v1)) return null;
    const source_len_u64 = std.mem.readInt(u64, trailer[0..@sizeOf(u64)], .little);
    const source_len = std.math.cast(usize, source_len_u64) orelse return error.InvalidStandaloneExecutable;
    if (source_len > trailer_offset or source_len > 512 * 1024 * 1024) return error.InvalidStandaloneExecutable;
    const source = try allocator.alloc(u8, source_len);
    const source_offset = trailer_offset - source_len;
    if (try executable.readPositionalAll(init.io, source, source_offset) != source.len) return error.InvalidStandaloneExecutable;
    return .{ .source = source };
}

fn writeStandaloneExecutable(
    init: std.process.Init,
    output_path: []const u8,
    payload: script_runner.StandaloneSource,
    write_external_source_map: bool,
) !void {
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
    try output.writePositionalAll(init.io, payload.source, executable_len);
    const source_map = payload.source_map orelse "";
    try output.writePositionalAll(init.io, source_map, executable_len + payload.source.len);
    const files = payload.files orelse "";
    try output.writePositionalAll(init.io, files, executable_len + payload.source.len + source_map.len);
    var trailer: [standalone_trailer_len]u8 = undefined;
    std.mem.writeInt(u64, trailer[0..@sizeOf(u64)], @intCast(payload.source.len), .little);
    std.mem.writeInt(u64, trailer[@sizeOf(u64) .. @sizeOf(u64) * 2], @intCast(source_map.len), .little);
    std.mem.writeInt(u64, trailer[@sizeOf(u64) * 2 .. @sizeOf(u64) * 3], @intCast(files.len), .little);
    @memcpy(trailer[@sizeOf(u64) * 3 ..], standalone_magic);
    try output.writePositionalAll(
        init.io,
        &trailer,
        executable_len + payload.source.len + source_map.len + files.len,
    );

    if (write_external_source_map and payload.source_map != null) {
        const map_path = try std.mem.concat(init.arena.allocator(), u8, &.{ output_path, ".map" });
        try writeBuildFile(init.io, map_path, source_map);
        for (payload.source_maps) |extra_map| {
            const extra_path = try standaloneExtraSourceMapPath(init.arena.allocator(), output_path, extra_map.path);
            try writeBuildFile(init.io, extra_path, extra_map.contents);
        }
    }
}

fn runStandaloneIfPresent(
    init: std.process.Init,
    args: []const [:0]const u8,
) !?u8 {
    const payload = (try loadStandalonePayload(init)) orelse return null;
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
        payload.source,
        payload.source_map,
        payload.files,
        args[script_start..],
        exec_args[0..exec_len],
    );
}

fn runBakeProductionBuild(init: std.process.Init, entrypoint: []const u8, outdir: []const u8) !u8 {
    const allocator = init.arena.allocator();
    var source: std.ArrayList(u8) = .empty;
    try source.appendSlice(allocator,
        \\const __ctBuildBakeProduction = globalThis[Symbol.for("cottontail.internal.buildBakeProduction")];
        \\if (typeof __ctBuildBakeProduction !== "function") throw new Error("Bake production builder is unavailable");
        \\await __ctBuildBakeProduction({ entrypoint:
    );
    try appendJavaScriptStringLiteral(allocator, &source, entrypoint);
    try source.appendSlice(allocator, ", outdir: ");
    try appendJavaScriptStringLiteral(allocator, &source, outdir);
    try source.appendSlice(allocator, " });\n");
    const source_z = try allocator.dupeZ(u8, source.items);
    return script_runner.runEval(init, source_z, &.{}, &.{}, false);
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
    var features: std.ArrayList([]const u8) = .empty;
    var conditions: std.ArrayList([]const u8) = .empty;
    var define_keys: std.ArrayList([]const u8) = .empty;
    var define_values: std.ArrayList([]const u8) = .empty;
    var outdir: ?[]const u8 = null;
    var outfile: ?[]const u8 = null;
    var metafile_json_path: ?[]const u8 = null;
    var metafile_markdown_path: ?[]const u8 = null;
    var compile = false;
    var app = false;
    var index: usize = 2;
    while (index < args.len) : (index += 1) {
        const arg: []const u8 = args[index];
        if (std.mem.eql(u8, arg, "--compile")) {
            compile = true;
        } else if (std.mem.eql(u8, arg, "--app")) {
            app = true;
        } else if (std.mem.eql(u8, arg, "--no-bundle")) {
            options.transform_only = true;
        } else if (std.mem.eql(u8, arg, "--bytecode")) {
            options.bytecode = true;
        } else if (std.mem.eql(u8, arg, "--production")) {
            options.production = true;
            options.minify_whitespace = true;
            options.minify_identifiers = true;
            options.minify_syntax = true;
        } else if (std.mem.eql(u8, arg, "--server-components")) {
            options.server_components = true;
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
        } else if (std.mem.startsWith(u8, arg, "--feature=")) {
            const feature = arg["--feature=".len..];
            if (feature.len > 0) try features.append(allocator, feature);
        } else if (std.mem.eql(u8, arg, "--feature") and index + 1 < args.len) {
            index += 1;
            if (args[index].len > 0) try features.append(allocator, args[index]);
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
        } else if (std.mem.startsWith(u8, arg, "--tsconfig-override=")) {
            options.tsconfig_override = arg["--tsconfig-override=".len..];
        } else if (std.mem.eql(u8, arg, "--tsconfig-override") and index + 1 < args.len) {
            index += 1;
            options.tsconfig_override = args[index];
        } else if (std.mem.eql(u8, arg, "--entrypoints") and index + 1 < args.len) {
            index += 1;
            try entries.append(allocator, args[index]);
        } else if (std.mem.startsWith(u8, arg, "--format=")) {
            options.output_format = cottontail_compiler.options.Format.fromString(arg["--format=".len..]) orelse {
                try stderr.print("error: invalid build format \"{s}\"\n", .{arg["--format=".len..]});
                try stderr.flush();
                return 1;
            };
        } else if (std.mem.startsWith(u8, arg, "--target=") or std.mem.eql(u8, arg, "--target")) {
            const target = if (std.mem.eql(u8, arg, "--target")) target: {
                if (index + 1 >= args.len) {
                    try stderr.writeAll("error: --target requires a value\n");
                    try stderr.flush();
                    return 1;
                }
                index += 1;
                break :target args[index];
            } else arg["--target=".len..];
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
    if (outfile != null and entries.items.len != 1 and !compile) {
        try stderr.print("error: --outfile requires exactly one entrypoint\n", .{});
        try stderr.flush();
        return 1;
    }
    if (options.server_components and options.target == .browser) {
        try stderr.writeAll("error: Cannot use client-side --target=browser with --server-components\n");
        try stderr.flush();
        return 1;
    }

    options.external = external.items;
    options.drop = drop.items;
    options.features = features.items;
    options.conditions = conditions.items;
    options.define_keys = define_keys.items;
    options.define_values = define_values.items;
    if (app) {
        if (entries.items.len != 1) {
            try stderr.writeAll("error: --app requires exactly one entrypoint\n");
            try stderr.flush();
            return 1;
        }
        return runBakeProductionBuild(init, entries.items[0], outdir orelse "dist");
    }
    const compile_to_standalone_html = compile and options.target == .browser and blk: {
        for (entries.items) |entry| {
            const extension = std.fs.path.extension(entry);
            if (!std.ascii.eqlIgnoreCase(extension, ".html") and !std.ascii.eqlIgnoreCase(extension, ".htm")) {
                break :blk false;
            }
        }
        break :blk entries.items.len > 0;
    };
    if (compile_to_standalone_html) {
        if (options.code_splitting) {
            try stderr.writeAll("error: cannot use --compile --target browser with --splitting\n");
            try stderr.flush();
            return 1;
        }
        options.compile_to_standalone_html = true;
        compile = false;
    }
    if (options.bytecode) {
        try stderr.writeAll("error: Bun build bytecode requires a JavaScriptCore cached-bytecode API\n");
        try stderr.flush();
        return 1;
    }
    if (compile) {
        options.target = .bun;
        options.output_format = .esm;
        const requested_source_map = options.source_map;
        // The standalone payload always embeds a normal external map. Inline
        // mode keeps it inside the executable; external/linked modes also
        // materialize the same compiler output next to the binary.
        if (requested_source_map != .none) options.source_map = .external;
        const entry_z = try allocator.dupeZ(u8, entries.items[0]);
        const payload = script_runner.compileStandaloneSource(init, entry_z, options) catch |err| {
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
        try writeStandaloneExecutable(
            init,
            destination,
            payload,
            requested_source_map == .external or requested_source_map == .linked,
        );
        if (init.environ_map.get("COTTONTAIL_BUILD_OUTPUT_MANIFEST") != null and
            (requested_source_map == .external or requested_source_map == .linked))
        {
            for (payload.source_maps) |extra_map| {
                const map_path = try standaloneExtraSourceMapPath(allocator, destination, extra_map.path);
                try stdout.print("COTTONTAIL_SOURCEMAP\t{s}\n", .{map_path});
            }
        }
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
        .features = options.features,
        .publicPath = options.public_path,
        .bundle = !options.transform_only,
        .compileToStandaloneHtml = options.compile_to_standalone_html,
        .tsconfig = options.tsconfig_override,
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
        .serverComponents = options.server_components,
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
                            if (message == .string) {
                                try stderr.print("error: {s}\n", .{message.string});
                                if (log.object.get("position")) |position| {
                                    if (position == .object) {
                                        const file = position.object.get("file");
                                        const line = position.object.get("line");
                                        const column = position.object.get("column");
                                        if (file != null and file.? == .string and
                                            line != null and line.? == .integer and
                                            column != null and column.? == .integer)
                                        {
                                            try stderr.print("    at {s}:{}:{}\n", .{
                                                file.?.string,
                                                line.?.integer,
                                                column.?.integer,
                                            });
                                        }
                                    }
                                }
                            }
                        }
                    }
                };
            }
            try stderr.flush();
            return 1;
        }
    }

    if (result.get("logs")) |logs| {
        if (logs == .array) for (logs.array.items) |log| {
            if (log != .object) continue;
            const level = log.object.get("level") orelse continue;
            const message = log.object.get("message") orelse continue;
            if (level != .string or message != .string or !std.mem.eql(u8, level.string, "warning")) continue;
            try stderr.print("warn: {s}\n", .{message.string});
        };
        try stderr.flush();
    }

    const BuildReportEntry = struct {
        name: []const u8,
        size: usize,
        kind: []const u8,
    };
    var report_entries: std.ArrayList(BuildReportEntry) = .empty;
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
            var relative_path = path_value.string;
            while (std.mem.startsWith(u8, relative_path, "./")) relative_path = relative_path[2..];
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
                const report_kind = if (output_kind != null and output_kind.? == .string)
                    if (std.mem.eql(u8, output_kind.?.string, "entry-point"))
                        "entry point"
                    else if (std.mem.eql(u8, output_kind.?.string, "sourcemap"))
                        "source map"
                    else
                        output_kind.?.string
                else
                    "output";
                try report_entries.append(allocator, .{
                    .name = try allocator.dupe(u8, std.fs.path.basename(path)),
                    .size = decoded.len,
                    .kind = report_kind,
                });
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
    if (report_entries.items.len > 0) {
        var max_name_len: usize = 0;
        var max_size_width: usize = 1;
        for (report_entries.items) |entry| {
            max_name_len = @max(max_name_len, entry.name.len);
            var size = entry.size;
            var width: usize = 1;
            while (size >= 10) : (size /= 10) width += 1;
            max_size_width = @max(max_size_width, width);
        }
        try stdout.print("Bundled {d} module{s} in 0ms\n\n", .{
            entries.items.len,
            if (entries.items.len == 1) "" else "s",
        });
        for (report_entries.items) |entry| {
            try stdout.writeAll("  ");
            try stdout.writeAll(entry.name);
            try stdout.splatByteAll(' ', max_name_len - entry.name.len + 2);
            var size = entry.size;
            var size_width: usize = 1;
            while (size >= 10) : (size /= 10) size_width += 1;
            try stdout.splatByteAll(' ', max_size_width - size_width);
            try stdout.print("{d} bytes  ({s})\n", .{ entry.size, entry.kind });
        }
        try stdout.writeByte('\n');
    }
    try stdout.flush();
    return 0;
}

fn runBunShellScript(init: std.process.Init, script_path: [:0]const u8, script_args: []const [:0]const u8) !u8 {
    const allocator = init.arena.allocator();
    if (builtin.os.tag != .windows) {
        const syntax = try std.process.run(allocator, init.io, .{
            .argv = &.{ "/bin/sh", "-n", script_path },
            .stdout_limit = .limited(1024 * 1024),
            .stderr_limit = .limited(1024 * 1024),
        });
        const syntax_code = childExitCode(syntax.term);
        if (syntax_code != 0) {
            const marker = "unexpected token `";
            const token = if (std.mem.indexOf(u8, syntax.stderr, marker)) |start| blk: {
                const value_start = start + marker.len;
                const value_end = std.mem.indexOfScalarPos(u8, syntax.stderr, value_start, '\'') orelse value_start;
                break :blk syntax.stderr[value_start..value_end];
            } else "";
            var stderr_buffer: [1024]u8 = undefined;
            var stderr_writer = std.Io.File.stderr().writer(init.io, &stderr_buffer);
            if (token.len > 0) {
                try stderr_writer.interface.print(
                    "error: Failed to run {s} due to error Unexpected '{s}'\n",
                    .{ std.fs.path.basename(script_path), token },
                );
            } else {
                try stderr_writer.interface.print(
                    "error: Failed to run {s} due to error Syntax error\n",
                    .{std.fs.path.basename(script_path)},
                );
            }
            try stderr_writer.interface.flush();
            return syntax_code;
        }
    }
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

fn appendJavaScriptStringLiteral(
    allocator: std.mem.Allocator,
    output: *std.ArrayList(u8),
    value: []const u8,
) !void {
    try output.append(allocator, '"');
    for (value) |byte| switch (byte) {
        '"' => try output.appendSlice(allocator, "\\\""),
        '\\' => try output.appendSlice(allocator, "\\\\"),
        '\n' => try output.appendSlice(allocator, "\\n"),
        '\r' => try output.appendSlice(allocator, "\\r"),
        '\t' => try output.appendSlice(allocator, "\\t"),
        else => try output.append(allocator, byte),
    };
    try output.append(allocator, '"');
}

const MultiTestEntrypoint = struct {
    path: []const u8,
    directory: []const u8,
};

fn writeMultiTestEntrypoint(
    init: std.process.Init,
    test_files: []const [:0]const u8,
) !MultiTestEntrypoint {
    const allocator = init.arena.allocator();
    const cwd_abs = try std.Io.Dir.cwd().realPathFileAlloc(init.io, ".", allocator);
    var source: std.ArrayList(u8) = .empty;

    const tmp_root = ".cottontail-tmp";
    try std.Io.Dir.cwd().createDirPath(init.io, tmp_root);
    var id: [8]u8 = undefined;
    init.io.random(&id);
    const aggregate_directory = try std.fmt.allocPrint(allocator, "{s}/test-aggregate-{x}", .{ tmp_root, id });
    try std.Io.Dir.cwd().createDirPath(init.io, aggregate_directory);
    errdefer std.Io.Dir.cwd().deleteTree(init.io, aggregate_directory) catch {};

    for (test_files, 0..) |test_file, index| {
        const absolute = if (std.fs.path.isAbsolute(test_file))
            test_file
        else
            try std.fs.path.join(allocator, &.{ cwd_abs, test_file });
        const test_directory = std.fs.path.dirname(absolute) orelse cwd_abs;
        const marker_path = try std.fmt.allocPrint(allocator, "{s}/file-{d}.mjs", .{ aggregate_directory, index });
        var marker_source: std.ArrayList(u8) = .empty;
        try marker_source.appendSlice(allocator, "import { createRequire as __ctCreateRequireForTest } from \"node:module\";\n");
        try marker_source.appendSlice(allocator, "globalThis.__ctMetaRequire = __ctCreateRequireForTest(");
        try appendJavaScriptStringLiteral(allocator, &marker_source, absolute);
        try marker_source.appendSlice(allocator, ");\nglobalThis.require = globalThis.__ctMetaRequire;\nglobalThis.__filename = ");
        try appendJavaScriptStringLiteral(allocator, &marker_source, absolute);
        try marker_source.appendSlice(allocator, ";\nglobalThis.__dirname = ");
        try appendJavaScriptStringLiteral(allocator, &marker_source, test_directory);
        try marker_source.appendSlice(allocator, ";\nglobalThis.__cottontailRegisteringTestFile = ");
        try appendJavaScriptStringLiteral(allocator, &marker_source, absolute);
        try marker_source.appendSlice(allocator, ";\n");
        try std.Io.Dir.cwd().writeFile(init.io, .{ .sub_path = marker_path, .data = marker_source.items });

        const marker_absolute = try std.fs.path.join(allocator, &.{ cwd_abs, marker_path });
        try source.appendSlice(allocator, "import ");
        try appendJavaScriptStringLiteral(allocator, &source, marker_absolute);
        try source.appendSlice(allocator, ";\nimport ");
        try appendJavaScriptStringLiteral(allocator, &source, absolute);
        try source.appendSlice(allocator, ";\n");
    }

    try source.appendSlice(allocator, "globalThis.__cottontailTestFiles = [");
    for (test_files, 0..) |test_file, index| {
        if (index > 0) try source.append(allocator, ',');
        const absolute = if (std.fs.path.isAbsolute(test_file))
            test_file
        else
            try std.fs.path.join(allocator, &.{ cwd_abs, test_file });
        try appendJavaScriptStringLiteral(allocator, &source, absolute);
    }
    try source.appendSlice(
        allocator,
        "];\nglobalThis.__cottontailTestEntrypointLoaded = true;\n" ++
            "if (typeof globalThis[Symbol.for(\"cottontail.internal.startTestRun\")] !== \"function\") {\n" ++
            "  globalThis.__cottontailNodeTestRuntime = await import(\"node:test\");\n" ++
            "  globalThis[Symbol.for(\"cottontail.internal.startTestRun\")]?.();\n" ++
            "}\n",
    );

    const path = try std.fmt.allocPrint(allocator, "{s}/entry.mjs", .{aggregate_directory});
    try std.Io.Dir.cwd().writeFile(init.io, .{ .sub_path = path, .data = source.items });
    return .{ .path = path, .directory = aggregate_directory };
}

fn runMultipleTestFilesWithBail(
    init: std.process.Init,
    args: []const [:0]const u8,
    entrypoints: []const bool,
    test_files: []const [:0]const u8,
    explicit_entrypoint_count: usize,
    bail_limit: usize,
) !u8 {
    const allocator = init.arena.allocator();
    var stdout_buffer: [256]u8 = undefined;
    var stdout_writer = std.Io.File.stdout().writer(init.io, &stdout_buffer);
    try stdout_writer.interface.print("bun test v{s} (cottontail)\n", .{testRunnerDisplayVersion(init)});
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
    var dots_mode = false;
    for (args[2..]) |arg| {
        if (std.mem.eql(u8, arg, "--dots")) {
            dots_mode = true;
            break;
        }
    }
    for (test_files) |test_file| {
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
            if (bail_limit > 0 and failed_files >= bail_limit) break;
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
    if (bail_limit > 0 and failed_files >= bail_limit and executed_files < test_files.len) {
        try stderr.print("\nBailed out after {d} failure{s}\n", .{ bail_limit, if (bail_limit == 1) "" else "s" });
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

fn openTestDirectory(io: std.Io, path: []const u8) ?std.Io.Dir {
    return if (std.fs.path.isAbsolute(path))
        std.Io.Dir.openDirAbsolute(io, path, .{ .iterate = true }) catch null
    else
        std.Io.Dir.cwd().openDir(io, path, .{ .iterate = true }) catch null;
}

fn appendTestDirectoryFiles(
    init: std.process.Init,
    allocator: std.mem.Allocator,
    root: []const u8,
    directory_value: std.Io.Dir,
    test_files: *std.ArrayList([:0]const u8),
) !void {
    var directory = directory_value;
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
        const path = try std.fs.path.join(allocator, &.{ root, entry.path });
        try test_files.append(allocator, try allocator.dupeZ(u8, path));
    }
}

fn isExplicitTestPath(path: []const u8) bool {
    return std.fs.path.isAbsolute(path) or
        std.mem.startsWith(u8, path, "./") or
        std.mem.startsWith(u8, path, "../") or
        std.mem.startsWith(u8, path, ".cottontail-tmp/") or
        std.mem.startsWith(u8, path, ".cottontail-tmp\\") or
        (builtin.os.tag == .windows and
            (std.mem.startsWith(u8, path, ".\\") or std.mem.startsWith(u8, path, "..\\")));
}

fn isGeneratedTestEntrypoint(path: []const u8) bool {
    return std.mem.startsWith(u8, path, ".cottontail-tmp/test-aggregate-") or
        std.mem.startsWith(u8, path, ".cottontail-tmp\\test-aggregate-");
}

fn testPathMatchesFilters(path: []const u8, filters: []const [:0]const u8) bool {
    if (filters.len == 0) return true;
    for (filters) |filter| {
        if (std.mem.indexOf(u8, path, filter) != null) return true;
    }
    return false;
}

fn appendDiscoveredTestFiles(
    init: std.process.Init,
    allocator: std.mem.Allocator,
    filters: []const [:0]const u8,
    test_files: *std.ArrayList([:0]const u8),
) !void {
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
        if (!testPathMatchesFilters(entry.path, filters)) continue;
        try test_files.append(allocator, try allocator.dupeZ(u8, entry.path));
    }
}

fn writeNoTestsDiagnostic(
    init: std.process.Init,
    args: []const [:0]const u8,
    filters: []const [:0]const u8,
) !u8 {
    var stdout_buffer: [128]u8 = undefined;
    var stdout_writer = std.Io.File.stdout().writer(init.io, &stdout_buffer);
    try stdout_writer.interface.print("bun test v{s} (cottontail)\n", .{testRunnerDisplayVersion(init)});
    try stdout_writer.interface.flush();

    var stderr_buffer: [1024]u8 = undefined;
    var stderr_writer = std.Io.File.stderr().writer(init.io, &stderr_buffer);
    const stderr = &stderr_writer.interface;
    if (filters.len == 0) {
        if (isTestAIAgent(init.environ_map)) {
            const cwd = try std.Io.Dir.cwd().realPathFileAlloc(init.io, ".", init.arena.allocator());
            try stderr.print(
                "error: 0 test files matching **{{.test,.spec,_test_,_spec_}}.{{js,ts,jsx,tsx}} in --cwd=\"{s}\"\n\n",
                .{cwd},
            );
        } else {
            try stderr.writeAll(
                "No tests found!\n\n" ++
                    "Tests need \".test\", \"_test_\", \".spec\" or \"_spec_\" in the filename (ex: \"MyApp.test.ts\")\n\n" ++
                    "Learn more about bun test: https://bun.com/docs/cli/test\n",
            );
        }
    } else {
        try stderr.writeAll("The following filters did not match any test files:\n");
        var file_like: ?[]const u8 = null;
        for (filters) |filter| {
            try stderr.print(" {s}", .{filter});
            const extension = std.fs.path.extension(filter);
            if (file_like == null and
                (std.mem.eql(u8, extension, ".ts") or std.mem.eql(u8, extension, ".tsx") or
                    std.mem.eql(u8, extension, ".js") or std.mem.eql(u8, extension, ".jsx")))
            {
                file_like = filter;
            }
        }
        try stderr.writeAll(
            "\n\nnote: Tests need \".test\", \"_test_\", \".spec\" or \"_spec_\" in the filename (ex: \"MyApp.test.ts\")\n",
        );
        if (file_like) |file| {
            try stderr.print("note: To treat the \"{s}\" filter as a path, run \"bun test ./{s}\"\n", .{ file, file });
        }
        try stderr.writeAll("\nLearn more about bun test: https://bun.com/docs/cli/test\n");
    }
    try stderr.flush();
    return if (testPassWithNoTests(args)) 0 else 1;
}

fn runMultipleTestFiles(init: std.process.Init, args: []const [:0]const u8) !?u8 {
    if (args.len < 2 or !std.mem.eql(u8, args[1], "test")) return null;
    const allocator = init.arena.allocator();
    const entrypoints = try testEntrypointMask(allocator, args);
    var test_files: std.ArrayList([:0]const u8) = .empty;
    var expanded_directory = false;
    var explicit_entrypoint_count: usize = 0;
    var positionals: std.ArrayList([:0]const u8) = .empty;
    for (entrypoints, 0..) |is_entrypoint, index| {
        if (!is_entrypoint) continue;
        try positionals.append(allocator, args[index]);
    }

    explicit_entrypoint_count = positionals.items.len;
    const path_mode = for (positionals.items) |path| {
        if (isExplicitTestPath(path)) break true;
    } else false;

    if (positionals.items.len == 0 or !path_mode) {
        expanded_directory = true;
        try appendDiscoveredTestFiles(init, allocator, positionals.items, &test_files);
    } else {
        for (positionals.items) |path| {
            if (openTestDirectory(init.io, path)) |directory| {
                expanded_directory = true;
                try appendTestDirectoryFiles(init, allocator, path, directory, &test_files);
            } else {
                try test_files.append(allocator, path);
            }
        }
    }
    if (expanded_directory) {
        std.mem.sort([:0]const u8, test_files.items, {}, struct {
            fn lessThan(_: void, left: [:0]const u8, right: [:0]const u8) bool {
                return std.mem.order(u8, left, right) == .lt;
            }
        }.lessThan);
    }
    const entrypoint_count = test_files.items.len;
    if (entrypoint_count == 0) {
        return try writeNoTestsDiagnostic(init, args, positionals.items);
    }
    const generated_entrypoint = positionals.items.len == 1 and isGeneratedTestEntrypoint(positionals.items[0]);
    if (entrypoint_count == 1 and !expanded_directory and
        (generated_entrypoint or !isGithubTestReporting(init.environ_map)))
    {
        if (!generated_entrypoint) {
            try init.environ_map.put("COTTONTAIL_TEST_FILE_COUNT", "1");
            _ = setenv("COTTONTAIL_TEST_FILE_COUNT", "1", 1);
        }
        return null;
    }

    if (entrypoint_count > 1) {
        if (testBailLimit(args)) |bail_limit| {
            return try runMultipleTestFilesWithBail(
                init,
                args,
                entrypoints,
                test_files.items,
                explicit_entrypoint_count,
                bail_limit,
            );
        }
    }

    const aggregate = try writeMultiTestEntrypoint(init, test_files.items);
    defer std.Io.Dir.cwd().deleteTree(init.io, aggregate.directory) catch {};

    var stdout_buffer: [256]u8 = undefined;
    var stdout_writer = std.Io.File.stdout().writer(init.io, &stdout_buffer);
    try stdout_writer.interface.print("bun test v{s} (cottontail)\n", .{testRunnerDisplayVersion(init)});
    try stdout_writer.interface.flush();
    try init.environ_map.put("COTTONTAIL_TEST_CLI_HEADER_PRINTED", "1");
    try init.environ_map.put(
        "COTTONTAIL_TEST_FILE_COUNT",
        try std.fmt.allocPrint(allocator, "{d}", .{entrypoint_count}),
    );

    const child_args = try allocator.alloc(
        []const u8,
        if (explicit_entrypoint_count > 0) args.len - explicit_entrypoint_count + 1 else args.len + 1,
    );
    child_args[0] = args[0];
    child_args[1] = args[1];
    child_args[2] = aggregate.path;
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
    return childExitCode(try child.wait(init.io));
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

const TestCliValidationError = enum {
    invalid_bail,
    invalid_timeout,
};

fn validateTestCliOptions(args: []const [:0]const u8) ?TestCliValidationError {
    if (args.len < 2 or !std.mem.eql(u8, args[1], "test")) return null;
    var index: usize = 2;
    while (index < args.len) {
        const arg = args[index];
        if (std.mem.startsWith(u8, arg, "--bail=")) {
            const value = std.fmt.parseUnsigned(usize, arg["--bail=".len..], 10) catch
                return .invalid_bail;
            if (value == 0) return .invalid_bail;
        } else if (std.mem.eql(u8, arg, "--bail") and index + 1 < args.len) {
            if (std.fmt.parseUnsigned(usize, args[index + 1], 10)) |value| {
                if (value == 0) return .invalid_bail;
                index += 1;
            } else |_| {}
        } else if (std.mem.startsWith(u8, arg, "--timeout=")) {
            _ = std.fmt.parseUnsigned(u32, arg["--timeout=".len..], 10) catch
                return .invalid_timeout;
        } else if (std.mem.eql(u8, arg, "--timeout")) {
            if (index + 1 >= args.len) return .invalid_timeout;
            _ = std.fmt.parseUnsigned(u32, args[index + 1], 10) catch
                return .invalid_timeout;
            index += 1;
        }
        index += 1;
    }
    return null;
}

fn testPassWithNoTests(args: []const [:0]const u8) bool {
    for (args[2..]) |arg| {
        if (std.mem.eql(u8, arg, "--pass-with-no-tests")) return true;
    }
    return false;
}

fn truthyAgentEnvironmentValue(value: []const u8) bool {
    return value.len > 0 and
        !std.mem.eql(u8, value, "0") and
        !std.ascii.eqlIgnoreCase(value, "false");
}

fn isTestAIAgent(environ_map: *const std.process.Environ.Map) bool {
    if (environ_map.get("AGENT")) |agent| return std.mem.eql(u8, agent, "1");
    if (environ_map.get("CLAUDECODE")) |claude| {
        if (truthyAgentEnvironmentValue(claude)) return true;
    }
    return environ_map.get("REPL_ID") != null;
}

fn isGithubTestReporting(environ_map: *const std.process.Environ.Map) bool {
    const github_actions = environ_map.get("GITHUB_ACTIONS") orelse return false;
    return truthyAgentEnvironmentValue(github_actions) and !isTestAIAgent(environ_map);
}

const GithubStackLocation = struct {
    file: []const u8,
    line: usize,
    column: usize,
};

fn githubStackLocation(output: []const u8) ?GithubStackLocation {
    var lines = std.mem.splitScalar(u8, output, '\n');
    while (lines.next()) |raw_line| {
        var line = std.mem.trim(u8, raw_line, " \t\r");
        if (!std.mem.startsWith(u8, line, "at ")) continue;
        line = std.mem.trim(u8, line["at ".len..], " \t");
        if (std.mem.endsWith(u8, line, ")")) {
            const open = std.mem.lastIndexOfScalar(u8, line, '(') orelse continue;
            line = line[open + 1 .. line.len - 1];
        }
        const column_separator = std.mem.lastIndexOfScalar(u8, line, ':') orelse continue;
        const column = std.fmt.parseUnsigned(usize, line[column_separator + 1 ..], 10) catch continue;
        const before_column = line[0..column_separator];
        const line_separator = std.mem.lastIndexOfScalar(u8, before_column, ':') orelse continue;
        const line_number = std.fmt.parseUnsigned(usize, before_column[line_separator + 1 ..], 10) catch continue;
        var file = before_column[0..line_separator];
        if (std.mem.startsWith(u8, file, "file://")) file = file["file://".len..];
        if (file.len == 0) continue;
        return .{ .file = file, .line = line_number, .column = column };
    }
    return null;
}

fn writeGithubEscaped(writer: *std.Io.Writer, value: []const u8, property: bool) !void {
    for (value) |byte| switch (byte) {
        '%' => try writer.writeAll("%25"),
        '\r' => try writer.writeAll("%0D"),
        '\n' => try writer.writeAll("%0A"),
        ':' => if (property) try writer.writeAll("%3A") else try writer.writeByte(byte),
        ',' => if (property) try writer.writeAll("%2C") else try writer.writeByte(byte),
        else => try writer.writeByte(byte),
    };
}

fn writeGithubExceptionAnnotation(writer: *std.Io.Writer, output: []const u8) !bool {
    const location = githubStackLocation(output) orelse return false;
    var lines = std.mem.splitScalar(u8, output, '\n');
    var headline: []const u8 = "Error";
    while (lines.next()) |line| {
        const trimmed = std.mem.trim(u8, line, " \t\r");
        if (trimmed.len > 0) {
            headline = trimmed;
            break;
        }
    }

    try writer.writeAll("::error file=");
    try writeGithubEscaped(writer, location.file, true);
    try writer.print(",line={d},col={d},title=", .{ location.line, location.column });
    if (std.mem.eql(u8, headline, "Error")) {
        try writer.writeAll("error");
    } else if (std.mem.startsWith(u8, headline, "Error:")) {
        try writer.writeAll("error");
        try writeGithubEscaped(writer, headline["Error".len..], false);
    } else {
        try writeGithubEscaped(writer, headline, false);
    }
    try writer.writeAll("::\n");
    return true;
}

fn runGithubTestCapture(
    init: std.process.Init,
    args: []const [:0]const u8,
    stdout: *std.Io.Writer,
    stderr: *std.Io.Writer,
) !?u8 {
    if (args.len < 2 or !std.mem.eql(u8, args[1], "test")) return null;
    if (init.environ_map.get("COTTONTAIL_TEST_GITHUB_CAPTURE") != null) return null;
    if (!isGithubTestReporting(init.environ_map)) return null;

    try init.environ_map.put("COTTONTAIL_TEST_GITHUB_CAPTURE", "1");
    defer _ = init.environ_map.swapRemove("COTTONTAIL_TEST_GITHUB_CAPTURE");
    const allocator = init.arena.allocator();
    const argv = try allocator.alloc([]const u8, args.len);
    for (args, 0..) |arg, index| argv[index] = arg;
    const result = try std.process.run(allocator, init.io, .{
        .argv = argv,
        .environ_map = init.environ_map,
        .stdout_limit = .limited(256 * 1024 * 1024),
        .stderr_limit = .limited(256 * 1024 * 1024),
    });
    const exit_code = childExitCode(result.term);
    try stdout.writeAll(result.stdout);
    try stdout.flush();
    if (exit_code != 0 and std.mem.indexOf(u8, result.stderr, "::error") == null) {
        _ = try writeGithubExceptionAnnotation(stderr, result.stderr);
    }
    try stderr.writeAll(result.stderr);
    try stderr.flush();
    return exit_code;
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
        if (std.mem.eql(u8, arg, "-")) break;
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
        .mode = if (std.mem.eql(u8, args[index], "-")) .stdin else .script,
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
                .args = args[index + 2 + @intFromBool(index + 2 < args.len and std.mem.eql(u8, args[index + 2], "--")) ..],
                .exec_args = exec_args_storage[0..exec_len],
            };
        }

        if (std.mem.startsWith(u8, arg, "--eval=")) {
            appendExecArg(exec_args_storage, &exec_len, arg);
            return .{
                .mode = .eval,
                .payload = try argAfterPrefix(allocator, arg, "--eval="),
                .args = args[index + 1 + @intFromBool(index + 1 < args.len and std.mem.eql(u8, args[index + 1], "--")) ..],
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
                .args = args[index + 2 + @intFromBool(index + 2 < args.len and std.mem.eql(u8, args[index + 2], "--")) ..],
                .exec_args = exec_args_storage[0..exec_len],
            };
        }

        if (std.mem.startsWith(u8, arg, "--print=")) {
            appendExecArg(exec_args_storage, &exec_len, arg);
            return .{
                .mode = .print,
                .payload = try argAfterPrefix(allocator, arg, "--print="),
                .args = args[index + 1 + @intFromBool(index + 1 < args.len and std.mem.eql(u8, args[index + 1], "--")) ..],
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
            .mode = if (std.mem.eql(u8, arg, "-")) .stdin else .script,
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
    var args = try argsWithBunOptions(allocator, process_args, init.environ_map);

    if (init.environ_map.get("BUN_BE_BUN") == null) {
        if (try runStandaloneIfPresent(init, args)) |exit_code| {
            if (exit_code != 0) std.process.exit(exit_code);
            return;
        }
    }
    args = try normalizeLeadingTestRuntimeFlags(allocator, args);
    args = try normalizeLeadingPackageManagerConfig(allocator, args);

    var stdout_buffer: [1024]u8 = undefined;
    var stdout_writer = std.Io.File.stdout().writer(init.io, &stdout_buffer);
    const stdout = &stdout_writer.interface;

    var stderr_buffer: [1024]u8 = undefined;
    var stderr_writer = std.Io.File.stderr().writer(init.io, &stderr_buffer);
    const stderr = &stderr_writer.interface;

    if (package_manager_bunx.detectInvocation(args)) |invocation| {
        const exit_code = try package_manager_bunx.run(init, args, invocation, stdout, stderr);
        if (exit_code != 0) std.process.exit(exit_code);
        return;
    }

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
        try stdout.print("{s}\n", .{commandDisplayVersion(init)});
        try stdout.flush();
        return;
    }

    if (std.mem.eql(u8, arg, "--revision")) {
        try stdout.print("{s}+{s}\n", .{ commandDisplayVersion(init), revision_suffix });
        try stdout.flush();
        return;
    }

    if (std.mem.eql(u8, arg, "repl")) {
        const exit_code = try repl.run(init, args[2..]);
        if (exit_code != 0) std.process.exit(exit_code);
        return;
    }

    if (std.mem.eql(u8, arg, "completions")) {
        const exit_code = try completions.run(init, args[2..], stderr);
        try stderr.flush();
        if (exit_code != 0) std.process.exit(exit_code);
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

    if (std.mem.endsWith(u8, arg, ".lockb")) {
        if (std.Io.Dir.cwd().readFileAlloc(
            init.io,
            arg,
            allocator,
            .limited(256 * 1024 * 1024),
        ) catch null) |lockfile_bytes| {
            if (package_manager_bun_lockfile.isBinaryLockfile(lockfile_bytes)) {
                try package_manager_bun_lockfile.writeYarnFromBinary(allocator, lockfile_bytes, stdout);
                try stdout.flush();
                return;
            }
        }
    }

    if (package_manager_cli.recognizes(arg)) {
        const exit_code = try package_manager_cli.run(init, args, stdout, stderr);
        if (exit_code != 0) std.process.exit(exit_code);
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

    if (try cli_run.tryRun(init, args)) |exit_code| {
        if (exit_code != 0) std.process.exit(exit_code);
        return;
    }

    if (validateTestCliOptions(args)) |validation_error| {
        switch (validation_error) {
            .invalid_bail => try stderr.writeAll("error: --bail expects a number greater than 0\n"),
            .invalid_timeout => try stderr.writeAll("error: Invalid timeout\n"),
        }
        try stderr.flush();
        std.process.exit(1);
    }

    if (try runGithubTestCapture(init, args, stdout, stderr)) |exit_code| {
        if (exit_code != 0) std.process.exit(exit_code);
        return;
    }

    if (try runMultipleTestFiles(init, args)) |exit_code| {
        if (exit_code != 0) std.process.exit(exit_code);
        return;
    }

    if (std.mem.eql(u8, arg, "test")) {
        if (init.environ_map.get("COTTONTAIL_TEST_CLI_HEADER_PRINTED") == null) {
            try stdout.print("bun test v{s} (cottontail)\n", .{testRunnerDisplayVersion(init)});
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

    if (try runHtmlEntrypoints(init, invocation)) |html_exit| {
        if (html_exit != 0) std.process.exit(html_exit);
        return;
    }

    if (invocation.mode == .script) {
        if (unsupportedEntrypointLoader(invocation.payload)) |loader| {
            if (cliPathExists(init.io, invocation.payload)) {
                try stderr.print("error: Cannot run \"{s}\" with the \"{s}\" loader\n", .{ invocation.payload, loader });
            } else {
                try stderr.print("error: File not found \"{s}\"\n", .{invocation.payload});
            }
            try stderr.flush();
            std.process.exit(1);
        }
    }

    if (invocation.mode == .script and !std.mem.eql(u8, arg, "test") and
        !(try cliBunEntrypointExists(init.io, init.arena.allocator(), invocation.payload)))
    {
        const payload = invocation.payload;
        const path_like = std.mem.indexOfScalar(u8, payload, '/') != null or
            std.mem.indexOfScalar(u8, payload, '\\') != null;
        if (!path_like) {
            if (try findPackageScripts(init.io, init.arena.allocator(), payload)) |pkg| {
                const script_exit = try runPackageScripts(init, pkg, invocation.flags, invocation.args);
                if (script_exit != 0) std.process.exit(script_exit);
                return;
            }
            if (try findAncestorBin(init.io, init.arena.allocator(), payload)) |executable| {
                const binary_exit = try runAncestorBin(init, executable, invocation.args);
                if (binary_exit != 0) std.process.exit(binary_exit);
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
    try std.testing.expect(std.mem.indexOf(u8, help_text_template, "Bun is a fast JavaScript runtime") != null);
    try std.testing.expect(std.mem.indexOf(u8, help_text_template, "JavaScriptCore") != null);
    try std.testing.expect(std.mem.indexOf(u8, help_text_template, "<entrypoint.js|entrypoint.ts>") != null);
}

test "runtime flags can precede the test command" {
    const args = [_][:0]const u8{ "cottontail", "--smol", "--conditions", "shell", "test", "suite.test.ts" };
    const normalized = try normalizeLeadingTestRuntimeFlags(std.testing.allocator, &args);
    defer std.testing.allocator.free(normalized);
    try std.testing.expectEqualStrings("test", normalized[1]);
    try std.testing.expectEqualStrings("--smol", normalized[2]);
    try std.testing.expectEqualStrings("--conditions", normalized[3]);
    try std.testing.expectEqualStrings("shell", normalized[4]);
    try std.testing.expectEqualStrings("suite.test.ts", normalized[5]);
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
        "--retry",
        "3",
    };
    const mask = try testEntrypointMask(std.testing.allocator, &args);
    defer std.testing.allocator.free(mask);
    try std.testing.expect(mask[2]);
    try std.testing.expect(mask[3]);
    try std.testing.expect(!mask[4]);
    try std.testing.expect(!mask[5]);
    try std.testing.expect(!mask[6]);
    try std.testing.expect(!mask[7]);
    try std.testing.expect(!mask[8]);
}

test "bare bail keeps a following test filter positional" {
    const args = [_][:0]const u8{ "cottontail", "test", "--bail", "suite.test.ts" };
    try std.testing.expectEqual(@as(?usize, 3), testEntrypointIndex(&args));
    const numeric = [_][:0]const u8{ "cottontail", "test", "--bail", "3", "suite.test.ts" };
    try std.testing.expectEqual(@as(?usize, 4), testEntrypointIndex(&numeric));
}

test "test CLI validation rejects invalid bail and timeout values" {
    const bail_text = [_][:0]const u8{ "cottontail", "test", "--bail=wat" };
    const bail_zero = [_][:0]const u8{ "cottontail", "test", "--bail=0" };
    const timeout_text = [_][:0]const u8{ "cottontail", "test", "--timeout", "wat" };
    const valid = [_][:0]const u8{ "cottontail", "test", "--bail", "3", "--timeout=50" };
    try std.testing.expectEqual(TestCliValidationError.invalid_bail, validateTestCliOptions(&bail_text).?);
    try std.testing.expectEqual(TestCliValidationError.invalid_bail, validateTestCliOptions(&bail_zero).?);
    try std.testing.expectEqual(TestCliValidationError.invalid_timeout, validateTestCliOptions(&timeout_text).?);
    try std.testing.expectEqual(@as(?TestCliValidationError, null), validateTestCliOptions(&valid));
}

test "Bun test positionals distinguish path mode from substring filters" {
    try std.testing.expect(isExplicitTestPath("./index.ts"));
    try std.testing.expect(isExplicitTestPath("../tests"));
    try std.testing.expect(!isExplicitTestPath("index.ts"));
    const filters = [_][:0]const u8{ "unit", "network" };
    try std.testing.expect(testPathMatchesFilters("src/unit/math.test.ts", &filters));
    try std.testing.expect(testPathMatchesFilters("test/network/socket.test.ts", &filters));
    try std.testing.expect(!testPathMatchesFilters("test/compiler/parser.test.ts", &filters));
    try std.testing.expect(isGeneratedTestEntrypoint(".cottontail-tmp/test-aggregate-abcd/entry.mjs"));
}

test "GitHub test capture locates source frames from host exception output" {
    const output =
        "Error\n" ++
        "    at /tmp/project/example.test.ts:3:14\n" ++
        "    at /tmp/project/.cottontail-tmp/entry.mjs:1:1\n";
    const location = githubStackLocation(output).?;
    try std.testing.expectEqualStrings("/tmp/project/example.test.ts", location.file);
    try std.testing.expectEqual(@as(usize, 3), location.line);
    try std.testing.expectEqual(@as(usize, 14), location.column);
}

test "pass-with-no-tests controls empty test discovery exit policy" {
    const enabled = [_][:0]const u8{ "cottontail", "test", "--pass-with-no-tests" };
    const disabled = [_][:0]const u8{ "cottontail", "test" };
    try std.testing.expect(testPassWithNoTests(&enabled));
    try std.testing.expect(!testPassWithNoTests(&disabled));
}

test "test AI-agent detection follows Bun environment precedence" {
    var environ = std.process.Environ.Map.init(std.testing.allocator);
    defer environ.deinit();
    try environ.put("CLAUDECODE", "1");
    try std.testing.expect(isTestAIAgent(&environ));
    try environ.put("AGENT", "false");
    try std.testing.expect(!isTestAIAgent(&environ));
    try environ.put("AGENT", "1");
    try std.testing.expect(isTestAIAgent(&environ));
}

test {
    _ = script_runner;
}
