const std = @import("std");
const HostedGitInfo = @import("cottontail_compiler").install.HostedGitInfo;

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

    if (githubScpPath(source)) |scp| {
        return .{
            .kind = .git,
            .clone_url = try std.fmt.allocPrint(allocator, "https://github.com/{s}.git", .{scp.path}),
            .lock_prefix = try genericLockPrefix(allocator, source),
            .committish = try allocator.dupe(u8, split.fragment),
        };
    }

    if (try HostedGitInfo.HostedGitInfo.fromUrl(allocator, input)) |hosted| {
        defer hosted.deinit();
        const user = hosted.user orelse return null;
        const host = switch (hosted.host_provider) {
            .bitbucket => "bitbucket.org",
            .gitlab => "gitlab.com",
            .sourcehut => "git.sr.ht",
            .gist => "gist.github.com",
            .github => "github.com",
        };
        const path = if (hosted.host_provider == .gist)
            try allocator.dupe(u8, hosted.project)
        else
            try std.fmt.allocPrint(allocator, "{s}/{s}", .{ user, hosted.project });
        return .{
            .kind = if (hosted.host_provider == .github and hosted.default_representation == .shortcut) .github else .git,
            .clone_url = try std.fmt.allocPrint(allocator, "https://{s}/{s}.git", .{ host, path }),
            .lock_prefix = try genericLockPrefix(allocator, source),
            .committish = try allocator.dupe(u8, hosted.committish orelse split.fragment),
        };
    }

    if (std.mem.startsWith(u8, source, "git+") or
        std.mem.startsWith(u8, source, "git://") or
        std.mem.startsWith(u8, source, "ssh://") or
        std.mem.startsWith(u8, source, "git@") or
        isScpLike(source))
    {
        const raw_clone_url = if (std.mem.startsWith(u8, source, "git+")) source["git+".len..] else source;
        const clone_url = if (std.mem.indexOf(u8, raw_clone_url, "://") == null and isScpLike(raw_clone_url))
            try scpHttpsURL(allocator, raw_clone_url)
        else
            try allocator.dupe(u8, raw_clone_url);
        return .{
            .kind = .git,
            .clone_url = clone_url,
            .lock_prefix = try genericLockPrefix(allocator, source),
            .committish = try allocator.dupe(u8, split.fragment),
        };
    }
    return null;
}

pub fn matches(allocator: std.mem.Allocator, locked_source: []const u8, requested: []const u8) !bool {
    const locked = (try parse(allocator, locked_source)) orelse return false;
    const wanted = (try parse(allocator, requested)) orelse return false;
    if (locked.kind != wanted.kind or
        (!std.mem.eql(u8, locked.lock_prefix, wanted.lock_prefix) and
            !std.mem.eql(u8, locked.clone_url, wanted.clone_url))) return false;
    if (wanted.committish.len == 0 or !isCommitishHash(wanted.committish)) return true;
    return std.mem.startsWith(u8, locked.committish, wanted.committish);
}

pub fn githubRepositoryPath(spec: Spec) ?[]const u8 {
    if (spec.kind != .github) return null;
    var path = githubPathFromURL(spec.clone_url) orelse return null;
    if (std.mem.endsWith(u8, path, ".git")) path = path[0 .. path.len - ".git".len];
    const slash = std.mem.indexOfScalar(u8, path, '/') orelse return null;
    if (slash == 0 or slash + 1 >= path.len) return null;
    return path;
}

pub fn checkout(
    allocator: std.mem.Allocator,
    io: std.Io,
    environ: *const std.process.Environ.Map,
    spec: Spec,
    destination: []const u8,
) !Checkout {
    deletePath(io, destination);
    errdefer deletePath(io, destination);
    if (std.fs.path.dirname(destination)) |parent| try std.Io.Dir.cwd().createDirPath(io, parent);

    var git_environment = try environ.clone(allocator);
    defer git_environment.deinit();
    if (git_environment.get("GIT_ASKPASS") == null) try git_environment.put("GIT_ASKPASS", "echo");
    if (git_environment.get("GIT_SSH_COMMAND") == null) {
        try git_environment.put("GIT_SSH_COMMAND", "ssh -oStrictHostKeyChecking=accept-new");
    }

    cloneRepository(allocator, io, &git_environment, spec.clone_url, destination) catch |err| switch (err) {
        error.RepositoryNotFound => return error.GitCloneFailed,
        error.InstallFailed => {
            const fallback_url = try sshFallbackURL(allocator, spec);
            if (fallback_url == null) return err;
            defer allocator.free(fallback_url.?);

            deletePath(io, destination);
            cloneRepository(allocator, io, &git_environment, fallback_url.?, destination) catch |fallback_err| switch (fallback_err) {
                error.RepositoryNotFound, error.InstallFailed => return error.GitCloneFailed,
                else => return fallback_err,
            };
        },
        else => return err,
    };
    runGit(allocator, io, &git_environment, &.{
        "git",
        "-C",
        destination,
        "checkout",
        "--quiet",
        if (spec.committish.len > 0) spec.committish else "HEAD",
    }) catch |err| switch (err) {
        error.RepositoryNotFound, error.InstallFailed => return error.GitCommitNotFound,
        else => return err,
    };
    const result = runGitCapture(allocator, io, &git_environment, &.{ "git", "-C", destination, "rev-parse", "HEAD" }) catch |err| switch (err) {
        error.RepositoryNotFound, error.InstallFailed => return error.GitCommitNotFound,
        else => return err,
    };
    defer allocator.free(result.stdout);
    defer allocator.free(result.stderr);
    const commit = std.mem.trim(u8, result.stdout, " \t\r\n");
    if (commit.len == 0) return error.GitCommitNotFound;

    return .{
        .path = destination,
        .commit = try allocator.dupe(u8, commit),
    };
}

fn cloneRepository(
    allocator: std.mem.Allocator,
    io: std.Io,
    environ: *const std.process.Environ.Map,
    url: []const u8,
    destination: []const u8,
) !void {
    try runGit(allocator, io, environ, &.{
        "git",
        "clone",
        "-c",
        "core.longpaths=true",
        "--quiet",
        "--no-checkout",
        url,
        destination,
    });
}

fn runGit(
    allocator: std.mem.Allocator,
    io: std.Io,
    environ: *const std.process.Environ.Map,
    argv: []const []const u8,
) !void {
    const result = try runGitCapture(allocator, io, environ, argv);
    allocator.free(result.stdout);
    allocator.free(result.stderr);
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
    const repository_not_found = gitStderrIsRepositoryNotFound(result.stderr);
    allocator.free(result.stdout);
    allocator.free(result.stderr);
    return if (repository_not_found) error.RepositoryNotFound else error.InstallFailed;
}

fn gitStderrIsRepositoryNotFound(stderr: []const u8) bool {
    return (std.mem.indexOf(u8, stderr, "remote:") != null and
        std.mem.indexOf(u8, stderr, "not") != null and
        std.mem.indexOf(u8, stderr, "found") != null) or
        std.mem.indexOf(u8, stderr, "does not exist") != null;
}

fn sshFallbackURL(allocator: std.mem.Allocator, spec: Spec) !?[]const u8 {
    var source = spec.lock_prefix;
    if (std.mem.startsWith(u8, source, "git+")) source = source["git+".len..];
    if (std.mem.startsWith(u8, source, "http://") or
        std.mem.startsWith(u8, source, "https://") or
        std.mem.startsWith(u8, source, "git://")) return null;

    const candidate = if (std.mem.startsWith(u8, source, "ssh://")) blk: {
        const remainder = source["ssh://".len..];
        if (std.mem.indexOfScalar(u8, remainder, '/') != null) {
            break :blk try allocator.dupe(u8, source);
        }
        const colon = std.mem.indexOfScalar(u8, remainder, ':') orelse
            break :blk try allocator.dupe(u8, source);
        break :blk try std.fmt.allocPrint(
            allocator,
            "ssh://{s}/{s}",
            .{ remainder[0..colon], remainder[colon + 1 ..] },
        );
    } else if (isScpLike(source)) blk: {
        const colon = std.mem.indexOfScalar(u8, source, ':').?;
        const authority = source[0..colon];
        const path = source[colon + 1 ..];
        if (std.mem.indexOfScalar(u8, authority, '@') != null) {
            break :blk try std.fmt.allocPrint(allocator, "ssh://{s}/{s}", .{ authority, path });
        }
        break :blk try std.fmt.allocPrint(
            allocator,
            "ssh://git@{s}/{s}",
            .{ normalizedGitHost(authority), path },
        );
    } else return null;

    if (std.mem.eql(u8, candidate, spec.clone_url)) {
        allocator.free(candidate);
        return null;
    }
    return candidate;
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
        "git+http://github.com/",
    };
    for (prefixes) |prefix| {
        if (std.mem.startsWith(u8, source, prefix)) return source[prefix.len..];
    }
    return null;
}

fn isGithubShorthand(source: []const u8) bool {
    if (source.len == 0 or source[0] == '@' or std.mem.startsWith(u8, source, "./") or std.mem.startsWith(u8, source, "../")) return false;
    if (std.mem.indexOfScalar(u8, source, '@') != null) return false;
    const slash = std.mem.indexOfScalar(u8, source, '/') orelse return false;
    return slash > 0 and slash + 1 < source.len and std.mem.indexOfScalarPos(u8, source, slash + 1, '/') == null and
        std.mem.indexOfScalar(u8, source, ':') == null;
}

fn githubScpPath(source: []const u8) ?struct { path: []const u8 } {
    const host_marker = "@github.com:";
    const marker = std.mem.indexOf(u8, source, host_marker) orelse return null;
    if (marker == 0) return null;
    var path = std.mem.trim(u8, source[marker + host_marker.len ..], "/");
    const slash = std.mem.indexOfScalar(u8, path, '/') orelse return null;
    if (slash == 0 or slash + 1 >= path.len or std.mem.indexOfScalarPos(u8, path, slash + 1, '/') != null) return null;
    if (std.mem.endsWith(u8, path, ".git")) path = path[0 .. path.len - ".git".len];
    if (path.len == 0) return null;
    return .{ .path = path };
}

fn isScpLike(source: []const u8) bool {
    const colon = std.mem.indexOfScalar(u8, source, ':') orelse return false;
    if (colon == 0 or colon + 1 >= source.len) return false;
    return std.mem.indexOfScalar(u8, source[0..colon], '/') == null and
        (std.mem.indexOfScalar(u8, source[0..colon], '@') != null or std.mem.indexOfScalar(u8, source[colon + 1 ..], '/') != null);
}

fn genericLockPrefix(allocator: std.mem.Allocator, source: []const u8) ![]const u8 {
    if (std.mem.startsWith(u8, source, "git+")) return allocator.dupe(u8, source);
    if (std.mem.indexOf(u8, source, "://") != null) {
        return std.fmt.allocPrint(allocator, "git+{s}", .{source});
    }
    if (isScpLike(source)) return std.fmt.allocPrint(allocator, "git+ssh://{s}", .{source});
    return std.fmt.allocPrint(allocator, "git+{s}", .{source});
}

fn scpHttpsURL(allocator: std.mem.Allocator, source: []const u8) ![]const u8 {
    const colon = std.mem.indexOfScalar(u8, source, ':') orelse return error.InvalidGitDependency;
    const authority = source[0..colon];
    const path = source[colon + 1 ..];
    const host = normalizedGitHost(if (std.mem.lastIndexOfScalar(u8, authority, '@')) |at| authority[at + 1 ..] else authority);
    return std.fmt.allocPrint(allocator, "https://{s}/{s}", .{ host, path });
}

fn normalizedGitHost(host: []const u8) []const u8 {
    if (std.mem.eql(u8, host, "bitbucket")) return "bitbucket.org";
    if (std.mem.eql(u8, host, "github")) return "github.com";
    if (std.mem.eql(u8, host, "gitlab")) return "gitlab.com";
    return host;
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

    const scp = (try parse(allocator, "git@github.com:owner/repo.git#main")).?;
    try std.testing.expectEqual(Kind.git, scp.kind);
    try std.testing.expectEqualStrings("https://github.com/owner/repo.git", scp.clone_url);
    try std.testing.expectEqualStrings("git+ssh://git@github.com:owner/repo.git", scp.lock_prefix);

    const custom_user_scp = (try parse(allocator, "bun@github.com:owner/repo.git#main")).?;
    try std.testing.expectEqual(Kind.git, custom_user_scp.kind);
    try std.testing.expectEqualStrings("https://github.com/owner/repo.git", custom_user_scp.clone_url);
    try std.testing.expectEqualStrings("git+ssh://bun@github.com:owner/repo.git", custom_user_scp.lock_prefix);

    const normalized_custom_user_scp = (try parse(allocator, "git+ssh://bun@github.com:owner/repo.git#abcdef0")).?;
    try std.testing.expectEqualStrings("git+ssh://bun@github.com:owner/repo.git", normalized_custom_user_scp.lock_prefix);
    try std.testing.expect(try matches(
        allocator,
        "git+ssh://bun@github.com:owner/repo.git#abcdef0123456789",
        "bun@github.com:owner/repo.git",
    ));

    const bitbucket = (try parse(allocator, "bitbucket:dylan-conway/public-install-test#main")).?;
    try std.testing.expectEqual(Kind.git, bitbucket.kind);
    try std.testing.expectEqualStrings(
        "https://bitbucket.org/dylan-conway/public-install-test.git",
        bitbucket.clone_url,
    );
    try std.testing.expect(try matches(
        allocator,
        "git+ssh://git@bitbucket.org/dylan-conway/public-install-test.git#abcdef0123456789",
        "bitbucket:dylan-conway/public-install-test#abcdef0",
    ));

    const gitlab = (try parse(allocator, "gitlab:dylan-conway/public-install-test#main")).?;
    try std.testing.expectEqual(Kind.git, gitlab.kind);
    try std.testing.expectEqualStrings(
        "https://gitlab.com/dylan-conway/public-install-test.git",
        gitlab.clone_url,
    );
}
