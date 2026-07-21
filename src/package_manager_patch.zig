const std = @import("std");
const compiler = @import("cottontail_compiler");

pub const Spec = @import("package_manager_patch_spec.zig");

const patch_tag_prefix = ".bun-tag-";
const max_patch_bytes = 256 * 1024 * 1024;

pub const ApplyDiagnostic = struct {
    cause: anyerror,
    operation: []const u8,

    pub fn format(diagnostic: ApplyDiagnostic, writer: *std.Io.Writer) std.Io.Writer.Error!void {
        const detail = systemErrorDetail(diagnostic.cause);
        try writer.print("{s}: {s} ({s}())", .{ detail.code, detail.message, diagnostic.operation });
    }
};

pub fn expectedHash(
    allocator: std.mem.Allocator,
    io: std.Io,
    root_dir: []const u8,
    patch_paths: []const []const u8,
) !?u64 {
    if (patch_paths.len == 0) return null;
    var hasher = compiler.Wyhash11.init(0);
    for (patch_paths, 0..) |patch_path, index| {
        if (index > 0) hasher.update("\x00");
        const source = try readPatch(allocator, io, root_dir, patch_path);
        hasher.update(source);
    }
    return hasher.final();
}

pub fn installedStateMatches(
    allocator: std.mem.Allocator,
    io: std.Io,
    root_dir: []const u8,
    package_dir: []const u8,
    patch_paths: []const []const u8,
) !bool {
    const hash = try expectedHash(allocator, io, root_dir, patch_paths);
    std.Io.Dir.cwd().access(io, package_dir, .{}) catch return false;
    if (hash) |value| {
        const tag = try patchTagPath(allocator, package_dir, value);
        std.Io.Dir.cwd().access(io, tag, .{}) catch return false;
        return true;
    }
    return !try hasPatchTag(allocator, io, package_dir);
}

pub fn apply(
    allocator: std.mem.Allocator,
    io: std.Io,
    root_dir: []const u8,
    package_dir: []const u8,
    patch_paths: []const []const u8,
    diagnostic: *?ApplyDiagnostic,
) !void {
    diagnostic.* = null;
    if (patch_paths.len == 0) {
        try clearPatchTags(allocator, io, package_dir);
        return;
    }

    var hasher = compiler.Wyhash11.init(0);

    for (patch_paths, 0..) |patch_path, index| {
        if (index > 0) hasher.update("\x00");
        const source = try readPatch(allocator, io, root_dir, patch_path);
        hasher.update(source);

        const parse_source = std.mem.trimEnd(u8, source, "\r\n");
        var patch_file = compiler.patch.parsePatchFile(parse_source) catch return error.InvalidPatchFile;
        defer patch_file.deinit(compiler.default_allocator);
        try applyParsedPatch(allocator, io, package_dir, &patch_file, diagnostic);
    }

    try clearPatchTags(allocator, io, package_dir);
    const tag = try patchTagPath(allocator, package_dir, hasher.final());
    try std.Io.Dir.cwd().writeFile(io, .{ .sub_path = tag, .data = "" });
}

pub fn diff(
    allocator: std.mem.Allocator,
    io: std.Io,
    environ: *const std.process.Environ.Map,
    original_dir: []const u8,
    changed_dir: []const u8,
) ![]const u8 {
    const paths = compiler.patch.gitDiffPreprocessPaths(allocator, original_dir, changed_dir, false);
    defer if (@import("builtin").os.tag == .windows) {
        allocator.free(paths[0]);
        allocator.free(paths[1]);
    };

    var environment = try environ.clone(allocator);
    defer environment.deinit();
    try environment.put("GIT_CONFIG_NOSYSTEM", "1");
    try environment.put("HOME", "");
    try environment.put("XDG_CONFIG_HOME", "");
    try environment.put("USERPROFILE", "");
    const result = try std.process.run(allocator, io, .{
        .argv = &.{
            "git",
            "-c",
            "core.safecrlf=false",
            "diff",
            "--src-prefix=a/",
            "--dst-prefix=b/",
            "--ignore-cr-at-eol",
            "--irreversible-delete",
            "--full-index",
            "--no-index",
            paths[0],
            paths[1],
        },
        .environ_map = &environment,
        .stdout_limit = .limited(4 * 1024 * 1024),
        .stderr_limit = .limited(4 * 1024 * 1024),
    });
    defer allocator.free(result.stderr);
    if (result.stderr.len > 0) {
        allocator.free(result.stdout);
        return error.GitDiffFailed;
    }

    defer allocator.free(result.stdout);
    return gitDiffPostprocess(allocator, result.stdout, paths[0], paths[1]);
}

pub fn stripDiffArtifacts(
    allocator: std.mem.Allocator,
    io: std.Io,
    package_dir: []const u8,
) !void {
    const nested_modules = try std.fs.path.join(allocator, &.{ package_dir, "node_modules" });
    deletePath(io, nested_modules);
    const patch_marker = try std.fs.path.join(allocator, &.{ package_dir, ".bun-patch-tag" });
    std.Io.Dir.cwd().deleteFile(io, patch_marker) catch {};
    try clearPatchTags(allocator, io, package_dir);
}

pub fn snapshot(
    allocator: std.mem.Allocator,
    io: std.Io,
    source: []const u8,
    destination: []const u8,
) !void {
    deletePath(io, destination);
    try copySnapshotTree(allocator, io, source, destination);
}

fn readPatch(
    allocator: std.mem.Allocator,
    io: std.Io,
    root_dir: []const u8,
    patch_path: []const u8,
) ![]const u8 {
    const absolute = if (std.fs.path.isAbsolute(patch_path))
        patch_path
    else
        try std.fs.path.join(allocator, &.{ root_dir, patch_path });
    const source = std.Io.Dir.cwd().readFileAlloc(io, absolute, allocator, .limited(max_patch_bytes)) catch |err| switch (err) {
        error.FileNotFound => return error.PatchFileNotFound,
        else => return err,
    };
    if (source.len == 0) return error.EmptyPatchFile;
    return source;
}

fn patchTagPath(allocator: std.mem.Allocator, package_dir: []const u8, hash: u64) ![]const u8 {
    const name = try std.fmt.allocPrint(allocator, patch_tag_prefix ++ "{x}", .{hash});
    return std.fs.path.join(allocator, &.{ package_dir, name });
}

fn hasPatchTag(allocator: std.mem.Allocator, io: std.Io, package_dir: []const u8) !bool {
    var directory = std.Io.Dir.cwd().openDir(io, package_dir, .{ .iterate = true }) catch return false;
    defer directory.close(io);
    var iterator = directory.iterate();
    while (try iterator.next(io)) |entry| {
        _ = allocator;
        if (std.mem.startsWith(u8, entry.name, patch_tag_prefix)) return true;
    }
    return false;
}

fn clearPatchTags(allocator: std.mem.Allocator, io: std.Io, package_dir: []const u8) !void {
    var directory = std.Io.Dir.cwd().openDir(io, package_dir, .{ .iterate = true }) catch return;
    defer directory.close(io);
    var names = std.array_list.Managed([]const u8).init(allocator);
    var iterator = directory.iterate();
    while (try iterator.next(io)) |entry| {
        if (std.mem.startsWith(u8, entry.name, patch_tag_prefix)) {
            try names.append(try allocator.dupe(u8, entry.name));
        }
    }
    for (names.items) |name| directory.deleteFile(io, name) catch {};
}

fn deletePath(io: std.Io, path: []const u8) void {
    std.Io.Dir.cwd().deleteTree(io, path) catch {
        std.Io.Dir.cwd().deleteFile(io, path) catch {};
    };
}

fn copySnapshotTree(
    allocator: std.mem.Allocator,
    io: std.Io,
    source: []const u8,
    destination: []const u8,
) !void {
    try std.Io.Dir.cwd().createDirPath(io, destination);
    var source_dir = try std.Io.Dir.cwd().openDir(io, source, .{ .iterate = true });
    defer source_dir.close(io);
    var iterator = source_dir.iterate();
    while (try iterator.next(io)) |entry| {
        if (std.mem.eql(u8, entry.name, "node_modules") or
            std.mem.eql(u8, entry.name, ".bun-patch-tag") or
            std.mem.startsWith(u8, entry.name, patch_tag_prefix)) continue;
        const source_path = try std.fs.path.join(allocator, &.{ source, entry.name });
        const destination_path = try std.fs.path.join(allocator, &.{ destination, entry.name });
        switch (entry.kind) {
            .directory => try copySnapshotTree(allocator, io, source_path, destination_path),
            .file => try std.Io.Dir.copyFileAbsolute(source_path, destination_path, io, .{ .replace = true, .make_path = true }),
            else => {},
        }
    }
}

fn applyParsedPatch(
    allocator: std.mem.Allocator,
    io: std.Io,
    package_dir: []const u8,
    patch_file: *const compiler.patch.PatchFile,
    diagnostic: *?ApplyDiagnostic,
) !void {
    for (patch_file.parts.items) |part| switch (part) {
        .file_deletion => |deletion| {
            const path = try safePatchPath(allocator, package_dir, deletion.path);
            std.Io.Dir.cwd().deleteFile(io, path) catch |err| return applyFailure(diagnostic, "unlink", err);
        },
        .file_rename => |rename| {
            const from = try safePatchPath(allocator, package_dir, rename.from_path);
            const to = try safePatchPath(allocator, package_dir, rename.to_path);
            if (std.fs.path.dirname(to)) |parent| {
                std.Io.Dir.cwd().createDirPath(io, parent) catch |err| return applyFailure(diagnostic, "mkdir", err);
            }
            std.Io.Dir.cwd().rename(from, std.Io.Dir.cwd(), to, io) catch |err| return applyFailure(diagnostic, "rename", err);
        },
        .file_creation => |creation| try applyFileCreation(allocator, io, package_dir, creation, diagnostic),
        .file_patch => |file_patch| try applyFilePatch(allocator, io, package_dir, file_patch, diagnostic),
        .file_mode_change => |mode_change| {
            const path = try safePatchPath(allocator, package_dir, mode_change.path);
            const permissions: std.Io.File.Permissions = @enumFromInt(@intFromEnum(mode_change.new_mode));
            std.Io.Dir.cwd().setFilePermissions(io, path, permissions, .{}) catch |err| return applyFailure(diagnostic, "chmod", err);
        },
    };
}

fn applyFileCreation(
    allocator: std.mem.Allocator,
    io: std.Io,
    package_dir: []const u8,
    creation: *const compiler.patch.FileCreation,
    diagnostic: *?ApplyDiagnostic,
) !void {
    const path = try safePatchPath(allocator, package_dir, creation.path);
    if (std.fs.path.dirname(path)) |parent| {
        std.Io.Dir.cwd().createDirPath(io, parent) catch |err| return applyFailure(diagnostic, "mkdir", err);
    }
    var contents: std.Io.Writer.Allocating = .init(allocator);
    if (creation.hunk) |hunk| {
        if (hunk.parts.items.len > 0) {
            const part = hunk.parts.items[0];
            for (part.lines.items, 0..) |line, index| {
                try contents.writer.writeAll(line);
                if (index + 1 < part.lines.items.len or !part.no_newline_at_end_of_file) {
                    try contents.writer.writeByte('\n');
                }
            }
        }
    }
    std.Io.Dir.cwd().writeFile(io, .{ .sub_path = path, .data = contents.written() }) catch |err|
        return applyFailure(diagnostic, "write", err);
    const permissions: std.Io.File.Permissions = @enumFromInt(@intFromEnum(creation.mode));
    std.Io.Dir.cwd().setFilePermissions(io, path, permissions, .{}) catch |err|
        return applyFailure(diagnostic, "chmod", err);
}

fn applyFilePatch(
    allocator: std.mem.Allocator,
    io: std.Io,
    package_dir: []const u8,
    file_patch: *const compiler.patch.FilePatch,
    diagnostic: *?ApplyDiagnostic,
) !void {
    const path = try safePatchPath(allocator, package_dir, file_patch.path);
    const stat = std.Io.Dir.cwd().statFile(io, path, .{}) catch |err| return applyFailure(diagnostic, "stat", err);
    const source = std.Io.Dir.cwd().readFileAlloc(io, path, allocator, .limited(4 * 1024 * 1024 * 1024)) catch |err|
        return applyFailure(diagnostic, "read", err);

    var lines: std.ArrayListUnmanaged([]const u8) = .empty;
    var iterator = std.mem.splitScalar(u8, source, '\n');
    while (iterator.next()) |line| try lines.append(allocator, line);

    for (file_patch.hunks.items) |hunk| {
        var line_cursor: usize = hunk.header.patched.start -| 1;
        if (line_cursor > lines.items.len) return applyFailure(diagnostic, "patch", error.InvalidArgument);
        for (hunk.parts.items) |part| switch (part.type) {
            .context => {
                if (line_cursor + part.lines.items.len > lines.items.len) return applyFailure(diagnostic, "patch", error.InvalidArgument);
                line_cursor += part.lines.items.len;
            },
            .insertion => {
                if (line_cursor > lines.items.len) return applyFailure(diagnostic, "patch", error.InvalidArgument);
                const inserted = try lines.addManyAt(allocator, line_cursor, part.lines.items.len);
                @memcpy(inserted, part.lines.items);
                line_cursor += part.lines.items.len;
                if (part.no_newline_at_end_of_file and lines.items.len > 0) _ = lines.pop();
            },
            .deletion => {
                if (line_cursor + part.lines.items.len > lines.items.len) return applyFailure(diagnostic, "patch", error.InvalidArgument);
                try lines.replaceRange(allocator, line_cursor, part.lines.items.len, &.{});
                if (part.no_newline_at_end_of_file) try lines.append(allocator, "");
            },
        };
    }

    const patched = try std.mem.join(allocator, "\n", lines.items);
    std.Io.Dir.cwd().writeFile(io, .{
        .sub_path = path,
        .data = patched,
        .flags = .{ .permissions = stat.permissions },
    }) catch |err| return applyFailure(diagnostic, "write", err);
}

fn applyFailure(diagnostic: *?ApplyDiagnostic, operation: []const u8, cause: anyerror) error{PatchApplyFailed} {
    diagnostic.* = .{ .cause = cause, .operation = operation };
    return error.PatchApplyFailed;
}

fn systemErrorDetail(cause: anyerror) struct { code: []const u8, message: []const u8 } {
    return switch (cause) {
        error.FileNotFound => .{ .code = "ENOENT", .message = "No such file or directory" },
        error.AccessDenied => .{ .code = "EACCES", .message = "Permission denied" },
        error.NotDir => .{ .code = "ENOTDIR", .message = "Not a directory" },
        error.IsDir => .{ .code = "EISDIR", .message = "Is a directory" },
        error.PathAlreadyExists => .{ .code = "EEXIST", .message = "File exists" },
        error.NameTooLong => .{ .code = "ENAMETOOLONG", .message = "File name too long" },
        error.NoSpaceLeft => .{ .code = "ENOSPC", .message = "No space left on device" },
        error.ReadOnlyFileSystem => .{ .code = "EROFS", .message = "Read-only file system" },
        error.FileTooBig => .{ .code = "EFBIG", .message = "File too large" },
        error.InputOutput => .{ .code = "EIO", .message = "Input/output error" },
        error.DeviceBusy => .{ .code = "EBUSY", .message = "Device or resource busy" },
        error.InvalidArgument => .{ .code = "EINVAL", .message = "Invalid argument" },
        error.BrokenPipe => .{ .code = "EPIPE", .message = "Broken pipe" },
        else => .{ .code = @errorName(cause), .message = @errorName(cause) },
    };
}

fn safePatchPath(allocator: std.mem.Allocator, package_dir: []const u8, relative: []const u8) ![]const u8 {
    if (relative.len == 0 or std.fs.path.isAbsolute(relative)) return error.PatchApplyFailed;
    const root = try std.fs.path.resolve(allocator, &.{package_dir});
    const resolved = try std.fs.path.resolve(allocator, &.{ package_dir, relative });
    if (!pathHasPrefix(resolved, root)) return error.PatchApplyFailed;
    return resolved;
}

fn pathHasPrefix(path: []const u8, prefix: []const u8) bool {
    if (!std.mem.startsWith(u8, path, prefix)) return false;
    return path.len == prefix.len or path[prefix.len] == '/' or path[prefix.len] == '\\';
}

fn gitDiffPostprocess(
    allocator: std.mem.Allocator,
    source: []const u8,
    old_folder: []const u8,
    new_folder: []const u8,
) ![]const u8 {
    const old_trimmed = std.mem.trim(u8, old_folder, "/");
    const new_trimmed = std.mem.trim(u8, new_folder, "/");
    const a_old_prefixed = try std.fmt.allocPrint(allocator, "a/{s}/", .{old_trimmed});
    const a_new_prefixed = try std.fmt.allocPrint(allocator, "a/{s}/", .{new_trimmed});
    const b_old_prefixed = try std.fmt.allocPrint(allocator, "b/{s}/", .{old_trimmed});
    const b_new_prefixed = try std.fmt.allocPrint(allocator, "b/{s}/", .{new_trimmed});
    const old_plain = try std.fmt.allocPrint(allocator, "{s}/", .{old_folder});
    const new_plain = try std.fmt.allocPrint(allocator, "{s}/", .{new_folder});

    var output: std.Io.Writer.Allocating = .init(allocator);
    var lines = std.mem.splitScalar(u8, source, '\n');
    while (lines.next()) |line| {
        var normalized = line;
        if (!shouldSkipDiffLine(line)) {
            normalized = try std.mem.replaceOwned(u8, allocator, normalized, a_old_prefixed, "a/");
            normalized = try std.mem.replaceOwned(u8, allocator, normalized, a_new_prefixed, "a/");
            normalized = try std.mem.replaceOwned(u8, allocator, normalized, b_old_prefixed, "b/");
            normalized = try std.mem.replaceOwned(u8, allocator, normalized, b_new_prefixed, "b/");
            normalized = try std.mem.replaceOwned(u8, allocator, normalized, old_plain, "");
            normalized = try std.mem.replaceOwned(u8, allocator, normalized, new_plain, "");
        }
        try output.writer.writeAll(normalized);
        if (lines.index != null) try output.writer.writeByte('\n');
    }
    return output.toOwnedSlice();
}

fn shouldSkipDiffLine(line: []const u8) bool {
    return line.len == 0 or
        ((line[0] == ' ' or line[0] == '-' or line[0] == '+') and
            !(line.len >= 4 and (std.mem.eql(u8, line[0..4], "--- ") or std.mem.eql(u8, line[0..4], "+++ "))));
}
