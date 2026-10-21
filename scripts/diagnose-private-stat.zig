const std = @import("std");
const c = @cImport({
    @cInclude("sys/stat.h");
    @cInclude("unistd.h");
    @cInclude("fcntl.h");
});

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
        uid, imported_status, @sizeOf(c.struct_stat), imported.st_uid,
        imported.st_mode, imported.st_ino, native_status, @sizeOf(std.c.Stat),
        native.uid, native.mode, native.ino,
    });
    if (native_status != 0 or native.uid != uid or native.mode & 0o777 != 0o700)
        return error.StdlibStatMismatch;
}
