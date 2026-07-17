const std = @import("std");

pub const Kind = enum {
    git,
    github,
};

pub const Spec = struct {
    kind: Kind,
    clone_url: []const u8,
    lock_prefix: []const u8,
    committish: []const u8,

    pub fn resolvedSource(spec: Spec, allocator: std.mem.Allocator, commit: []const u8) ![]const u8 {
        return std.fmt.allocPrint(allocator, "{s}#{s}", .{ spec.lock_prefix, commit });
    }
};

pub const Checkout = struct {
    path: []const u8,
    commit: []const u8,
};

pub fn parse(allocator: std.mem.Allocator, input: []const u8) !?Spec {
    const split = splitFragment(input);
    const source = split.source;

    if (std.mem.startsWith(u8, source, "github:")) {
        return try githubSpec(allocator, source["github:".len..], split.fragment);
    }
    if (isGithubShorthand(source)) return try githubSpec(allocator, source, split.fragment);

    if (githubPathFromURL(source)) |path| return try githubSpec(allocator, path, split.fragment);

    if (std.mem.startsWith(u8, source, "git+") or
        std.mem.startsWith(u8, source, "git://") or
        std.mem.startsWith(u8, source, "ssh://") or
        std.mem.startsWith(u8, source, "git@") or
        isScpLike(source))
    {
        const clone_url = if (std.mem.startsWith(u8, source, "git+")) source["git+".len..] else source;
        return .{
            .kind = .git,
            .clone_url = try allocator.dupe(u8, clone_url),
            .lock_prefix = try allocator.dupe(u8, source),
            .committish = try allocator.dupe(u8, split.fragment),
        };
    }
    return null;
}

pub fn matches(allocator: std.mem.Allocator, locked_source: []const u8, requested: []const u8) !bool {
    const locked = (try parse(allocator, locked_source)) orelse return false;
    const wanted = (try parse(allocator, requested)) orelse return false;
    if (locked.kind != wanted.kind or !std.mem.eql(u8, locked.lock_prefix, wanted.lock_prefix)) return false;
    if (wanted.committish.len == 0 or !isCommitishHash(wanted.committish)) return true;
    return std.mem.startsWith(u8, locked.committish, wanted.committish);
}

pub fn checkout(
    allocator: std.mem.Allocator,
    io: std.Io,
    environ: *const std.process.Environ.Map,
    spec: Spec,
    destination: []const u8,
) !Checkout {
    deletePath(io, destination);
    if (std.fs.path.dirname(destination)) |parent| try std.Io.Dir.cwd().createDirPath(io, parent);

    var git_environment = try environ.clone(allocator);
    defer git_environment.deinit();
    if (git_environment.get("GIT_ASKPASS") == null) try git_environment.put("GIT_ASKPASS", "echo");
    if (git_environment.get("GIT_SSH_COMMAND") == null) {
        try git_environment.put("GIT_SSH_COMMAND", "ssh -oStrictHostKeyChecking=accept-new");
    }

    try runGit(allocator, io, &git_environment, &.{
        "git",
        "clone",
        "-c",
        "core.longpaths=true",
        "--quiet",
        "--no-checkout",
        spec.clone_url,
        destination,
    });
    errdefer deletePath(io, destination);

    try runGit(allocator, io, &git_environment, &.{
        "git",
        "-C",
        destination,
        "checkout",
        "--quiet",
        if (spec.committish.len > 0) spec.committish else "HEAD",
    });
    const result = try runGitCapture(allocator, io, &git_environment, &.{ "git", "-C", destination, "rev-parse", "HEAD" });
    const commit = std.mem.trim(u8, result.stdout, " \t\r\n");
    if (commit.len == 0) return error.GitCommitNotFound;

    const metadata_dir = try std.fs.path.join(allocator, &.{ destination, ".git" });
    deletePath(io, metadata_dir);
    return .{
        .path = destination,
        .commit = try allocator.dupe(u8, commit),
    };
}

fn runGit(
    allocator: std.mem.Allocator,
    io: std.Io,
    environ: *const std.process.Environ.Map,
    argv: []const []const u8,
) !void {
    _ = try runGitCapture(allocator, io, environ, argv);
}

fn runGitCapture(
    allocator: std.mem.Allocator,
    io: std.Io,
    environ: *const std.process.Environ.Map,
    argv: []const []const u8,
) !std.process.RunResult {
    const result = try std.process.run(allocator, io, .{
        .argv = argv,
        .environ_map = environ,
        .stdout_limit = .limited(16 * 1024 * 1024),
        .stderr_limit = .limited(16 * 1024 * 1024),
    });
    switch (result.term) {
        .exited => |code| if (code == 0) return result,
        else => {},
    }
    return error.GitCommandFailed;
}

fn githubSpec(allocator: std.mem.Allocator, path: []const u8, committish: []const u8) !?Spec {
    const clean_path = std.mem.trim(u8, path, "/");
    const slash = std.mem.indexOfScalar(u8, clean_path, '/') orelse return null;
    if (slash == 0 or slash + 1 >= clean_path.len) return null;
    const owner = clean_path[0..slash];
    var repository = clean_path[slash + 1 ..];
    if (std.mem.endsWith(u8, repository, ".git")) repository = repository[0 .. repository.len - ".git".len];
    if (repository.len == 0 or std.mem.indexOfScalar(u8, repository, '/') != null) return null;
    return .{
        .kind = .github,
        .clone_url = try std.fmt.allocPrint(allocator, "https://github.com/{s}/{s}.git", .{ owner, repository }),
        .lock_prefix = try std.fmt.allocPrint(allocator, "github:{s}/{s}", .{ owner, repository }),
        .committish = try allocator.dupe(u8, committish),
    };
}

fn splitFragment(input: []const u8) struct { source: []const u8, fragment: []const u8 } {
    const hash = std.mem.lastIndexOfScalar(u8, input, '#') orelse return .{ .source = input, .fragment = "" };
    return .{ .source = input[0..hash], .fragment = input[hash + 1 ..] };
}

fn githubPathFromURL(source: []const u8) ?[]const u8 {
    const prefixes = [_][]const u8{
        "https://github.com/",
        "http://github.com/",
        "git://github.com/",
        "git+https://github.com/",
        "git+https://git@github.com/",
        "git+ssh://git@github.com/",
        "ssh://git@github.com/",
    };
    for (prefixes) |prefix| {
        if (std.mem.startsWith(u8, source, prefix)) return source[prefix.len..];
    }
    return null;
}

fn isGithubShorthand(source: []const u8) bool {
    if (source.len == 0 or source[0] == '@' or std.mem.startsWith(u8, source, "./") or std.mem.startsWith(u8, source, "../")) return false;
    const slash = std.mem.indexOfScalar(u8, source, '/') orelse return false;
    return slash > 0 and slash + 1 < source.len and std.mem.indexOfScalarPos(u8, source, slash + 1, '/') == null and
        std.mem.indexOfScalar(u8, source, ':') == null;
}

fn isScpLike(source: []const u8) bool {
    const colon = std.mem.indexOfScalar(u8, source, ':') orelse return false;
    if (colon == 0 or colon + 1 >= source.len) return false;
    return std.mem.indexOfScalar(u8, source[0..colon], '/') == null and
        (std.mem.indexOfScalar(u8, source[0..colon], '@') != null or std.mem.indexOfScalar(u8, source[colon + 1 ..], '/') != null);
}

fn isCommitishHash(value: []const u8) bool {
    if (value.len < 7 or value.len > 40) return false;
    for (value) |byte| if (!std.ascii.isHex(byte)) return false;
    return true;
}

fn deletePath(io: std.Io, path: []const u8) void {
    std.Io.Dir.cwd().deleteTree(io, path) catch {
        std.Io.Dir.cwd().deleteFile(io, path) catch {};
    };
}

test "parse GitHub and generic git dependency forms" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();

    const shorthand = (try parse(allocator, "owner/repo#v1.0.0")).?;
    try std.testing.expectEqual(Kind.github, shorthand.kind);
    try std.testing.expectEqualStrings("github:owner/repo", shorthand.lock_prefix);
    try std.testing.expectEqualStrings("v1.0.0", shorthand.committish);

    const url = (try parse(allocator, "git+https://example.com/owner/repo.git#abcdef0")).?;
    try std.testing.expectEqual(Kind.git, url.kind);
    try std.testing.expectEqualStrings("https://example.com/owner/repo.git", url.clone_url);
    try std.testing.expect(try matches(allocator, "git+https://example.com/owner/repo.git#abcdef012345", "git+https://example.com/owner/repo.git#abcdef0"));
}
