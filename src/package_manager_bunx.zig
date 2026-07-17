const std = @import("std");
const builtin = @import("builtin");

const version = @import("version.zig").version;
const bun_compat_version = "1.3.10";
const cache_valid_ns: i128 = 24 * std.time.ns_per_hour;

pub const Invocation = struct {
    args_start: usize,
    force_runtime: bool = false,
    argv0_alias: bool = false,
};

const Options = struct {
    package_spec: []const u8,
    binary_name: ?[]const u8 = null,
    passthrough: []const [:0]const u8,
    verbose_install: bool = false,
    silent_install: bool = false,
    no_install: bool = false,
    force_runtime: bool = false,
    specified_package: bool = false,
};

const ParseResult = union(enum) {
    options: Options,
    version,
    revision,
    usage,
    package_missing,
    package_empty,
    binary_missing,
};

const Request = struct {
    install_param: []const u8,
    result_package_name: ?[]const u8,
    initial_bin_name: []const u8,
    package_format: []const u8,
    display_name: []const u8,
    explicit_version: bool,
    dist_tag: bool,
    initial_bin_is_scoped_guess: bool,
};

const ResolvedBin = struct {
    name: []const u8,
    path: []const u8,
};

const ExecutableKind = enum {
    native,
    node_script,
    bun_script,
    javascript,
};

pub fn detectInvocation(args: []const [:0]const u8) ?Invocation {
    if (args.len == 0) return null;
    if (isBunxArgv0(args[0])) {
        return .{ .args_start = 1, .argv0_alias = true };
    }

    var index: usize = 1;
    var force_runtime = false;
    while (index < args.len and
        (std.mem.eql(u8, args[index], "--bun") or std.mem.eql(u8, args[index], "-b"))) : (index += 1)
    {
        force_runtime = true;
    }
    if (index >= args.len) return null;
    if (!std.mem.eql(u8, args[index], "x") and !std.mem.eql(u8, args[index], "bunx")) return null;
    return .{ .args_start = index + 1, .force_runtime = force_runtime };
}

pub fn run(
    init: std.process.Init,
    args: []const [:0]const u8,
    invocation: Invocation,
    stdout: *std.Io.Writer,
    stderr: *std.Io.Writer,
) !u8 {
    const allocator = init.arena.allocator();
    const parsed = parseOptions(args, invocation);
    const options = switch (parsed) {
        .version => {
            try stdout.print("{s}\n", .{version});
            try stdout.flush();
            return 0;
        },
        .revision => {
            try stdout.print("{s}+cottontail\n", .{version});
            try stdout.flush();
            return 0;
        },
        .usage => {
            try printUsage(stderr);
            try stderr.flush();
            return 1;
        },
        .package_missing => {
            try stderr.writeAll("error: --package requires a package name\n");
            try stderr.flush();
            return 1;
        },
        .package_empty => {
            try stderr.writeAll("error: --package requires a non-empty package name\n");
            try stderr.flush();
            return 1;
        },
        .binary_missing => {
            try stderr.writeAll("error: When using --package, you must specify the binary to run\n");
            try stderr.writeAll("  usage: bunx --package=<package-name> <binary-name> [args...]\n");
            try stderr.flush();
            return 1;
        },
        .options => |value| value,
    };

    const invocation_dir = try std.Io.Dir.cwd().realPathFileAlloc(init.io, ".", allocator);
    const request = try makeRequest(allocator, invocation_dir, options);
    const local_bin_dirs = try collectLocalBinDirs(init, allocator, invocation_dir);
    const temp_dir = platformTempDir(init.environ_map);
    const uid = userUniqueId(init.environ_map);
    const cache_dir = try std.fs.path.join(allocator, &.{
        temp_dir,
        try std.fmt.allocPrint(allocator, "bunx-{d}-{s}", .{ uid, request.package_format }),
    });
    const cache_bin_dir = try std.fs.path.join(allocator, &.{ cache_dir, "node_modules", ".bin" });

    var environment = try init.environ_map.clone(allocator);
    defer environment.deinit();
    try configureEnvironment(init, allocator, &environment, cache_bin_dir, local_bin_dirs, options.package_spec);

    const can_use_unversioned_path = !request.explicit_version;
    if (can_use_unversioned_path) {
        if (try findExecutableInDirectories(init.io, allocator, local_bin_dirs, request.initial_bin_name)) |path| {
            return runBinary(init, allocator, &environment, invocation_dir, path, options.passthrough, options.force_runtime);
        }

        if (!request.initial_bin_is_scoped_guess) {
            if (try findExecutableInPath(
                init.io,
                allocator,
                init.environ_map.get("PATH") orelse "",
                request.initial_bin_name,
            )) |path| {
                return runBinary(init, allocator, &environment, invocation_dir, path, options.passthrough, options.force_runtime);
            }
        }

        if (request.result_package_name) |package_name| {
            if (try findLocalPackageBin(
                init.io,
                allocator,
                invocation_dir,
                package_name,
                options.binary_name,
            )) |bin| {
                return runBinary(init, allocator, &environment, invocation_dir, bin.path, options.passthrough, options.force_runtime);
            }
        }
    }

    const cache_is_stale = !request.explicit_version and isCacheStale(init.io, cache_dir);
    if (!request.dist_tag) {
        if (try findCachedBin(
            init.io,
            allocator,
            cache_dir,
            request.initial_bin_name,
            request.result_package_name,
            options.binary_name,
        )) |bin| {
            if (!cache_is_stale or options.no_install) {
                if (cache_is_stale) {
                    try stderr.print(
                        "warn: Using a stale installation of {s} because --no-install was passed. Run `bunx` without --no-install to use a fresh binary.\n",
                        .{request.display_name},
                    );
                    try stderr.flush();
                }
                return runBinary(init, allocator, &environment, invocation_dir, bin.path, options.passthrough, options.force_runtime);
            }
        }
    }

    if (options.no_install) {
        try stderr.print(
            "error: Could not find an existing '{s}' binary to run. Stopping because --no-install was passed.\n",
            .{request.initial_bin_name},
        );
        try stderr.flush();
        return 1;
    }

    if (cache_is_stale) {
        std.Io.Dir.cwd().deleteTree(init.io, cache_dir) catch {};
    }
    try std.Io.Dir.cwd().createDirPath(init.io, cache_dir);
    try std.Io.Dir.cwd().writeFile(init.io, .{ .sub_path = try std.fs.path.join(allocator, &.{ cache_dir, "package.json" }), .data = "{}\n" });

    const install_code = try installPackage(
        init,
        allocator,
        &environment,
        cache_dir,
        request.install_param,
        options,
        cache_is_stale or request.dist_tag,
        stderr,
    );
    if (install_code != 0) return install_code;

    if (try findCachedBin(
        init.io,
        allocator,
        cache_dir,
        request.initial_bin_name,
        request.result_package_name,
        options.binary_name,
    )) |bin| {
        return runBinary(init, allocator, &environment, invocation_dir, bin.path, options.passthrough, options.force_runtime);
    }

    if (options.specified_package and options.binary_name != null) {
        try stderr.print(
            "error: Package {s} does not provide a binary named {s}\n",
            .{ request.display_name, options.binary_name.? },
        );
        try stderr.print("  hint: try running without --package to install and run {s} directly\n", .{options.binary_name.?});
    } else {
        try stderr.print("error: could not determine executable to run for package {s}\n", .{request.display_name});
    }
    try stderr.flush();
    return 1;
}

fn parseOptions(args: []const [:0]const u8, invocation: Invocation) ParseResult {
    var index = invocation.args_start;
    var specified_package: ?[]const u8 = null;
    var verbose_install = false;
    var silent_install = false;
    var no_install = false;
    var force_runtime = invocation.force_runtime;
    var has_version = false;
    var has_revision = false;

    while (index < args.len) : (index += 1) {
        const arg = args[index];
        if (!std.mem.startsWith(u8, arg, "-") or std.mem.eql(u8, arg, "-")) {
            if (specified_package) |package_spec| {
                return .{ .options = .{
                    .package_spec = package_spec,
                    .binary_name = arg,
                    .passthrough = args[index + 1 ..],
                    .verbose_install = verbose_install,
                    .silent_install = silent_install,
                    .no_install = no_install,
                    .force_runtime = force_runtime,
                    .specified_package = true,
                } };
            }
            return .{ .options = .{
                .package_spec = arg,
                .passthrough = args[index + 1 ..],
                .verbose_install = verbose_install,
                .silent_install = silent_install,
                .no_install = no_install,
                .force_runtime = force_runtime,
            } };
        }

        if (std.mem.eql(u8, arg, "--version") or std.mem.eql(u8, arg, "-v")) {
            has_version = true;
        } else if (std.mem.eql(u8, arg, "--revision")) {
            has_revision = true;
        } else if (std.mem.eql(u8, arg, "--verbose")) {
            verbose_install = true;
        } else if (std.mem.eql(u8, arg, "--silent")) {
            silent_install = true;
        } else if (std.mem.eql(u8, arg, "--bun") or std.mem.eql(u8, arg, "-b")) {
            force_runtime = true;
        } else if (std.mem.eql(u8, arg, "--no-install")) {
            no_install = true;
        } else if (std.mem.eql(u8, arg, "--package") or std.mem.eql(u8, arg, "-p")) {
            index += 1;
            if (index >= args.len) return .package_missing;
            if (args[index].len == 0) return .package_empty;
            specified_package = args[index];
        } else if (std.mem.startsWith(u8, arg, "--package=")) {
            const value = arg["--package=".len..];
            if (value.len == 0) return .package_empty;
            specified_package = value;
        } else if (std.mem.startsWith(u8, arg, "-p=")) {
            const value = arg["-p=".len..];
            if (value.len == 0) return .package_empty;
            specified_package = value;
        }
    }

    if (specified_package != null) return .binary_missing;
    if (has_revision) return .revision;
    if (has_version) return .version;
    return .usage;
}

fn makeRequest(
    allocator: std.mem.Allocator,
    invocation_dir: []const u8,
    options: Options,
) !Request {
    const parsed = splitRegistrySpec(options.package_spec);
    if (parsed) |parts| {
        var package_name = parts.name;
        var initial_alias: ?[]const u8 = null;
        if (!options.specified_package and std.mem.eql(u8, package_name, "tsc")) {
            package_name = "typescript";
            initial_alias = "tsc";
        } else if (!options.specified_package and std.mem.eql(u8, package_name, "claude")) {
            package_name = "@anthropic-ai/claude-code";
            initial_alias = "claude";
        }

        const display_version = if (parts.explicit_version) parts.version else "latest";
        const source_version = isSourceVersion(parts.version);
        const install_param = if (source_version and initial_alias == null)
            options.package_spec
        else
            try std.fmt.allocPrint(allocator, "{s}@{s}", .{ package_name, display_version });
        const initial_bin_name = options.binary_name orelse initial_alias orelse normalizedBinName(package_name);
        const is_scoped_guess = options.binary_name == null and initial_alias == null and package_name.len > 0 and package_name[0] == '@';
        return .{
            .install_param = install_param,
            .result_package_name = package_name,
            .initial_bin_name = initial_bin_name,
            .package_format = try packageFormat(allocator, package_name, display_version, initial_bin_name, source_version),
            .display_name = package_name,
            .explicit_version = parts.explicit_version,
            .dist_tag = parts.explicit_version and !source_version and isDistTag(parts.version),
            .initial_bin_is_scoped_guess = is_scoped_guess,
        };
    }

    const normalized_spec = try normalizeSourceSpec(allocator, invocation_dir, options.package_spec);
    const initial_bin_name = options.binary_name orelse sourceBinGuess(options.package_spec);
    return .{
        .install_param = normalized_spec,
        .result_package_name = null,
        .initial_bin_name = initial_bin_name,
        .package_format = try packageFormat(allocator, options.package_spec, "source", initial_bin_name, true),
        .display_name = options.package_spec,
        .explicit_version = true,
        .dist_tag = false,
        .initial_bin_is_scoped_guess = false,
    };
}

const RegistrySpec = struct {
    name: []const u8,
    version: []const u8,
    explicit_version: bool,
};

fn splitRegistrySpec(input: []const u8) ?RegistrySpec {
    if (isSourceSpec(input)) return null;
    if (input.len == 0) return null;
    if (input[0] == '@') {
        const slash = std.mem.indexOfScalar(u8, input, '/') orelse return .{ .name = input, .version = "latest", .explicit_version = false };
        if (std.mem.indexOfScalarPos(u8, input, slash + 1, '@')) |at| {
            return .{
                .name = input[0..at],
                .version = if (at + 1 < input.len) input[at + 1 ..] else "latest",
                .explicit_version = true,
            };
        }
        return .{ .name = input, .version = "latest", .explicit_version = false };
    }
    if (std.mem.indexOfScalar(u8, input, '@')) |at| {
        if (at > 0) {
            return .{
                .name = input[0..at],
                .version = if (at + 1 < input.len) input[at + 1 ..] else "latest",
                .explicit_version = true,
            };
        }
    }
    return .{ .name = input, .version = "latest", .explicit_version = false };
}

fn isSourceSpec(input: []const u8) bool {
    return std.mem.eql(u8, input, ".") or
        std.mem.endsWith(u8, input, ".tgz") or
        std.mem.endsWith(u8, input, ".tar.gz") or
        std.mem.startsWith(u8, input, "github:") or
        std.mem.startsWith(u8, input, "git+") or
        std.mem.startsWith(u8, input, "git://") or
        std.mem.startsWith(u8, input, "ssh://") or
        std.mem.startsWith(u8, input, "git@") or
        std.mem.startsWith(u8, input, "http://") or
        std.mem.startsWith(u8, input, "https://") or
        std.mem.startsWith(u8, input, "file:") or
        std.mem.startsWith(u8, input, "link:") or
        std.mem.startsWith(u8, input, "./") or
        std.mem.startsWith(u8, input, "../") or
        (builtin.os.tag == .windows and
            (std.mem.startsWith(u8, input, ".\\") or std.mem.startsWith(u8, input, "..\\"))) or
        std.fs.path.isAbsolute(input) or
        (std.mem.indexOfScalar(u8, input, '/') != null and input[0] != '@');
}

fn isSourceVersion(version_value: []const u8) bool {
    return std.mem.startsWith(u8, version_value, "npm:") or
        std.mem.startsWith(u8, version_value, "github:") or
        std.mem.startsWith(u8, version_value, "git+") or
        std.mem.startsWith(u8, version_value, "git://") or
        std.mem.startsWith(u8, version_value, "ssh://") or
        std.mem.startsWith(u8, version_value, "file:") or
        std.mem.startsWith(u8, version_value, "link:") or
        std.mem.startsWith(u8, version_value, "http://") or
        std.mem.startsWith(u8, version_value, "https://");
}

fn isDistTag(value: []const u8) bool {
    if (value.len == 0) return true;
    if (std.ascii.isDigit(value[0])) return false;
    if (value[0] == 'v' and value.len > 1 and std.ascii.isDigit(value[1])) return false;
    return switch (value[0]) {
        '^', '~', '<', '>', '=', '*', '.', '-' => false,
        else => std.mem.indexOfAny(u8, value, "*xX") == null,
    };
}

fn normalizeSourceSpec(allocator: std.mem.Allocator, cwd: []const u8, spec: []const u8) ![]const u8 {
    if (std.mem.startsWith(u8, spec, "file:") or std.mem.startsWith(u8, spec, "link:")) {
        const prefix = if (std.mem.startsWith(u8, spec, "file:")) "file:" else "link:";
        const path = spec[prefix.len..];
        if (path.len == 0 or std.fs.path.isAbsolute(path)) return spec;
        return try std.fmt.allocPrint(allocator, "{s}{s}", .{ prefix, try std.fs.path.resolve(allocator, &.{ cwd, path }) });
    }
    if (std.mem.eql(u8, spec, ".") or
        std.mem.startsWith(u8, spec, "./") or
        std.mem.startsWith(u8, spec, "../") or
        (builtin.os.tag == .windows and
            (std.mem.startsWith(u8, spec, ".\\") or std.mem.startsWith(u8, spec, "..\\"))) or
        std.mem.endsWith(u8, spec, ".tgz") or
        std.mem.endsWith(u8, spec, ".tar.gz"))
    {
        return std.fs.path.resolve(allocator, &.{ cwd, spec });
    }
    return spec;
}

fn sourceBinGuess(spec: []const u8) []const u8 {
    var value = spec;
    if (std.mem.startsWith(u8, value, "github:")) value = value["github:".len..];
    if (std.mem.indexOfScalar(u8, value, '#')) |hash| value = value[0..hash];
    while (value.len > 0 and (value[value.len - 1] == '/' or value[value.len - 1] == '\\')) value = value[0 .. value.len - 1];
    const base = std.fs.path.basename(value);
    return if (std.mem.endsWith(u8, base, ".git")) base[0 .. base.len - ".git".len] else base;
}

fn packageFormat(
    allocator: std.mem.Allocator,
    name: []const u8,
    display_version: []const u8,
    initial_bin_name: []const u8,
    force_hash: bool,
) ![]const u8 {
    const banned = if (builtin.os.tag == .windows) ":*?<>|;" else ":";
    if (force_hash or std.mem.indexOfAny(u8, name, banned) != null or std.mem.indexOfAny(u8, display_version, banned) != null) {
        const name_hash = std.hash.Wyhash.hash(0, name);
        const version_hash = std.hash.Wyhash.hash(name_hash, display_version);
        return std.fmt.allocPrint(allocator, "{s}@source@{x}", .{ initial_bin_name, version_hash });
    }
    return std.fmt.allocPrint(allocator, "{s}@{s}", .{ name, display_version });
}

fn normalizedBinName(name: []const u8) []const u8 {
    if (std.mem.lastIndexOfAny(u8, name, "/\\:")) |index| return name[index + 1 ..];
    return name;
}

fn collectLocalBinDirs(
    init: std.process.Init,
    allocator: std.mem.Allocator,
    cwd: []const u8,
) ![]const []const u8 {
    var dirs = std.array_list.Managed([]const u8).init(allocator);
    const ignored = init.environ_map.get("BUN_WHICH_IGNORE_CWD");
    var current = cwd;
    while (true) {
        const bin_dir = try std.fs.path.join(allocator, &.{ current, "node_modules", ".bin" });
        if (ignored == null or !pathsLexicallyEqual(bin_dir, ignored.?)) try dirs.append(bin_dir);
        const parent = std.fs.path.dirname(current) orelse break;
        if (std.mem.eql(u8, parent, current)) break;
        current = parent;
    }
    return dirs.toOwnedSlice();
}

fn pathsLexicallyEqual(left: []const u8, right: []const u8) bool {
    if (builtin.os.tag == .windows) return std.ascii.eqlIgnoreCase(left, right);
    return std.mem.eql(u8, left, right);
}

fn platformTempDir(environment: *const std.process.Environ.Map) []const u8 {
    return nonEmptyEnvironment(environment, "BUN_TMPDIR") orelse
        nonEmptyEnvironment(environment, "TMPDIR") orelse
        nonEmptyEnvironment(environment, "TEMP") orelse
        nonEmptyEnvironment(environment, "TMP") orelse
        if (builtin.os.tag == .windows) "." else "/tmp";
}

fn nonEmptyEnvironment(environment: *const std.process.Environ.Map, name: []const u8) ?[]const u8 {
    const value = environment.get(name) orelse return null;
    return if (value.len > 0) value else null;
}

fn userUniqueId(environment: *const std.process.Environ.Map) u64 {
    if (builtin.os.tag != .windows) return @intCast(std.c.getuid());
    const identity = environment.get("USERPROFILE") orelse environment.get("USERNAME") orelse "cottontail";
    return std.hash.Wyhash.hash(0, identity);
}

fn configureEnvironment(
    init: std.process.Init,
    allocator: std.mem.Allocator,
    environment: *std.process.Environ.Map,
    cache_bin_dir: []const u8,
    local_bin_dirs: []const []const u8,
    lifecycle_script: []const u8,
) !void {
    try environment.put("npm_command", "exec");
    try environment.put("npm_lifecycle_event", "bunx");
    try environment.put("npm_lifecycle_script", lifecycle_script);
    try environment.put("npm_config_user_agent", "bun/" ++ bun_compat_version ++ " npm/? node/? cottontail");

    const executable = try std.process.executablePathAlloc(init.io, allocator);
    try environment.put("BUN", executable);
    try environment.put("npm_execpath", executable);
    try environment.put("npm_node_execpath", executable);

    var path: std.Io.Writer.Allocating = .init(allocator);
    try path.writer.writeAll(cache_bin_dir);
    for (local_bin_dirs) |bin_dir| {
        try path.writer.writeByte(std.fs.path.delimiter);
        try path.writer.writeAll(bin_dir);
    }
    if (environment.get("PATH")) |original| {
        if (original.len > 0) {
            try path.writer.writeByte(std.fs.path.delimiter);
            try path.writer.writeAll(original);
        }
    }
    try environment.put("PATH", try path.toOwnedSlice());
}

fn findExecutableInDirectories(
    io: std.Io,
    allocator: std.mem.Allocator,
    directories: []const []const u8,
    name: []const u8,
) !?[]const u8 {
    for (directories) |directory| {
        if (try executableInDirectory(io, allocator, directory, name)) |path| return path;
    }
    return null;
}

fn findExecutableInPath(
    io: std.Io,
    allocator: std.mem.Allocator,
    path_value: []const u8,
    name: []const u8,
) !?[]const u8 {
    var iterator = std.mem.tokenizeScalar(u8, path_value, std.fs.path.delimiter);
    while (iterator.next()) |directory| {
        if (try executableInDirectory(io, allocator, directory, name)) |path| return path;
    }
    return null;
}

fn executableInDirectory(
    io: std.Io,
    allocator: std.mem.Allocator,
    directory: []const u8,
    name: []const u8,
) !?[]const u8 {
    if (directory.len == 0) return null;
    if (builtin.os.tag == .windows and std.fs.path.extension(name).len == 0) {
        for ([_][]const u8{ ".exe", ".cmd", ".bat", ".com", "" }) |suffix| {
            const candidate = try std.fs.path.join(allocator, &.{ directory, try std.mem.concat(allocator, u8, &.{ name, suffix }) });
            if (isFile(io, candidate)) return candidate;
        }
        return null;
    }
    const candidate = try std.fs.path.join(allocator, &.{ directory, name });
    return if (isFile(io, candidate)) candidate else null;
}

fn isFile(io: std.Io, path: []const u8) bool {
    const stat = std.Io.Dir.cwd().statFile(io, path, .{}) catch return false;
    return stat.kind == .file or stat.kind == .sym_link;
}

fn findLocalPackageBin(
    io: std.Io,
    allocator: std.mem.Allocator,
    cwd: []const u8,
    package_name: []const u8,
    desired_bin: ?[]const u8,
) !?ResolvedBin {
    var current = cwd;
    while (true) {
        const package_dir = try std.fs.path.join(allocator, &.{ current, "node_modules", package_name });
        if (try packageBin(io, allocator, package_dir, desired_bin)) |bin| return bin;
        const parent = std.fs.path.dirname(current) orelse break;
        if (std.mem.eql(u8, parent, current)) break;
        current = parent;
    }
    return null;
}

fn findInstalledBin(
    io: std.Io,
    allocator: std.mem.Allocator,
    root: []const u8,
    package_name: ?[]const u8,
    desired_bin: ?[]const u8,
) !?ResolvedBin {
    if (package_name) |name| {
        const package_dir = try std.fs.path.join(allocator, &.{ root, "node_modules", name });
        if (try packageBin(io, allocator, package_dir, desired_bin)) |bin| return bin;
    }

    const root_manifest_path = try std.fs.path.join(allocator, &.{ root, "package.json" });
    const source = std.Io.Dir.cwd().readFileAlloc(io, root_manifest_path, allocator, .limited(16 * 1024 * 1024)) catch null;
    if (source) |contents| {
        if (std.json.parseFromSliceLeaky(std.json.Value, allocator, contents, .{}) catch null) |manifest| {
            if (manifest == .object) {
                const dependencies = manifest.object.get("dependencies");
                if (dependencies != null and dependencies.? == .object) {
                    for (dependencies.?.object.keys()) |name| {
                        const package_dir = try std.fs.path.join(allocator, &.{ root, "node_modules", name });
                        if (try packageBin(io, allocator, package_dir, desired_bin)) |bin| return bin;
                    }
                }
            }
        }
    }

    const bin_name = desired_bin orelse return null;
    const linked = try executableInDirectory(io, allocator, try std.fs.path.join(allocator, &.{ root, "node_modules", ".bin" }), bin_name);
    if (linked) |path| return .{ .name = bin_name, .path = path };
    return null;
}

fn findCachedBin(
    io: std.Io,
    allocator: std.mem.Allocator,
    root: []const u8,
    initial_bin_name: []const u8,
    package_name: ?[]const u8,
    desired_bin: ?[]const u8,
) !?ResolvedBin {
    const bin_dir = try std.fs.path.join(allocator, &.{ root, "node_modules", ".bin" });
    if (try executableInDirectory(io, allocator, bin_dir, initial_bin_name)) |path| {
        return .{ .name = initial_bin_name, .path = path };
    }
    return findInstalledBin(io, allocator, root, package_name, desired_bin);
}

fn packageBin(
    io: std.Io,
    allocator: std.mem.Allocator,
    package_dir: []const u8,
    desired_bin: ?[]const u8,
) !?ResolvedBin {
    const package_json_path = try std.fs.path.join(allocator, &.{ package_dir, "package.json" });
    const source = std.Io.Dir.cwd().readFileAlloc(io, package_json_path, allocator, .limited(16 * 1024 * 1024)) catch return null;
    const manifest = std.json.parseFromSliceLeaky(std.json.Value, allocator, source, .{}) catch return null;
    if (manifest != .object) return null;

    if (manifest.object.get("bin")) |bin| {
        if (bin == .string) {
            const package_name = if (manifest.object.get("name")) |name| if (name == .string) name.string else "" else "";
            const bin_name = normalizedBinName(package_name);
            if (desired_bin != null and !std.mem.eql(u8, desired_bin.?, bin_name)) return null;
            const target = try std.fs.path.join(allocator, &.{ package_dir, bin.string });
            return if (isFile(io, target)) .{ .name = bin_name, .path = target } else null;
        }
        if (bin == .object) {
            for (bin.object.keys(), bin.object.values()) |name, value| {
                if (value != .string or name.len == 0) continue;
                const normalized_name = normalizedBinName(name);
                if (desired_bin != null and !std.mem.eql(u8, desired_bin.?, normalized_name)) continue;
                const target = try std.fs.path.join(allocator, &.{ package_dir, value.string });
                if (isFile(io, target)) return .{ .name = normalized_name, .path = target };
            }
            return null;
        }
    }

    const directories = manifest.object.get("directories") orelse return null;
    if (directories != .object) return null;
    const bin_dir_value = directories.object.get("bin") orelse return null;
    if (bin_dir_value != .string) return null;
    const bin_dir = try std.fs.path.join(allocator, &.{ package_dir, bin_dir_value.string });
    var directory = std.Io.Dir.cwd().openDir(io, bin_dir, .{ .iterate = true }) catch return null;
    defer directory.close(io);
    var iterator = directory.iterate();
    while (try iterator.next(io)) |entry| {
        if (entry.kind != .file) continue;
        const name = normalizedBinName(entry.name);
        if (desired_bin != null and !std.mem.eql(u8, desired_bin.?, name)) continue;
        return .{ .name = name, .path = try std.fs.path.join(allocator, &.{ bin_dir, entry.name }) };
    }
    return null;
}

fn isCacheStale(io: std.Io, cache_dir: []const u8) bool {
    var path_buffer: [std.fs.max_path_bytes]u8 = undefined;
    const package_json_path = std.fmt.bufPrint(&path_buffer, "{s}{c}package.json", .{ cache_dir, std.fs.path.sep }) catch return true;
    const stat = std.Io.Dir.cwd().statFile(io, package_json_path, .{}) catch return false;
    const age = std.Io.Clock.real.now(io).nanoseconds - stat.mtime.nanoseconds;
    return age > cache_valid_ns;
}

fn installPackage(
    init: std.process.Init,
    allocator: std.mem.Allocator,
    environment: *std.process.Environ.Map,
    cache_dir: []const u8,
    install_param: []const u8,
    options: Options,
    cache_bust: bool,
    stderr: *std.Io.Writer,
) !u8 {
    try environment.put("BUN_INTERNAL_BUNX_INSTALL", "true");
    const executable = try std.process.executablePathAlloc(init.io, allocator);
    var argv = std.array_list.Managed([]const u8).init(allocator);
    try argv.appendSlice(&.{ executable, "add", install_param, "--no-summary" });
    if (cache_bust) try argv.appendSlice(&.{ "--no-cache", "--force" });
    if (options.verbose_install) try argv.append("--verbose");
    if (options.silent_install) try argv.append("--silent");

    var child = std.process.spawn(init.io, .{
        .argv = argv.items,
        .cwd = .{ .path = cache_dir },
        .environ_map = environment,
        .stdin = .inherit,
        .stdout = .inherit,
        .stderr = .inherit,
        .create_no_window = true,
    }) catch |err| {
        try stderr.print("error: bunx failed to install {s}: {s}\n", .{ install_param, @errorName(err) });
        try stderr.flush();
        return 1;
    };
    defer child.kill(init.io);
    return childExitCode(try child.wait(init.io));
}

fn runBinary(
    init: std.process.Init,
    allocator: std.mem.Allocator,
    environment: *std.process.Environ.Map,
    cwd: []const u8,
    path: []const u8,
    passthrough: []const [:0]const u8,
    force_runtime: bool,
) !u8 {
    const resolved = std.Io.Dir.cwd().realPathFileAlloc(init.io, path, allocator) catch path;
    const executable_kind = classifyExecutable(init.io, resolved);
    const is_script = executable_kind != .native;
    const node_executable = if (is_script and !force_runtime and executable_kind != .bun_script)
        try findExecutableInPath(init.io, allocator, environment.get("PATH") orelse "", "node")
    else
        null;
    const use_runtime = is_script and (force_runtime or executable_kind == .bun_script or node_executable == null);
    const use_node = is_script and !use_runtime and node_executable != null;
    const executable = if (use_runtime)
        try std.process.executablePathAlloc(init.io, allocator)
    else if (use_node)
        node_executable.?
    else
        resolved;
    if (use_node) {
        try environment.put("NODE", executable);
        try environment.put("npm_node_execpath", executable);
    }
    const extra = if (use_runtime or use_node) @as(usize, 1) else 0;
    var argv = try allocator.alloc([]const u8, passthrough.len + 1 + extra);
    argv[0] = executable;
    if (use_runtime or use_node) argv[1] = resolved;
    for (passthrough, 0..) |arg, index| argv[index + 1 + extra] = arg;

    if (builtin.os.tag == .windows and !use_runtime and !use_node and
        (std.ascii.eqlIgnoreCase(std.fs.path.extension(resolved), ".cmd") or
            std.ascii.eqlIgnoreCase(std.fs.path.extension(resolved), ".bat")))
    {
        var command = std.Io.Writer.Allocating.init(allocator);
        try appendWindowsShellArg(&command.writer, resolved);
        for (passthrough) |arg| {
            try command.writer.writeByte(' ');
            try appendWindowsShellArg(&command.writer, arg);
        }
        argv = try allocator.alloc([]const u8, 5);
        argv[0] = "cmd.exe";
        argv[1] = "/d";
        argv[2] = "/s";
        argv[3] = "/c";
        argv[4] = try command.toOwnedSlice();
    }

    var child = try std.process.spawn(init.io, .{
        .argv = argv,
        .cwd = .{ .path = cwd },
        .environ_map = environment,
        .stdin = .inherit,
        .stdout = .inherit,
        .stderr = .inherit,
        .create_no_window = true,
    });
    defer child.kill(init.io);
    return childExitCode(try child.wait(init.io));
}

fn classifyExecutable(io: std.Io, path: []const u8) ExecutableKind {
    const file = std.Io.Dir.cwd().openFile(io, path, .{}) catch return .native;
    defer file.close(io);
    var reader_buffer: [512]u8 = undefined;
    var source_buffer: [4096]u8 = undefined;
    var reader = file.readerStreaming(io, &reader_buffer);
    const source_len = reader.interface.readSliceShort(&source_buffer) catch 0;
    const source = source_buffer[0..source_len];
    const newline = std.mem.indexOfScalar(u8, source, '\n') orelse source.len;
    const first_line = source[0..newline];
    if (std.mem.startsWith(u8, first_line, "#!")) {
        if (std.mem.indexOf(u8, first_line, "bun") != null) return .bun_script;
        if (std.mem.indexOf(u8, first_line, "node") != null) return .node_script;
    }

    const extension = std.fs.path.extension(path);
    for ([_][]const u8{ ".ts", ".cts", ".mts", ".tsx" }) |candidate| {
        if (std.ascii.eqlIgnoreCase(extension, candidate)) return .bun_script;
    }
    for ([_][]const u8{ ".js", ".cjs", ".mjs", ".jsx" }) |candidate| {
        if (std.ascii.eqlIgnoreCase(extension, candidate)) return .javascript;
    }
    return .native;
}

fn appendWindowsShellArg(writer: *std.Io.Writer, value: []const u8) !void {
    try writer.writeByte('"');
    for (value) |byte| {
        if (byte == '"') try writer.writeByte('\\');
        try writer.writeByte(byte);
    }
    try writer.writeByte('"');
}

fn childExitCode(term: std.process.Child.Term) u8 {
    return switch (term) {
        .exited => |code| @intCast(@min(code, 255)),
        .signal, .stopped, .unknown => 1,
    };
}

fn isBunxArgv0(argv0: []const u8) bool {
    const basename = std.fs.path.basename(argv0);
    if (builtin.os.tag == .windows) {
        return std.ascii.eqlIgnoreCase(basename, "bunx") or std.ascii.eqlIgnoreCase(basename, "bunx.exe");
    }
    return std.mem.eql(u8, basename, "bunx");
}

fn printUsage(writer: *std.Io.Writer) !void {
    try writer.writeAll(
        \\Usage: cottontail x [--bun] [--no-install] [--package <package>] <package-or-bin> [args...]
        \\       bunx [--bun] [--no-install] [--package <package>] <package-or-bin> [args...]
        \\
    );
}

test "bunx invocation recognizes x, global --bun, and argv0 aliases" {
    const direct = [_][:0]const u8{ "cottontail", "x", "tool" };
    try std.testing.expectEqual(@as(usize, 2), detectInvocation(&direct).?.args_start);
    const forced = [_][:0]const u8{ "cottontail", "--bun", "x", "tool" };
    try std.testing.expect(detectInvocation(&forced).?.force_runtime);
    const alias = [_][:0]const u8{ "/tmp/bunx", "tool" };
    try std.testing.expect(detectInvocation(&alias).?.argv0_alias);
}

test "bunx package parsing preserves versions, scopes, and aliases" {
    const plain = splitRegistrySpec("node-gyp@11").?;
    try std.testing.expectEqualStrings("node-gyp", plain.name);
    try std.testing.expectEqualStrings("11", plain.version);
    try std.testing.expect(plain.explicit_version);
    const scoped = splitRegistrySpec("@babel/cli@latest").?;
    try std.testing.expectEqualStrings("@babel/cli", scoped.name);
    try std.testing.expectEqualStrings("latest", scoped.version);
    try std.testing.expect(isDistTag(scoped.version));
    try std.testing.expectEqualStrings("cli", normalizedBinName(scoped.name));
}
