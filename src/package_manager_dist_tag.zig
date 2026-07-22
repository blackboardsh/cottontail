const std = @import("std");
const compiler = @import("cottontail_compiler");
const Publish = @import("package_manager_publish.zig");

const Value = std.json.Value;

pub const Options = struct {
    otp: []const u8 = "",
    auth_type: ?Publish.AuthType = null,
};

const Add = struct {
    name: []const u8,
    version: []const u8,
    tag: []const u8,
};

const Remove = struct {
    name: []const u8,
    tag: []const u8,
};

const List = struct {
    name: []const u8,
};

pub const Action = union(enum) {
    add: Add,
    remove: Remove,
    list: List,

    pub fn packageName(action: Action) []const u8 {
        return switch (action) {
            inline else => |payload| payload.name,
        };
    }
};

const PackageSpec = struct {
    name: []const u8,
    version: ?[]const u8,
};

pub fn parse(args: []const []const u8, default_package_name: ?[]const u8) !Action {
    if (args.len == 0) return .{ .list = .{ .name = try requireDefaultPackage(default_package_name) } };

    const command = args[0];
    if (isAddCommand(command)) {
        if (args.len < 2 or args.len > 3) return error.InvalidDistTagUsage;
        const spec = try parsePackageSpec(args[1]);
        const version = spec.version orelse return error.MissingDistTagVersion;
        const tag = if (args.len == 3) args[2] else "latest";
        try Publish.validateDistTag(tag);
        return .{ .add = .{ .name = spec.name, .version = version, .tag = tag } };
    }
    if (isRemoveCommand(command)) {
        if (args.len != 3 or args[2].len == 0) return error.InvalidDistTagUsage;
        const spec = try parsePackageSpec(args[1]);
        return .{ .remove = .{ .name = spec.name, .tag = args[2] } };
    }
    if (isListCommand(command)) {
        if (args.len > 2) return error.InvalidDistTagUsage;
        const name = if (args.len == 2)
            (try parsePackageSpec(args[1])).name
        else
            try requireDefaultPackage(default_package_name);
        return .{ .list = .{ .name = name } };
    }
    if (args.len == 1) return .{ .list = .{ .name = (try parsePackageSpec(command)).name } };
    return error.InvalidDistTagUsage;
}

pub fn run(
    init: std.process.Init,
    client: *std.http.Client,
    action: Action,
    registry: Publish.Registry,
    options: Options,
    stdout: *std.Io.Writer,
    stderr: *std.Io.Writer,
) !u8 {
    runImpl(init, client, action, registry, options, stdout, stderr) catch |err| {
        if (err != error.RegistryRequestReported and err != error.RegistryAuthenticationReported) {
            try stderr.print("error: dist-tag request failed: {s}\n", .{@errorName(err)});
            try stderr.flush();
        }
        return 1;
    };
    return 0;
}

fn runImpl(
    init: std.process.Init,
    client: *std.http.Client,
    action: Action,
    registry: Publish.Registry,
    options: Options,
    stdout: *std.Io.Writer,
    stderr: *std.Io.Writer,
) !void {
    const allocator = init.arena.allocator();
    const package_name = action.packageName();
    const tags_url = try distTagsURL(allocator, registry.url, package_name);
    const tags = try fetchTags(init, client, tags_url, package_name, registry, options, stdout, stderr);

    switch (action) {
        .list => try printTags(allocator, tags, stdout),
        .add => |add| {
            if (tags.get(add.tag)) |current| {
                if (current == .string and std.mem.eql(u8, current.string, add.version)) {
                    try stderr.print("warn: dist-tag {s} is already set to version {s}\n", .{ add.tag, add.version });
                    try stderr.flush();
                    return;
                }
            }

            const tag_url = try distTagURL(allocator, tags_url, add.tag);
            var body_writer: std.Io.Writer.Allocating = .init(allocator);
            try std.json.Stringify.value(add.version, .{}, &body_writer.writer);
            const body = try body_writer.toOwnedSlice();
            _ = try mutateTag(init, client, .PUT, tag_url, registry, options, body, stdout, stderr);
            try stdout.print("+{s}: {s}@{s}\n", .{ add.tag, add.name, add.version });
        },
        .remove => |remove| {
            const current = tags.get(remove.tag) orelse {
                try stderr.print("error: {s} is not a dist-tag on {s}\n", .{ remove.tag, remove.name });
                try stderr.flush();
                return error.RegistryRequestReported;
            };
            if (current != .string) {
                try stderr.print("error: {s} is not a dist-tag on {s}\n", .{ remove.tag, remove.name });
                try stderr.flush();
                return error.RegistryRequestReported;
            }

            const tag_url = try distTagURL(allocator, tags_url, remove.tag);
            _ = try mutateTag(init, client, .DELETE, tag_url, registry, options, null, stdout, stderr);
            try stdout.print("-{s}: {s}@{s}\n", .{ remove.tag, remove.name, current.string });
        },
    }
    try stdout.flush();
}

fn fetchTags(
    init: std.process.Init,
    client: *std.http.Client,
    url: []const u8,
    package_name: []const u8,
    registry: Publish.Registry,
    options: Options,
    stdout: *std.Io.Writer,
    stderr: *std.Io.Writer,
) !std.json.ObjectMap {
    const response = try sendRequest(init, client, .GET, url, registry, options, null, stdout, stderr);
    const parsed = std.json.parseFromSliceLeaky(Value, init.arena.allocator(), response.body, .{}) catch {
        try stderr.print("error: invalid dist-tag response for {s}\n", .{package_name});
        try stderr.flush();
        return error.RegistryRequestReported;
    };
    if (parsed != .object or countTags(parsed.object) == 0) {
        try stderr.print("error: No dist-tags found for {s}\n", .{package_name});
        try stderr.flush();
        return error.RegistryRequestReported;
    }
    return parsed.object;
}

fn mutateTag(
    init: std.process.Init,
    client: *std.http.Client,
    method: std.http.Method,
    url: []const u8,
    registry: Publish.Registry,
    options: Options,
    body: ?[]u8,
    stdout: *std.Io.Writer,
    stderr: *std.Io.Writer,
) !Publish.RegistryResponse {
    return sendRequest(init, client, method, url, registry, options, body, stdout, stderr);
}

fn sendRequest(
    init: std.process.Init,
    client: *std.http.Client,
    method: std.http.Method,
    url: []const u8,
    registry: Publish.Registry,
    options: Options,
    body: ?[]u8,
    stdout: *std.Io.Writer,
    stderr: *std.Io.Writer,
) !Publish.RegistryResponse {
    const authenticated = try Publish.requestWithOtp(
        init,
        client,
        method,
        url,
        registry,
        .{ .auth_type = options.auth_type, .npm_command = "dist-tag" },
        if (options.otp.len > 0) options.otp else null,
        body,
        stdout,
        stderr,
    );
    if (authenticated.response.status < 200 or authenticated.response.status >= 300) {
        try Publish.printRegistryError(stderr, @tagName(method), url, authenticated.response, authenticated.otp_retry);
        return error.RegistryRequestReported;
    }
    try Publish.printNotice(stderr, authenticated.response);
    return authenticated.response;
}

fn printTags(allocator: std.mem.Allocator, tags: std.json.ObjectMap, stdout: *std.Io.Writer) !void {
    const count = countTags(tags);
    const names = try allocator.alloc([]const u8, count);
    var index: usize = 0;
    for (tags.keys(), tags.values()) |name, value| {
        if (std.mem.eql(u8, name, "_etag") or value != .string) continue;
        names[index] = name;
        index += 1;
    }
    std.sort.pdq([]const u8, names, {}, struct {
        fn lessThan(_: void, left: []const u8, right: []const u8) bool {
            return std.mem.lessThan(u8, left, right);
        }
    }.lessThan);
    for (names) |name| try stdout.print("{s}: {s}\n", .{ name, tags.get(name).?.string });
}

fn countTags(tags: std.json.ObjectMap) usize {
    var count: usize = 0;
    for (tags.keys(), tags.values()) |name, value| {
        if (!std.mem.eql(u8, name, "_etag") and value == .string) count += 1;
    }
    return count;
}

fn parsePackageSpec(input: []const u8) !PackageSpec {
    if (input.len == 0) return error.InvalidDistTagPackage;
    const version_at = if (input[0] == '@') blk: {
        const slash = std.mem.indexOfScalar(u8, input, '/') orelse return error.InvalidDistTagPackage;
        break :blk std.mem.indexOfScalarPos(u8, input, slash + 1, '@');
    } else std.mem.indexOfScalar(u8, input, '@');
    const name = if (version_at) |at| input[0..at] else input;
    if (!compiler.strings.isNPMPackageName(name)) return error.InvalidDistTagPackage;
    const version = if (version_at) |at| blk: {
        if (at + 1 >= input.len) return error.MissingDistTagVersion;
        const value = input[at + 1 ..];
        if (!std.mem.eql(u8, value, std.mem.trim(u8, value, " \t\r\n"))) return error.InvalidDistTagVersion;
        break :blk value;
    } else null;
    return .{ .name = name, .version = version };
}

fn requireDefaultPackage(name: ?[]const u8) ![]const u8 {
    const value = name orelse return error.MissingDistTagPackage;
    if (!compiler.strings.isNPMPackageName(value)) return error.InvalidDistTagPackage;
    return value;
}

fn distTagsURL(allocator: std.mem.Allocator, registry_url: []const u8, package_name: []const u8) ![]const u8 {
    const encoded_name = if (package_name[0] == '@') blk: {
        const slash = std.mem.indexOfScalar(u8, package_name, '/') orelse unreachable;
        break :blk try std.fmt.allocPrint(allocator, "{s}%2f{s}", .{ package_name[0..slash], package_name[slash + 1 ..] });
    } else package_name;
    return std.fmt.allocPrint(
        allocator,
        "{s}/-/package/{s}/dist-tags",
        .{ std.mem.trimEnd(u8, registry_url, "/"), encoded_name },
    );
}

fn distTagURL(allocator: std.mem.Allocator, tags_url: []const u8, tag: []const u8) ![]const u8 {
    var encoded: std.Io.Writer.Allocating = .init(allocator);
    for (tag) |byte| {
        if (isEncodeURIComponentSafe(byte)) {
            try encoded.writer.writeByte(byte);
        } else {
            try encoded.writer.print("%{X:0>2}", .{byte});
        }
    }
    return std.fmt.allocPrint(allocator, "{s}/{s}", .{ tags_url, encoded.written() });
}

fn isEncodeURIComponentSafe(byte: u8) bool {
    return std.ascii.isAlphanumeric(byte) or switch (byte) {
        '-', '_', '.', '!', '~', '*', '\'', '(', ')' => true,
        else => false,
    };
}

fn isAddCommand(command: []const u8) bool {
    return std.mem.eql(u8, command, "add") or std.mem.eql(u8, command, "a") or
        std.mem.eql(u8, command, "set") or std.mem.eql(u8, command, "s");
}

fn isRemoveCommand(command: []const u8) bool {
    return std.mem.eql(u8, command, "rm") or std.mem.eql(u8, command, "r") or
        std.mem.eql(u8, command, "del") or std.mem.eql(u8, command, "d") or
        std.mem.eql(u8, command, "remove");
}

fn isListCommand(command: []const u8) bool {
    return std.mem.eql(u8, command, "ls") or std.mem.eql(u8, command, "l") or
        std.mem.eql(u8, command, "sl") or std.mem.eql(u8, command, "list");
}

test "dist-tag action parsing handles scoped package versions" {
    const action = try parse(&.{ "add", "@scope/pkg@1.2.3", "next" }, null);
    try std.testing.expectEqualStrings("@scope/pkg", action.add.name);
    try std.testing.expectEqualStrings("1.2.3", action.add.version);
    try std.testing.expectEqualStrings("next", action.add.tag);
}

test "dist-tag URL uses the npm scoped package endpoint" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    try std.testing.expectEqualStrings(
        "https://registry.example/-/package/@scope%2fpkg/dist-tags",
        try distTagsURL(arena.allocator(), "https://registry.example/", "@scope/pkg"),
    );
}
