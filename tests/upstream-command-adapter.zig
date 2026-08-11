const std = @import("std");

const package_manager_commands = [_][]const u8{
    "add",
    "audit",
    "create",
    "i",
    "install",
    "link",
    "outdated",
    "patch",
    "pm",
    "publish",
    "remove",
    "rm",
    "uninstall",
    "unlink",
    "update",
    "upgrade",
    "x",
};

fn isPackageManagerCommand(command: []const u8) bool {
    for (package_manager_commands) |candidate| {
        if (std.mem.eql(u8, command, candidate)) return true;
    }
    return false;
}

fn exitCode(term: std.process.Child.Term) u8 {
    return switch (term) {
        .exited => |code| code,
        .signal, .stopped, .unknown => 1,
    };
}

pub fn main(init: std.process.Init) !void {
    const allocator = init.arena.allocator();
    const args = try init.minimal.args.toSlice(allocator);
    const runtime = init.environ_map.get("COTTONTAIL_BINARY") orelse
        return error.CottontailBinaryNotConfigured;
    const package_manager = init.environ_map.get("COTTONTAIL_UPSTREAM_PACKAGE_MANAGER") orelse
        return error.PackageManagerNotConfigured;
    const target = if (args.len > 1 and isPackageManagerCommand(args[1]))
        package_manager
    else
        runtime;

    const child_args = try allocator.alloc([]const u8, args.len);
    child_args[0] = target;
    for (args[1..], 1..) |arg, index| child_args[index] = arg;

    var child = try std.process.spawn(init.io, .{
        .argv = child_args,
        .environ_map = init.environ_map,
        .stdin = .inherit,
        .stdout = .inherit,
        .stderr = .inherit,
        .create_no_window = true,
    });
    defer child.kill(init.io);
    std.process.exit(exitCode(try child.wait(init.io)));
}

test "package-manager command classification is exact" {
    try std.testing.expect(isPackageManagerCommand("install"));
    try std.testing.expect(isPackageManagerCommand("x"));
    try std.testing.expect(!isPackageManagerCommand("build"));
    try std.testing.expect(!isPackageManagerCommand("test"));
    try std.testing.expect(!isPackageManagerCommand("installer"));
}
