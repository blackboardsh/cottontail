const std = @import("std");
const compiler = @import("cottontail_compiler");
const Lockfile = @import("package_manager_lockfile.zig");
const Scripts = @import("package_manager_scripts.zig");

const Semver = compiler.Semver;
const Value = std.json.Value;

pub const Options = struct {
    git_tag_version: bool = true,
    allow_same_version: bool = false,
    force: bool = false,
    ignore_scripts: bool = false,
    message: ?[]const u8 = null,
    preid: []const u8 = "",
};

const VersionType = enum {
    patch,
    minor,
    major,
    prepatch,
    preminor,
    premajor,
    prerelease,
    specific,
    from_git,

    fn fromString(value: []const u8) ?VersionType {
        inline for (.{
            .{ "patch", VersionType.patch },
            .{ "minor", VersionType.minor },
            .{ "major", VersionType.major },
            .{ "prepatch", VersionType.prepatch },
            .{ "preminor", VersionType.preminor },
            .{ "premajor", VersionType.premajor },
            .{ "prerelease", VersionType.prerelease },
            .{ "from-git", VersionType.from_git },
        }) |entry| {
            if (std.mem.eql(u8, value, entry[0])) return entry[1];
        }
        return null;
    }
};

const VersionArgument = struct {
    kind: VersionType,
    specific: ?[]const u8 = null,
};

const PackageJson = struct {
    path: []const u8,
    dir: []const u8,
    source: []const u8,
    root: Value,
};

pub fn run(
    init: std.process.Init,
    args: []const []const u8,
    options: Options,
    cwd: []const u8,
    stdout: *std.Io.Writer,
    stderr: *std.Io.Writer,
) !u8 {
    var package_json = loadPackageJson(init.io, init.arena.allocator(), cwd) catch |err| {
        if (err == error.PackageJsonParseFailed) {
            try stderr.writeAll("error: Failed to parse package.json\n");
        } else {
            try stderr.print("error: Failed to read package.json: {s}\n", .{@errorName(err)});
        }
        try stderr.flush();
        return 1;
    };

    if (package_json.root != .object) {
        try stderr.writeAll("error: Failed to parse package.json: root must be an object\n");
        try stderr.flush();
        return 1;
    }

    if (args.len == 0) {
        try showHelp(init, &package_json, options.preid, stdout, stderr);
        return 0;
    }

    const version_argument = parseVersionArgument(args[0]) orelse {
        try stderr.print("error: Invalid version argument: \"{s}\"\n", .{args[0]});
        try stderr.writeAll("note: Valid options: patch, minor, major, prepatch, preminor, premajor, prerelease, from-git, or a specific semver version\n");
        try stderr.flush();
        return 1;
    };

    var effective_options = options;
    if (effective_options.git_tag_version and !(try isGitRepository(init.io, package_json.dir))) {
        effective_options.git_tag_version = false;
    }
    if (effective_options.git_tag_version and !effective_options.force) {
        if (!(try isGitClean(init, package_json.dir))) {
            try stderr.writeAll("error: Git working directory not clean.\n");
            try stderr.flush();
            return 1;
        }
    }

    if (!effective_options.ignore_scripts) {
        Scripts.runNamedStage(init, package_json.dir, &package_json.root, "preversion", stderr) catch return 1;
    }

    const current_version = jsonString(&package_json.root, "version");
    const new_version = calculateNewVersion(
        init,
        current_version orelse "0.0.0",
        version_argument,
        effective_options.preid,
        package_json.dir,
    ) catch |err| {
        switch (err) {
            error.InvalidCurrentVersion => try stderr.print("error: Current version \"{s}\" is not a valid semver\n", .{current_version orelse "0.0.0"}),
            error.NoGitTags => try stderr.writeAll("error: No git tags found\n"),
            else => try stderr.print("error: Failed to calculate version: {s}\n", .{@errorName(err)}),
        }
        try stderr.flush();
        return 1;
    };

    if (current_version) |current| {
        if (!effective_options.allow_same_version and std.mem.eql(u8, current, new_version)) {
            try stderr.writeAll("error: Version not changed\n");
            try stderr.flush();
            return 1;
        }
    }

    try package_json.root.object.put(
        init.arena.allocator(),
        "version",
        .{ .string = new_version },
    );
    try savePackageJson(init.io, init.arena.allocator(), &package_json, new_version);

    if (!effective_options.ignore_scripts) {
        Scripts.runNamedStage(init, package_json.dir, &package_json.root, "version", stderr) catch return 1;
    }

    if (effective_options.git_tag_version) {
        gitCommitAndTag(init, package_json.dir, new_version, effective_options.message) catch |err| {
            try stderr.print("error: Git version commit failed: {s}\n", .{@errorName(err)});
            try stderr.flush();
            return 1;
        };
    }

    if (!effective_options.ignore_scripts) {
        Scripts.runNamedStage(init, package_json.dir, &package_json.root, "postversion", stderr) catch return 1;
    }

    try stdout.print("v{s}\n", .{new_version});
    try stdout.flush();
    return 0;
}

fn loadPackageJson(io: std.Io, allocator: std.mem.Allocator, cwd: []const u8) !PackageJson {
    const dir = try findPackageDir(io, allocator, cwd) orelse return error.PackageJsonNotFound;
    const path = try std.fs.path.join(allocator, &.{ dir, "package.json" });
    const source = std.Io.Dir.cwd().readFileAlloc(io, path, allocator, .limited(64 * 1024 * 1024)) catch return error.PackageJsonReadFailed;
    const normalized = Lockfile.normalizeJsonc(allocator, source) catch return error.PackageJsonParseFailed;
    const root = std.json.parseFromSliceLeaky(Value, allocator, normalized, .{
        .duplicate_field_behavior = .use_last,
    }) catch return error.PackageJsonParseFailed;
    return .{ .path = path, .dir = dir, .source = source, .root = root };
}

fn findPackageDir(io: std.Io, allocator: std.mem.Allocator, cwd: []const u8) !?[]const u8 {
    var current = cwd;
    while (true) {
        const path = try std.fs.path.join(allocator, &.{ current, "package.json" });
        if (std.Io.Dir.cwd().access(io, path, .{})) |_| return current else |_| {}
        const parent = std.fs.path.dirname(current) orelse return null;
        if (std.mem.eql(u8, parent, current)) return null;
        current = parent;
    }
}

fn parseVersionArgument(argument: []const u8) ?VersionArgument {
    if (VersionType.fromString(argument)) |kind| return .{ .kind = kind };
    const parsed = Semver.Version.parseUTF8(argument);
    if (!parsed.valid or parsed.len != argument.len) return null;
    return .{ .kind = .specific, .specific = argument };
}

fn calculateNewVersion(
    init: std.process.Init,
    current_string: []const u8,
    argument: VersionArgument,
    requested_preid: []const u8,
    cwd: []const u8,
) ![]const u8 {
    const allocator = init.arena.allocator();
    if (argument.kind == .specific) return allocator.dupe(u8, argument.specific.?);
    if (argument.kind == .from_git) return getVersionFromGit(init, cwd);

    const parsed = Semver.Version.parseUTF8(current_string);
    if (!parsed.valid or parsed.len != current_string.len) return error.InvalidCurrentVersion;
    const current = parsed.version.min();
    const current_pre = if (current.tag.hasPre()) current.tag.pre.slice(current_string) else "";
    const preid = effectivePreid(current_pre, requested_preid);

    return switch (argument.kind) {
        .patch => std.fmt.allocPrint(allocator, "{d}.{d}.{d}", .{ current.major, current.minor, current.patch + 1 }),
        .minor => std.fmt.allocPrint(allocator, "{d}.{d}.0", .{ current.major, current.minor + 1 }),
        .major => std.fmt.allocPrint(allocator, "{d}.0.0", .{current.major + 1}),
        .prepatch => formatPrerelease(allocator, current.major, current.minor, current.patch + 1, preid, 0),
        .preminor => formatPrerelease(allocator, current.major, current.minor + 1, 0, preid, 0),
        .premajor => formatPrerelease(allocator, current.major + 1, 0, 0, preid, 0),
        .prerelease => incrementPrerelease(allocator, current, current_pre, preid),
        else => unreachable,
    };
}

fn effectivePreid(current_pre: []const u8, requested: []const u8) []const u8 {
    if (requested.len > 0) return requested;
    if (current_pre.len == 0) return "";
    if (std.mem.indexOfScalar(u8, current_pre, '.')) |dot| return current_pre[0..dot];
    _ = std.fmt.parseInt(u32, current_pre, 10) catch return current_pre;
    return "";
}

fn incrementPrerelease(
    allocator: std.mem.Allocator,
    current: Semver.Version,
    current_pre: []const u8,
    preid: []const u8,
) ![]const u8 {
    if (current_pre.len == 0) {
        return formatPrerelease(allocator, current.major, current.minor, current.patch + 1, preid, 0);
    }

    if (std.mem.lastIndexOfScalar(u8, current_pre, '.')) |dot| {
        const next = (std.fmt.parseInt(u32, current_pre[dot + 1 ..], 10) catch 0) + 1;
        return formatPrerelease(allocator, current.major, current.minor, current.patch, preid, next);
    }

    if (std.fmt.parseInt(u32, current_pre, 10)) |number| {
        return formatPrerelease(allocator, current.major, current.minor, current.patch, preid, number + 1);
    } else |_| {
        return formatPrerelease(allocator, current.major, current.minor, current.patch, preid, 1);
    }
}

fn formatPrerelease(
    allocator: std.mem.Allocator,
    major: u64,
    minor: u64,
    patch: u64,
    preid: []const u8,
    number: u32,
) ![]const u8 {
    if (preid.len > 0) {
        return std.fmt.allocPrint(allocator, "{d}.{d}.{d}-{s}.{d}", .{ major, minor, patch, preid, number });
    }
    return std.fmt.allocPrint(allocator, "{d}.{d}.{d}-{d}", .{ major, minor, patch, number });
}

fn showHelp(
    init: std.process.Init,
    package_json: *const PackageJson,
    preid: []const u8,
    stdout: *std.Io.Writer,
    stderr: *std.Io.Writer,
) !void {
    const current_optional = jsonString(&package_json.root, "version");
    const current = current_optional orelse "1.0.0";

    try stdout.writeAll("bun pm version v1.3.10\n");
    if (current_optional != null) try stdout.print("Current package version: v{s}\n", .{current});

    const patch = helpVersion(init, current, .patch, preid, package_json.dir, stderr) orelse return;
    const minor = helpVersion(init, current, .minor, preid, package_json.dir, stderr) orelse return;
    const major = helpVersion(init, current, .major, preid, package_json.dir, stderr) orelse return;
    const prerelease = helpVersion(init, current, .prerelease, preid, package_json.dir, stderr) orelse return;

    try stdout.print(
        "Increment:\n" ++
            "  patch      {s} → {s}\n" ++
            "  minor      {s} → {s}\n" ++
            "  major      {s} → {s}\n" ++
            "  prerelease {s} → {s}\n\n",
        .{ current, patch, current, minor, current, major, current, prerelease },
    );

    if (std.mem.indexOfScalar(u8, current, '-') != null or preid.len > 0) {
        const prepatch = helpVersion(init, current, .prepatch, preid, package_json.dir, stderr) orelse return;
        const preminor = helpVersion(init, current, .preminor, preid, package_json.dir, stderr) orelse return;
        const premajor = helpVersion(init, current, .premajor, preid, package_json.dir, stderr) orelse return;
        try stdout.print(
            "  prepatch   {s} → {s}\n" ++
                "  preminor   {s} → {s}\n" ++
                "  premajor   {s} → {s}\n\n",
            .{ current, prepatch, current, preminor, current, premajor },
        );
    }

    try stdout.writeAll(
        "  from-git   Use version from latest git tag\n" ++
            "  1.2.3      Set specific version\n\n" ++
            "Options:\n" ++
            "  --no-git-tag-version  Skip git operations\n" ++
            "  --allow-same-version  Allow an unchanged version\n" ++
            "  --message, -m         Custom commit message; %s is replaced by the version\n" ++
            "  --preid               Prerelease identifier\n\n",
    );
    try stdout.flush();
}

fn helpVersion(
    init: std.process.Init,
    current: []const u8,
    kind: VersionType,
    preid: []const u8,
    cwd: []const u8,
    stderr: *std.Io.Writer,
) ?[]const u8 {
    return calculateNewVersion(init, current, .{ .kind = kind }, preid, cwd) catch |err| {
        stderr.print("error: Current version \"{s}\" is not a valid semver: {s}\n", .{ current, @errorName(err) }) catch {};
        stderr.flush() catch {};
        return null;
    };
}

fn savePackageJson(
    io: std.Io,
    allocator: std.mem.Allocator,
    package_json: *const PackageJson,
    new_version: []const u8,
) !void {
    if (findTopLevelVersionStringRange(package_json.source)) |range| {
        var encoded: std.Io.Writer.Allocating = .init(allocator);
        try std.json.Stringify.value(new_version, .{}, &encoded.writer);
        var output: std.Io.Writer.Allocating = .init(allocator);
        try output.writer.writeAll(package_json.source[0..range.start]);
        try output.writer.writeAll(encoded.written());
        try output.writer.writeAll(package_json.source[range.end..]);
        try std.Io.Dir.cwd().writeFile(io, .{ .sub_path = package_json.path, .data = output.written() });
        return;
    }

    var output: std.Io.Writer.Allocating = .init(allocator);
    try std.json.Stringify.value(package_json.root, .{ .whitespace = .indent_2 }, &output.writer);
    if (package_json.source.len > 0 and package_json.source[package_json.source.len - 1] == '\n') {
        try output.writer.writeByte('\n');
    }
    try std.Io.Dir.cwd().writeFile(io, .{ .sub_path = package_json.path, .data = output.written() });
}

const SourceRange = struct { start: usize, end: usize };

fn findTopLevelVersionStringRange(source: []const u8) ?SourceRange {
    var index: usize = 0;
    var object_depth: usize = 0;
    var array_depth: usize = 0;
    while (index < source.len) {
        if (source[index] == '/' and index + 1 < source.len) {
            if (source[index + 1] == '/') {
                index += 2;
                while (index < source.len and source[index] != '\n') index += 1;
                continue;
            }
            if (source[index + 1] == '*') {
                index += 2;
                while (index + 1 < source.len and !(source[index] == '*' and source[index + 1] == '/')) index += 1;
                index = @min(index + 2, source.len);
                continue;
            }
        }
        switch (source[index]) {
            '{' => {
                object_depth += 1;
                index += 1;
            },
            '}' => {
                object_depth -|= 1;
                index += 1;
            },
            '[' => {
                array_depth += 1;
                index += 1;
            },
            ']' => {
                array_depth -|= 1;
                index += 1;
            },
            '"' => {
                const string_end = findStringEnd(source, index) orelse return null;
                if (object_depth == 1 and array_depth == 0 and
                    std.mem.eql(u8, source[index + 1 .. string_end], "version"))
                {
                    var cursor = skipTrivia(source, string_end + 1);
                    if (cursor < source.len and source[cursor] == ':') {
                        cursor = skipTrivia(source, cursor + 1);
                        if (cursor < source.len and source[cursor] == '"') {
                            const value_end = findStringEnd(source, cursor) orelse return null;
                            return .{ .start = cursor, .end = value_end + 1 };
                        }
                    }
                }
                index = string_end + 1;
            },
            else => index += 1,
        }
    }
    return null;
}

fn findStringEnd(source: []const u8, start: usize) ?usize {
    var index = start + 1;
    while (index < source.len) : (index += 1) {
        if (source[index] == '\\') {
            index += 1;
            continue;
        }
        if (source[index] == '"') return index;
    }
    return null;
}

fn skipTrivia(source: []const u8, start: usize) usize {
    var index = start;
    while (index < source.len) {
        if (std.ascii.isWhitespace(source[index])) {
            index += 1;
            continue;
        }
        if (source[index] == '/' and index + 1 < source.len and source[index + 1] == '/') {
            index += 2;
            while (index < source.len and source[index] != '\n') index += 1;
            continue;
        }
        if (source[index] == '/' and index + 1 < source.len and source[index + 1] == '*') {
            index += 2;
            while (index + 1 < source.len and !(source[index] == '*' and source[index + 1] == '/')) index += 1;
            index = @min(index + 2, source.len);
            continue;
        }
        break;
    }
    return index;
}

fn isGitRepository(io: std.Io, cwd: []const u8) !bool {
    var dir = std.Io.Dir.openDirAbsolute(io, cwd, .{}) catch return false;
    defer dir.close(io);
    dir.access(io, ".git", .{}) catch return false;
    return true;
}

fn isGitClean(init: std.process.Init, cwd: []const u8) !bool {
    const result = try runGit(init, cwd, &.{ "git", "status", "--porcelain" });
    return commandSucceeded(result.term) and result.stdout.len == 0;
}

fn getVersionFromGit(init: std.process.Init, cwd: []const u8) ![]const u8 {
    const result = try runGit(init, cwd, &.{ "git", "describe", "--tags", "--abbrev=0" });
    if (!commandSucceeded(result.term)) return error.NoGitTags;
    var version = std.mem.trim(u8, result.stdout, " \t\r\n");
    if (std.mem.startsWith(u8, version, "v")) version = version[1..];
    if (version.len == 0) return error.NoGitTags;
    return init.arena.allocator().dupe(u8, version);
}

fn gitCommitAndTag(
    init: std.process.Init,
    cwd: []const u8,
    version_value: []const u8,
    custom_message: ?[]const u8,
) !void {
    const allocator = init.arena.allocator();
    const add_result = try runGit(init, cwd, &.{ "git", "add", "package.json" });
    if (!commandSucceeded(add_result.term)) return error.GitAddFailed;

    const message = if (custom_message) |value|
        try std.mem.replaceOwned(u8, allocator, value, "%s", version_value)
    else
        try std.fmt.allocPrint(allocator, "v{s}", .{version_value});
    const commit_result = try runGit(init, cwd, &.{ "git", "commit", "-m", message });
    if (!commandSucceeded(commit_result.term)) return error.GitCommitFailed;

    const tag = try std.fmt.allocPrint(allocator, "v{s}", .{version_value});
    const tag_result = try runGit(init, cwd, &.{ "git", "tag", "-a", tag, "-m", tag });
    if (!commandSucceeded(tag_result.term)) return error.GitTagFailed;
}

fn runGit(init: std.process.Init, cwd: []const u8, argv: []const []const u8) !std.process.RunResult {
    return std.process.run(init.arena.allocator(), init.io, .{
        .argv = argv,
        .cwd = .{ .path = cwd },
        .environ_map = init.environ_map,
        .stdout_limit = .limited(16 * 1024 * 1024),
        .stderr_limit = .limited(16 * 1024 * 1024),
    });
}

fn commandSucceeded(term: std.process.Child.Term) bool {
    return switch (term) {
        .exited => |code| code == 0,
        else => false,
    };
}

fn jsonString(value: *const Value, key: []const u8) ?[]const u8 {
    if (value.* != .object) return null;
    const field = value.object.get(key) orelse return null;
    return if (field == .string) field.string else null;
}

test "source update replaces only the top-level version string" {
    const source =
        \\{
        \\  "nested": { "version": "nested" },
        \\  "version": "1.0.0"
        \\}
    ;
    const range = findTopLevelVersionStringRange(source).?;
    try std.testing.expectEqualStrings("\"1.0.0\"", source[range.start..range.end]);
}
