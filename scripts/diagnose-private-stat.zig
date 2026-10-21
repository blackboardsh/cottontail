const std = @import("std");
const builtin = @import("builtin");
const posix_identity = @cImport({
    @cInclude("sys/stat.h");
    @cInclude("unistd.h");
    @cInclude("fcntl.h");
});
const c = posix_identity;

// Exact pending script_runner.zig helpers, isolated from the runtime build.
fn posixFileIdentity(handle: anytype) !struct { uid: u32, mode: u16 } {
    if (comptime builtin.os.tag == .macos) {
        // Intel Darwin requires fstat$INODE64 for the modern stat layout.
        // translate-c loses that header symbol redirect, so keep the target's
        // native function and structure together. Linux retains its C ABI.
        var native_stat: std.c.Stat = undefined;
        if (std.c.fstat(handle, &native_stat) != 0) return error.HutchPrivateStatFailed;
        return .{ .uid = native_stat.uid, .mode = native_stat.mode & 0o777 };
    }
    var native_stat: posix_identity.struct_stat = undefined;
    if (posix_identity.fstat(handle, &native_stat) != 0) return error.HutchPrivateStatFailed;
    return .{ .uid = native_stat.st_uid, .mode = @intCast(native_stat.st_mode & 0o777) };
}

fn validatePosixOwnedMode(handle: anytype, expected_mode: u16) !void {
    if (comptime builtin.os.tag == .windows) return;
    const identity = try posixFileIdentity(handle);
    if (identity.uid != posix_identity.geteuid()) return error.HutchPrivateWrongOwner;
    if (identity.mode != expected_mode) return error.HutchPrivateUnsafePermissions;
}

fn validatePosixOwnedExecutable(handle: anytype) !void {
    if (comptime builtin.os.tag == .windows) return;
    const identity = try posixFileIdentity(handle);
    if (identity.uid != posix_identity.geteuid()) return error.HutchPrivateWrongOwner;
    if (identity.mode & 0o100 == 0 or identity.mode & 0o022 != 0)
        return error.HutchPrivateUnsafePermissions;
}

fn expectUnsafePermissions(result: anyerror!void) !void {
    result catch |err| {
        if (err == error.HutchPrivateUnsafePermissions) return;
        return err;
    };
    return error.UnsafePermissionsAccepted;
}

fn setMode(fd: c_int, mode: u16) !void {
    if (c.fchmod(fd, mode) != 0) return error.ChmodFailed;
}

pub fn main() !void {
    const fd = c.open("private-stat-fixture", c.O_RDONLY);
    if (fd < 0) return error.OpenFailed;
    defer _ = c.close(fd);
    var imported = std.mem.zeroes(c.struct_stat);
    var native = std.mem.zeroes(std.c.Stat);
    const imported_status = c.fstat(fd, &imported);
    const native_status = std.c.fstat(fd, &native);
    const uid = c.geteuid();
    std.debug.print("euid={d}\nimported: status={d}, size={d}, uid={d}, mode={o}, ino={d}\nstd.c: status={d}, size={d}, uid={d}, mode={o}, ino={d}\n", .{
        uid,              imported_status, @sizeOf(c.struct_stat), imported.st_uid,
        imported.st_mode, imported.st_ino, native_status,          @sizeOf(std.c.Stat),
        native.uid,       native.mode,     native.ino,
    });
    if (native_status != 0 or native.uid != uid or native.mode & 0o777 != 0o700)
        return error.StdlibStatMismatch;

    const identity = try posixFileIdentity(fd);
    if (identity.uid != uid or identity.mode != 0o700) return error.HelperIdentityMismatch;
    try validatePosixOwnedMode(fd, 0o700);
    std.debug.print("pending helper: uid={d}, mode={o}; owned 0700 directory accepted\n", .{ identity.uid, identity.mode });
    try setMode(fd, 0o770);
    defer setMode(fd, 0o700) catch {};
    try expectUnsafePermissions(validatePosixOwnedMode(fd, 0o700));
    std.debug.print("pending helper: unsafe 0770 directory rejected\n", .{});

    const executable_fd = c.open("private-stat-executable", c.O_RDONLY);
    if (executable_fd < 0) return error.OpenFailed;
    defer _ = c.close(executable_fd);
    try validatePosixOwnedMode(executable_fd, 0o600);
    try expectUnsafePermissions(validatePosixOwnedExecutable(executable_fd));
    std.debug.print("pending helper: owned 0600 file accepted; missing executable bit rejected\n", .{});
    try setMode(executable_fd, 0o700);
    defer setMode(executable_fd, 0o600) catch {};
    try validatePosixOwnedExecutable(executable_fd);
    std.debug.print("pending helper: owned 0700 executable accepted\n", .{});
    for ([_]u16{ 0o720, 0o702 }) |mode| {
        try setMode(executable_fd, mode);
        try expectUnsafePermissions(validatePosixOwnedExecutable(executable_fd));
        std.debug.print("pending helper: unsafe executable mode {o} rejected\n", .{mode});
    }
    std.debug.print("pending private-file identity and permission helpers passed\n", .{});
}
