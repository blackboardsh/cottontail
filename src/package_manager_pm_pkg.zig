const std = @import("std");
const Lockfile = @import("package_manager_lockfile.zig");

const Value = std.json.Value;

const PackageJson = struct {
    path: []const u8,
    contents: []const u8,
    root: Value,
    whitespace: Whitespace,
    trailing_newline: bool,
};

const Whitespace = enum {
    minified,
    indent_1,
    indent_2,
    indent_3,
    indent_4,
    indent_8,
    indent_tab,
};

const PathError = error{
    EmptyKey,
    EmptyBracket,
    InvalidPath,
};

pub fn run(
    io: std.Io,
    allocator: std.mem.Allocator,
    args: []const []const u8,
    parse_json: bool,
    cwd: []const u8,
    stdout: *std.Io.Writer,
    stderr: *std.Io.Writer,
) !u8 {
    if (args.len == 0) {
        try printHelp(stdout);
        return 0;
    }

    const subcommand = args[0];
    if (std.mem.eql(u8, subcommand, "get")) {
        return runGet(io, allocator, args[1..], cwd, stdout, stderr);
    }
    if (std.mem.eql(u8, subcommand, "set")) {
        return runSet(io, allocator, args[1..], parse_json, cwd, stderr);
    }
    if (std.mem.eql(u8, subcommand, "delete")) {
        return runDelete(io, allocator, args[1..], cwd, stderr);
    }
    if (std.mem.eql(u8, subcommand, "fix")) {
        return runFix(io, allocator, cwd, stderr);
    }
    if (std.mem.eql(u8, subcommand, "help")) {
        try printHelp(stdout);
        return 0;
    }

    try stderr.print("error: Unknown subcommand: {s}\n", .{subcommand});
    try stderr.flush();
    try printHelp(stdout);
    return 1;
}

fn printHelp(writer: *std.Io.Writer) !void {
    try writer.writeAll(
        \\bun pm pkg
        \\  Manage data in package.json
        \\
        \\Subcommands:
        \\  get [key ...]          Get values from package.json
        \\  set key=value ...      Set values in package.json
        \\  delete key ...         Delete keys from package.json
        \\  fix                    Auto-correct common package.json errors
        \\
    );
    try writer.flush();
}

fn runGet(
    io: std.Io,
    allocator: std.mem.Allocator,
    args: []const []const u8,
    cwd: []const u8,
    stdout: *std.Io.Writer,
    stderr: *std.Io.Writer,
) !u8 {
    var package_json = loadPackageJson(io, allocator, cwd) catch |err| {
        return reportLoadError(err, stderr);
    };
    if (package_json.root != .object) {
        try stderr.writeAll("error: package.json root must be an object\n");
        try stderr.flush();
        return 1;
    }

    if (args.len == 0) {
        try writePrettyValue(stdout, package_json.root);
        try stdout.writeByte('\n');
        try stdout.flush();
        return 0;
    }

    var found: usize = 0;
    for (args) |key| {
        const value = resolveKeyPath(allocator, &package_json.root, key) catch |err| {
            if (err == error.EmptyBracket) {
                try stderr.writeAll("error: Empty brackets are not valid syntax for retrieving values.\n");
                try stderr.flush();
                return 1;
            }
            continue;
        };
        if (value != null) found += 1;
    }

    if (found == 0) {
        try stdout.writeAll("{}\n");
    } else if (found == 1) {
        for (args) |key| {
            const value = resolveKeyPath(allocator, &package_json.root, key) catch continue;
            if (value) |resolved| {
                try writePrettyValue(stdout, resolved.*);
                try stdout.writeByte('\n');
                break;
            }
        }
    } else {
        try stdout.writeAll("{\n");
        var written: usize = 0;
        for (args) |key| {
            const value = resolveKeyPath(allocator, &package_json.root, key) catch continue;
            const resolved = value orelse continue;
            try stdout.writeAll("  ");
            try std.json.Stringify.value(key, .{}, stdout);
            try stdout.writeAll(": ");
            try writePrettyValueIndented(stdout, resolved.*, 2);
            written += 1;
            try stdout.writeAll(if (written == found) "\n" else ",\n");
        }
        try stdout.writeAll("}\n");
    }
    try stdout.flush();
    return 0;
}

fn runSet(
    io: std.Io,
    allocator: std.mem.Allocator,
    args: []const []const u8,
    parse_json: bool,
    cwd: []const u8,
    stderr: *std.Io.Writer,
) !u8 {
    if (args.len == 0) {
        try stderr.writeAll("error: bun pm pkg set expects a key=value pair of args\n");
        try stderr.flush();
        return 1;
    }

    var package_json = loadPackageJson(io, allocator, cwd) catch |err| {
        return reportLoadError(err, stderr);
    };
    if (package_json.root != .object) {
        try stderr.writeAll("error: package.json root must be an object\n");
        try stderr.flush();
        return 1;
    }

    for (args) |arg| {
        const equals = std.mem.indexOfScalar(u8, arg, '=') orelse {
            try stderr.print("error: Invalid argument: {s} (expected key=value)\n", .{arg});
            try stderr.flush();
            return 1;
        };
        const key = arg[0..equals];
        const raw_value = arg[equals + 1 ..];
        if (key.len == 0) {
            try stderr.print("error: Empty key in argument: {s}\n", .{arg});
            try stderr.flush();
            return 1;
        }
        if (raw_value.len == 0) {
            try stderr.print("error: Empty value in argument: {s}\n", .{arg});
            try stderr.flush();
            return 1;
        }

        const parts = parseKeyPath(allocator, key) catch |err| {
            try stderr.print("error: Invalid key path '{s}': {s}\n", .{ key, @errorName(err) });
            try stderr.flush();
            return 1;
        };
        if (parts.items.len == 0) return 1;
        const value = try parseSetValue(allocator, raw_value, parse_json);
        try setPath(allocator, &package_json.root, parts.items, value);
    }

    try savePackageJson(io, allocator, &package_json);
    return 0;
}

fn runDelete(
    io: std.Io,
    allocator: std.mem.Allocator,
    args: []const []const u8,
    cwd: []const u8,
    stderr: *std.Io.Writer,
) !u8 {
    if (args.len == 0) {
        try stderr.writeAll("error: bun pm pkg delete expects key args\n");
        try stderr.flush();
        return 1;
    }

    var package_json = loadPackageJson(io, allocator, cwd) catch |err| {
        return reportLoadError(err, stderr);
    };
    if (package_json.root != .object) {
        try stderr.writeAll("error: package.json root must be an object\n");
        try stderr.flush();
        return 1;
    }

    var modified = false;
    for (args) |key| {
        const parts = parseKeyPath(allocator, key) catch continue;
        modified = (try deletePath(&package_json.root, parts.items)) or modified;
    }
    if (modified) try savePackageJson(io, allocator, &package_json);
    return 0;
}

fn runFix(
    io: std.Io,
    allocator: std.mem.Allocator,
    cwd: []const u8,
    stderr: *std.Io.Writer,
) !u8 {
    var package_json = loadPackageJson(io, allocator, cwd) catch |err| {
        return reportLoadError(err, stderr);
    };
    if (package_json.root != .object) {
        try stderr.writeAll("error: package.json root must be an object\n");
        try stderr.flush();
        return 1;
    }

    var modified = false;
    if (package_json.root.object.getPtr("name")) |name| {
        if (name.* == .string) {
            const lowercase = try std.ascii.allocLowerString(allocator, name.string);
            if (!std.mem.eql(u8, lowercase, name.string)) {
                name.* = .{ .string = lowercase };
                modified = true;
            }
        }
    }

    if (package_json.root.object.get("bin")) |bin| {
        if (bin == .object) {
            const package_dir = std.fs.path.dirname(package_json.path) orelse cwd;
            for (bin.object.values()) |entry| {
                if (entry != .string) continue;
                const full_path = try std.fs.path.join(allocator, &.{ package_dir, entry.string });
                std.Io.Dir.cwd().access(io, full_path, .{}) catch {
                    try stderr.print("warn: No bin file found at {s}\n", .{entry.string});
                };
            }
        }
    }

    if (modified) try savePackageJson(io, allocator, &package_json);
    try stderr.flush();
    return 0;
}

fn loadPackageJson(io: std.Io, allocator: std.mem.Allocator, cwd: []const u8) !PackageJson {
    const path = try findPackageJson(io, allocator, cwd) orelse return error.PackageJsonNotFound;
    const contents = std.Io.Dir.cwd().readFileAlloc(
        io,
        path,
        allocator,
        .limited(64 * 1024 * 1024),
    ) catch return error.PackageJsonReadFailed;
    const normalized = Lockfile.normalizeJsonc(allocator, contents) catch return error.PackageJsonParseFailed;
    const root = std.json.parseFromSliceLeaky(Value, allocator, normalized, .{
        .duplicate_field_behavior = .use_last,
    }) catch return error.PackageJsonParseFailed;
    return .{
        .path = path,
        .contents = contents,
        .root = root,
        .whitespace = detectWhitespace(contents),
        .trailing_newline = contents.len > 0 and contents[contents.len - 1] == '\n',
    };
}

fn reportLoadError(err: anyerror, stderr: *std.Io.Writer) !u8 {
    switch (err) {
        error.PackageJsonNotFound => try stderr.writeAll("error: No package.json was found\n"),
        error.PackageJsonParseFailed => try stderr.writeAll("error: Failed to parse package.json\n"),
        else => try stderr.print("error: Failed to read package.json: {s}\n", .{@errorName(err)}),
    }
    try stderr.flush();
    return 1;
}

fn findPackageJson(io: std.Io, allocator: std.mem.Allocator, cwd: []const u8) !?[]const u8 {
    var current = cwd;
    while (true) {
        const path = try std.fs.path.join(allocator, &.{ current, "package.json" });
        if (std.Io.Dir.cwd().access(io, path, .{})) |_| return path else |_| {}
        const parent = std.fs.path.dirname(current) orelse return null;
        if (std.mem.eql(u8, parent, current)) return null;
        current = parent;
    }
}

fn detectWhitespace(source: []const u8) Whitespace {
    const newline = std.mem.indexOfScalar(u8, source, '\n') orelse return .minified;
    var index = newline + 1;
    if (index < source.len and source[index] == '\t') return .indent_tab;
    var spaces: usize = 0;
    while (index < source.len and source[index] == ' ') : (index += 1) spaces += 1;
    return switch (spaces) {
        1 => .indent_1,
        2 => .indent_2,
        3 => .indent_3,
        4 => .indent_4,
        8 => .indent_8,
        else => .indent_2,
    };
}

fn savePackageJson(io: std.Io, allocator: std.mem.Allocator, package_json: *const PackageJson) !void {
    var output: std.Io.Writer.Allocating = .init(allocator);
    switch (package_json.whitespace) {
        .minified => try std.json.Stringify.value(package_json.root, .{}, &output.writer),
        .indent_1 => try std.json.Stringify.value(package_json.root, .{ .whitespace = .indent_1 }, &output.writer),
        .indent_2 => try std.json.Stringify.value(package_json.root, .{ .whitespace = .indent_2 }, &output.writer),
        .indent_3 => try std.json.Stringify.value(package_json.root, .{ .whitespace = .indent_3 }, &output.writer),
        .indent_4 => try std.json.Stringify.value(package_json.root, .{ .whitespace = .indent_4 }, &output.writer),
        .indent_8 => try std.json.Stringify.value(package_json.root, .{ .whitespace = .indent_8 }, &output.writer),
        .indent_tab => try std.json.Stringify.value(package_json.root, .{ .whitespace = .indent_tab }, &output.writer),
    }
    if (package_json.trailing_newline) try output.writer.writeByte('\n');
    try std.Io.Dir.cwd().writeFile(io, .{ .sub_path = package_json.path, .data = output.written() });
}

fn parseKeyPath(allocator: std.mem.Allocator, key: []const u8) PathError!std.array_list.Managed([]const u8) {
    if (key.len == 0) return error.EmptyKey;
    var parts = std.array_list.Managed([]const u8).init(allocator);
    var index: usize = 0;
    var start: usize = 0;
    while (index < key.len) {
        switch (key[index]) {
            '.' => {
                if (index > start) parts.append(key[start..index]) catch return error.InvalidPath;
                index += 1;
                start = index;
            },
            '[' => {
                if (index > start) parts.append(key[start..index]) catch return error.InvalidPath;
                const close = std.mem.indexOfScalarPos(u8, key, index + 1, ']') orelse return error.InvalidPath;
                if (close == index + 1) return error.EmptyBracket;
                parts.append(key[index + 1 .. close]) catch return error.InvalidPath;
                index = close + 1;
                if (index < key.len and key[index] == '.') index += 1;
                start = index;
            },
            else => index += 1,
        }
    }
    if (start < key.len) parts.append(key[start..]) catch return error.InvalidPath;
    if (parts.items.len == 0) return error.EmptyKey;
    return parts;
}

fn resolveKeyPath(allocator: std.mem.Allocator, root: *const Value, key: []const u8) PathError!?*const Value {
    const parts = try parseKeyPath(allocator, key);
    var current = root;
    for (parts.items) |part| {
        current = switch (current.*) {
            .object => |*object| object.getPtr(part) orelse return null,
            .array => |*array| blk: {
                const item_index = std.fmt.parseInt(usize, part, 10) catch return null;
                if (item_index >= array.items.len) return null;
                break :blk &array.items[item_index];
            },
            else => return null,
        };
    }
    return current;
}

fn parseSetValue(allocator: std.mem.Allocator, source: []const u8, parse_json: bool) !Value {
    if (!parse_json) return .{ .string = try allocator.dupe(u8, source) };
    return std.json.parseFromSliceLeaky(Value, allocator, source, .{
        .duplicate_field_behavior = .use_last,
    }) catch .{ .string = try allocator.dupe(u8, source) };
}

fn setPath(allocator: std.mem.Allocator, root: *Value, parts: []const []const u8, value: Value) !void {
    var current = root;
    for (parts[0 .. parts.len - 1]) |part| {
        if (current.* != .object) current.* = .{ .object = .{} };
        if (current.object.getPtr(part) == null) {
            try current.object.put(allocator, part, .{ .object = .{} });
        }
        const child = current.object.getPtr(part).?;
        if (child.* != .object) child.* = .{ .object = .{} };
        current = child;
    }
    if (current.* != .object) current.* = .{ .object = .{} };
    try current.object.put(allocator, parts[parts.len - 1], value);
}

fn deletePath(root: *Value, parts: []const []const u8) !bool {
    if (parts.len == 0) return false;
    var current = root;
    for (parts[0 .. parts.len - 1]) |part| {
        current = switch (current.*) {
            .object => |*object| object.getPtr(part) orelse return false,
            .array => |*array| blk: {
                const item_index = std.fmt.parseInt(usize, part, 10) catch return false;
                if (item_index >= array.items.len) return false;
                break :blk &array.items[item_index];
            },
            else => return false,
        };
    }
    const final = parts[parts.len - 1];
    return switch (current.*) {
        .object => |*object| object.orderedRemove(final),
        .array => |*array| blk: {
            const item_index = std.fmt.parseInt(usize, final, 10) catch return false;
            if (item_index >= array.items.len) return false;
            _ = array.orderedRemove(item_index);
            break :blk true;
        },
        else => false,
    };
}

fn writePrettyValue(writer: *std.Io.Writer, value: Value) !void {
    switch (value) {
        .object, .array => try std.json.Stringify.value(value, .{ .whitespace = .indent_2 }, writer),
        else => try std.json.Stringify.value(value, .{}, writer),
    }
}

fn writePrettyValueIndented(writer: *std.Io.Writer, value: Value, indentation: usize) !void {
    if (value != .object and value != .array) return writePrettyValue(writer, value);
    var output: std.Io.Writer.Allocating = .init(std.heap.page_allocator);
    defer output.deinit();
    try writePrettyValue(&output.writer, value);
    var lines = std.mem.splitScalar(u8, output.written(), '\n');
    if (lines.next()) |first| try writer.writeAll(first);
    while (lines.next()) |line| {
        try writer.writeByte('\n');
        try writer.splatByteAll(' ', indentation);
        try writer.writeAll(line);
    }
}
