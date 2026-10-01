const std = @import("std");

// Native test doubles preserve the full argv that the real runtime and command
// adapter accept. A .cmd wrapper cannot forward multiline --eval arguments.
pub fn main(init: std.process.Init) !void {
    const allocator = init.arena.allocator();
    const args = try init.minimal.args.toSlice(allocator);
    const node = init.environ_map.get("COTTONTAIL_RUNNER_TEST_NODE") orelse return error.MissingFixtureNode;
    const capture = init.environ_map.get("COTTONTAIL_RUNNER_TEST_CAPTURE") orelse return error.MissingFixtureCapture;
    const fixture_root = std.fs.path.dirname(capture) orelse return error.MissingFixtureRoot;
    const executable = std.fs.path.basename(try std.process.executablePathAlloc(init.io, allocator));
    var argv: std.ArrayList([]const u8) = .empty;
    try argv.append(allocator, node);
    if (std.mem.eql(u8, executable, "command-adapter.exe")) {
        try argv.append(allocator, try std.fs.path.join(allocator, &.{ fixture_root, "command-adapter-driver.cjs" }));
    } else if (std.mem.eql(u8, executable, "package-manager.exe")) {
        try argv.append(allocator, try std.fs.path.join(allocator, &.{ fixture_root, "package-manager-driver.cjs" }));
    } else if (std.mem.eql(u8, init.environ_map.get("COTTONTAIL_UPSTREAM_PREFLIGHT") orelse "", "1")) {
        try argv.append(allocator, "--require");
        try argv.append(allocator, try std.fs.path.join(allocator, &.{ fixture_root, "preflight-shim.cjs" }));
    }
    for (args[1..]) |arg| try argv.append(allocator, arg);
    var child = try std.process.spawn(init.io, .{
        .argv = argv.items,
        .environ_map = init.environ_map,
        .stdin = .inherit,
        .stdout = .inherit,
        .stderr = .inherit,
    });
    defer child.kill(init.io);
    const result = try child.wait(init.io);
    std.process.exit(switch (result) {
        .exited => |code| code,
        else => 1,
    });
}
