const std = @import("std");
const builtin = @import("builtin");

const c = @cImport({
    @cInclude("icu_bridge/icu-bridge.h");
});

const version = "70.1";
const data_file = "icudt70l.dat";
const data_url = "https://electrobun-artifacts.blackboard.sh/jsc/icu/70.1/icudt70l.dat";
const expected_sha256 = "672dafc4940a0183cb48c3e369c1a0795cc8dfbf19951c86ced0ad78398f9480";
const expected_data_size = 29_466_000;
const max_data_size = 40 * 1024 * 1024;

var mutex: std.Io.Mutex = .init;
var initialized = false;
var retained_data: ?[]u8 = null;

pub fn ensure(init: std.process.Init) !void {
    mutex.lockUncancelable(init.io);
    defer mutex.unlock(init.io);
    if (initialized) return;

    if (c.cottontail_icu_try_system() != 0) {
        initialized = true;
        return;
    }

    const allocator = std.heap.smp_allocator;
    const root = try dataRoot(init, allocator);
    defer allocator.free(root);
    try std.Io.Dir.cwd().createDirPath(init.io, root);
    const path = try std.fs.path.join(allocator, &.{ root, data_file });
    defer allocator.free(path);
    const marker_path = try std.mem.concat(allocator, u8, &.{ path, ".verified" });
    defer allocator.free(marker_path);
    const lock_path = try std.mem.concat(allocator, u8, &.{ path, ".lock" });
    defer allocator.free(lock_path);

    const lock = try std.Io.Dir.cwd().createFile(init.io, lock_path, .{
        .read = true,
        .truncate = false,
        .lock = .exclusive,
    });
    defer lock.close(init.io);

    const bytes = try loadOrDownload(init, allocator, path, marker_path);
    if (c.cottontail_icu_use_fallback(bytes.ptr, bytes.len) == 0) {
        allocator.free(bytes);
        const message = std.mem.span(c.cottontail_icu_last_error());
        std.debug.print("cottontail: {s}\n", .{message});
        return error.IcuInitializationFailed;
    }
    retained_data = bytes;
    initialized = true;
}

fn dataRoot(init: std.process.Init, allocator: std.mem.Allocator) ![]u8 {
    if (builtin.os.tag == .windows) {
        if (init.environ_map.get("LOCALAPPDATA")) |root|
            return std.fs.path.join(allocator, &.{ root, "Cottontail", "icu", version });
    } else if (builtin.os.tag == .macos) {
        if (init.environ_map.get("HOME")) |home|
            return std.fs.path.join(allocator, &.{ home, "Library", "Application Support", "Cottontail", "icu", version });
    } else {
        if (init.environ_map.get("XDG_DATA_HOME")) |root|
            return std.fs.path.join(allocator, &.{ root, "cottontail", "icu", version });
        if (init.environ_map.get("HOME")) |home|
            return std.fs.path.join(allocator, &.{ home, ".local", "share", "cottontail", "icu", version });
    }
    return error.MissingHomeDirectory;
}

fn markerMatches(init: std.process.Init, allocator: std.mem.Allocator, marker_path: []const u8) bool {
    const marker = std.Io.Dir.cwd().readFileAlloc(
        init.io,
        marker_path,
        allocator,
        .limited(256),
    ) catch return false;
    defer allocator.free(marker);
    return std.mem.eql(u8, std.mem.trim(u8, marker, " \t\r\n"), expected_sha256);
}

fn hashMatches(bytes: []const u8) bool {
    var digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(bytes, &digest, .{});
    const actual = std.fmt.bytesToHex(digest, .lower);
    return std.mem.eql(u8, &actual, expected_sha256);
}

fn loadOrDownload(
    init: std.process.Init,
    allocator: std.mem.Allocator,
    path: []const u8,
    marker_path: []const u8,
) ![]u8 {
    if (std.Io.Dir.cwd().readFileAlloc(init.io, path, allocator, .limited(max_data_size))) |bytes| {
        const verified = markerMatches(init, allocator, marker_path);
        if (bytes.len == expected_data_size and (verified or hashMatches(bytes))) {
            if (!verified)
                try std.Io.Dir.cwd().writeFile(init.io, .{ .sub_path = marker_path, .data = expected_sha256 ++ "\n" });
            return bytes;
        }
        allocator.free(bytes);
    } else |_| {}

    var client: std.http.Client = .{ .allocator = allocator, .io = init.io };
    defer client.deinit();
    var output: std.Io.Writer.Allocating = .init(allocator);
    errdefer output.deinit();
    const result = try client.fetch(.{
        .location = .{ .url = data_url },
        .response_writer = &output.writer,
    });
    const status: u16 = @intFromEnum(result.status);
    if (status < 200 or status >= 300) return error.IcuDownloadFailed;
    const bytes = try output.toOwnedSlice();
    if (bytes.len != expected_data_size or !hashMatches(bytes)) {
        allocator.free(bytes);
        return error.IcuChecksumMismatch;
    }

    const temporary_path = try std.mem.concat(allocator, u8, &.{ path, ".tmp" });
    defer allocator.free(temporary_path);
    try std.Io.Dir.cwd().writeFile(init.io, .{ .sub_path = temporary_path, .data = bytes });
    try std.Io.Dir.cwd().rename(temporary_path, std.Io.Dir.cwd(), path, init.io);
    try std.Io.Dir.cwd().writeFile(init.io, .{ .sub_path = marker_path, .data = expected_sha256 ++ "\n" });
    return bytes;
}
