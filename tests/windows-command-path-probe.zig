const std = @import("std");

// Report the executable that PATH actually selected, including Unicode paths.
pub fn main(init: std.process.Init) !void {
    const path = try std.process.executablePathAlloc(init.io, init.arena.allocator());
    var buffer: [1024]u8 = undefined;
    var stdout = std.Io.File.stdout().writerStreaming(init.io, &buffer);
    try stdout.interface.print("{s}\n", .{path});
    try stdout.interface.flush();
}
