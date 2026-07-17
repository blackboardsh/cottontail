const std = @import("std");

pub const Protocol = struct {
    base_spec: []const u8,
    patch_paths: []const []const u8,
};

pub const Target = struct {
    name: []const u8,
    version: ?[]const u8,
};

pub fn parseProtocol(
    allocator: std.mem.Allocator,
    alias: []const u8,
    input: []const u8,
) !?Protocol {
    if (!std.mem.startsWith(u8, input, "patch:")) return null;
    const body = input["patch:".len..];
    const hash = std.mem.lastIndexOfScalar(u8, body, '#') orelse return error.InvalidPatchDependency;
    if (hash == 0 or hash + 1 >= body.len) return error.InvalidPatchDependency;

    const locator = try percentDecode(allocator, body[0..hash]);
    const base_spec = try baseSpecForLocator(allocator, alias, locator);
    if (base_spec.len == 0) return error.InvalidPatchDependency;

    const raw_fragment = if (std.mem.indexOf(u8, body[hash + 1 ..], "::")) |suffix|
        body[hash + 1 .. hash + 1 + suffix]
    else
        body[hash + 1 ..];
    if (std.mem.startsWith(u8, raw_fragment, "~builtin<")) return error.UnsupportedBuiltinPatch;

    var paths = std.array_list.Managed([]const u8).init(allocator);
    var iterator = std.mem.splitScalar(u8, raw_fragment, '&');
    while (iterator.next()) |encoded_path| {
        if (encoded_path.len == 0) continue;
        var decoded = try percentDecode(allocator, encoded_path);
        if (std.mem.startsWith(u8, decoded, "./")) decoded = decoded[2..];
        if (decoded.len == 0) return error.InvalidPatchDependency;
        try paths.append(decoded);
    }
    if (paths.items.len == 0) return error.InvalidPatchDependency;

    return .{
        .base_spec = base_spec,
        .patch_paths = try paths.toOwnedSlice(),
    };
}

pub fn splitTarget(input: []const u8) Target {
    if (input.len == 0) return .{ .name = input, .version = null };
    if (input[0] == '@') {
        const slash = std.mem.indexOfScalar(u8, input, '/') orelse return .{ .name = input, .version = null };
        if (std.mem.indexOfScalarPos(u8, input, slash + 1, '@')) |separator| {
            return .{
                .name = input[0..separator],
                .version = if (separator + 1 < input.len) input[separator + 1 ..] else null,
            };
        }
        return .{ .name = input, .version = null };
    }
    if (std.mem.lastIndexOfScalar(u8, input, '@')) |separator| {
        if (separator > 0) {
            return .{
                .name = input[0..separator],
                .version = if (separator + 1 < input.len) input[separator + 1 ..] else null,
            };
        }
    }
    return .{ .name = input, .version = null };
}

pub fn destinationForLockKey(
    allocator: std.mem.Allocator,
    root_dir: []const u8,
    key: []const u8,
) ![]const u8 {
    var output = std.Io.Writer.Allocating.init(allocator);
    try output.writer.writeAll(root_dir);

    var components = std.mem.splitScalar(u8, key, '/');
    while (components.next()) |first| {
        if (first.len == 0) return error.InvalidPackageKey;
        try output.writer.writeByte(std.fs.path.sep);
        try output.writer.writeAll("node_modules");
        try output.writer.writeByte(std.fs.path.sep);
        try output.writer.writeAll(first);
        if (first[0] == '@') {
            const second = components.next() orelse return error.InvalidPackageKey;
            if (second.len == 0) return error.InvalidPackageKey;
            try output.writer.writeByte(std.fs.path.sep);
            try output.writer.writeAll(second);
        }
    }
    return output.toOwnedSlice();
}

pub fn escapeFilename(allocator: std.mem.Allocator, name: []const u8) ![]const u8 {
    var output = std.Io.Writer.Allocating.init(allocator);
    for (name) |byte| switch (byte) {
        '/' => try output.writer.writeAll("%2F"),
        '\\' => try output.writer.writeAll("%5c"),
        ' ' => try output.writer.writeAll("%20"),
        '\n' => try output.writer.writeAll("%0A"),
        '\r' => try output.writer.writeAll("%0D"),
        '\t' => try output.writer.writeAll("%09"),
        else => try output.writer.writeByte(byte),
    };
    return output.toOwnedSlice();
}

fn percentDecode(allocator: std.mem.Allocator, input: []const u8) ![]const u8 {
    if (std.mem.indexOfScalar(u8, input, '%') == null) return allocator.dupe(u8, input);
    const output = try allocator.alloc(u8, input.len);
    var read_index: usize = 0;
    var write_index: usize = 0;
    while (read_index < input.len) {
        if (input[read_index] == '%') {
            if (read_index + 2 >= input.len) return error.InvalidPatchDependency;
            const high = std.fmt.charToDigit(input[read_index + 1], 16) catch return error.InvalidPatchDependency;
            const low = std.fmt.charToDigit(input[read_index + 2], 16) catch return error.InvalidPatchDependency;
            output[write_index] = @intCast(high * 16 + low);
            read_index += 3;
        } else {
            output[write_index] = input[read_index];
            read_index += 1;
        }
        write_index += 1;
    }
    return output[0..write_index];
}

fn baseSpecForLocator(allocator: std.mem.Allocator, alias: []const u8, locator: []const u8) ![]const u8 {
    const npm_marker = "@npm:";
    if (std.mem.lastIndexOf(u8, locator, npm_marker)) |marker| {
        const package_name = locator[0..marker];
        const reference = locator[marker + npm_marker.len ..];
        if (package_name.len == 0 or reference.len == 0) return error.InvalidPatchDependency;
        if (std.mem.eql(u8, package_name, alias)) return allocator.dupe(u8, reference);
        return std.fmt.allocPrint(allocator, "npm:{s}@{s}", .{ package_name, reference });
    }

    if (std.mem.startsWith(u8, locator, alias) and locator.len > alias.len and locator[alias.len] == '@') {
        const reference = locator[alias.len + 1 ..];
        if (reference.len == 0) return error.InvalidPatchDependency;
        return allocator.dupe(u8, reference);
    }
    if (locator.len == 0) return error.InvalidPatchDependency;
    return allocator.dupe(u8, locator);
}

test "parse patch protocol and package targets" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();

    const protocol = (try parseProtocol(
        allocator,
        "@scope/pkg",
        "patch:@scope/pkg@npm%3A1.2.3#./patches%2Fscope.patch::version=1.2.3",
    )).?;
    try std.testing.expectEqualStrings("1.2.3", protocol.base_spec);
    try std.testing.expectEqual(@as(usize, 1), protocol.patch_paths.len);
    try std.testing.expectEqualStrings("patches/scope.patch", protocol.patch_paths[0]);

    const alias_protocol = (try parseProtocol(
        allocator,
        "even-alias",
        "patch:is-even@npm%3A1.0.0#./patches%2Fone.patch&.%2Fpatches%2Ftwo.patch",
    )).?;
    try std.testing.expectEqualStrings("npm:is-even@1.0.0", alias_protocol.base_spec);
    try std.testing.expectEqual(@as(usize, 2), alias_protocol.patch_paths.len);
    try std.testing.expectEqualStrings("patches/one.patch", alias_protocol.patch_paths[0]);
    try std.testing.expectEqualStrings("patches/two.patch", alias_protocol.patch_paths[1]);
    try std.testing.expectError(
        error.InvalidPatchDependency,
        parseProtocol(allocator, "is-even", "patch:is-even@npm%3A1.0.0#bad%"),
    );

    const target = splitTarget("@scope/pkg@1.2.3");
    try std.testing.expectEqualStrings("@scope/pkg", target.name);
    try std.testing.expectEqualStrings("1.2.3", target.version.?);
    try std.testing.expectEqualStrings("@scope%2Fpkg@1.2.3.patch", try escapeFilename(allocator, "@scope/pkg@1.2.3.patch"));
}

test "convert nested lock keys to node_modules paths" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const path = try destinationForLockKey(arena.allocator(), "/project", "parent/@scope/pkg");
    try std.testing.expectEqualStrings(
        "/project/node_modules/parent/node_modules/@scope/pkg",
        path,
    );
}
