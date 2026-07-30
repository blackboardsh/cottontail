const std = @import("std");
const Analyzer = @import("package_manager_analyzer.zig");

pub fn scanDependencies(
    init: std.process.Init,
    allocator: std.mem.Allocator,
    entry_points: []const []const u8,
    working_dir: []const u8,
    stderr: *std.Io.Writer,
) ![]const []const u8 {
    return Analyzer.scan(
        allocator,
        init.io,
        entry_points,
        working_dir,
        stderr,
    );
}
