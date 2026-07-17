const std = @import("std");
const builtin = @import("builtin");

const Value = std.json.Value;

pub const PackageKind = enum {
    npm,
    local,
    workspace,
    git,
};

pub const Task = struct {
    name: []const u8,
    version: []const u8,
    cwd: []const u8,
    kind: PackageKind,
    optional: bool,
};

pub const Queue = struct {
    allocator: std.mem.Allocator,
    tasks: std.array_list.Managed(Task),

    pub fn init(allocator: std.mem.Allocator) Queue {
        return .{
            .allocator = allocator,
            .tasks = std.array_list.Managed(Task).init(allocator),
        };
    }

    pub fn deinit(queue: *Queue) void {
        queue.tasks.deinit();
    }

    pub fn add(queue: *Queue, task: Task) !void {
        for (queue.tasks.items) |existing| {
            if (std.mem.eql(u8, existing.cwd, task.cwd)) return;
        }
        try queue.tasks.append(.{
            .name = try queue.allocator.dupe(u8, task.name),
            .version = try queue.allocator.dupe(u8, task.version),
            .cwd = try queue.allocator.dupe(u8, task.cwd),
            .kind = task.kind,
            .optional = task.optional,
        });
    }

    pub fn run(queue: *Queue, process_init: std.process.Init, root_dir: []const u8, stderr: *std.Io.Writer) !void {
        for (queue.tasks.items) |task| {
            runPackage(process_init, root_dir, task, stderr) catch |err| {
                if (task.optional) continue;
                return err;
            };
        }
    }
};

pub fn runRoot(
    init: std.process.Init,
    root_dir: []const u8,
    root: *const Value,
    stderr: *std.Io.Writer,
) !void {
    try runManifestScripts(init, root_dir, .{
        .name = jsonString(root, "name") orelse "root",
        .version = jsonString(root, "version") orelse "0.0.0",
        .cwd = root_dir,
        .kind = .git,
        .optional = false,
    }, root, stderr);
}

fn runPackage(init: std.process.Init, root_dir: []const u8, task: Task, stderr: *std.Io.Writer) !void {
    const package_json_path = try std.fs.path.join(init.arena.allocator(), &.{ task.cwd, "package.json" });
    const source = std.Io.Dir.cwd().readFileAlloc(
        init.io,
        package_json_path,
        init.arena.allocator(),
        .limited(16 * 1024 * 1024),
    ) catch return;
    const manifest = std.json.parseFromSliceLeaky(Value, init.arena.allocator(), source, .{}) catch return;
    if (manifest != .object) return;
    try runManifestScripts(init, root_dir, task, &manifest, stderr);
}

fn runManifestScripts(
    init: std.process.Init,
    root_dir: []const u8,
    task: Task,
    manifest: *const Value,
    stderr: *std.Io.Writer,
) !void {
    const scripts = if (manifest.* == .object) manifest.object.get("scripts") orelse return else return;
    if (scripts != .object) return;

    const install_stages = [_][]const u8{ "preinstall", "install", "postinstall" };
    for (install_stages) |stage| try runStage(init, root_dir, task, &scripts, stage, stderr);

    switch (task.kind) {
        .npm, .local => {},
        .workspace => try runStage(init, root_dir, task, &scripts, "prepare", stderr),
        .git => {
            const prepare_stages = [_][]const u8{ "preprepare", "prepare", "postprepare" };
            for (prepare_stages) |stage| try runStage(init, root_dir, task, &scripts, stage, stderr);
        },
    }
}

fn runStage(
    init: std.process.Init,
    root_dir: []const u8,
    task: Task,
    scripts: *const Value,
    stage: []const u8,
    stderr: *std.Io.Writer,
) !void {
    const value = scripts.object.get(stage) orelse return;
    if (value != .string or value.string.len == 0) return;

    const allocator = init.arena.allocator();
    var environment = try init.environ_map.clone(allocator);
    defer environment.deinit();
    try configureEnvironment(&environment, allocator, init.io, root_dir, task, stage, value.string);

    const command = try replaceBunCommand(allocator, init.io, value.string);
    const shell_args: []const []const u8 = if (builtin.os.tag == .windows)
        &.{ "cmd.exe", "/d", "/s", "/c", command }
    else
        &.{ "/bin/sh", "-c", command };
    var child = try std.process.spawn(init.io, .{
        .argv = shell_args,
        .cwd = .{ .path = task.cwd },
        .environ_map = &environment,
        .stdin = .inherit,
        .stdout = .inherit,
        .stderr = .inherit,
        .create_no_window = true,
    });
    defer child.kill(init.io);
    const result = try child.wait(init.io);
    const exit_code: u8 = switch (result) {
        .exited => |code| @intCast(@min(code, 255)),
        else => 1,
    };
    if (exit_code == 0) return;

    try stderr.print("error: {s} script from \"{s}\" exited with {d}\n", .{ stage, task.name, exit_code });
    try stderr.flush();
    return error.LifecycleScriptFailed;
}

fn configureEnvironment(
    environment: *std.process.Environ.Map,
    allocator: std.mem.Allocator,
    io: std.Io,
    root_dir: []const u8,
    task: Task,
    stage: []const u8,
    script: []const u8,
) !void {
    try environment.put("INIT_CWD", root_dir);
    try environment.put("npm_lifecycle_event", stage);
    try environment.put("npm_lifecycle_script", script);
    try environment.put("npm_package_name", task.name);
    try environment.put("npm_package_version", task.version);
    try environment.put("npm_config_user_agent", "bun/1.3.10 npm/? node/? cottontail");

    const executable = try std.process.executablePathAlloc(io, allocator);
    try environment.put("npm_execpath", executable);
    try environment.put("npm_node_execpath", executable);
    try environment.put("BUN", executable);

    var path: std.Io.Writer.Allocating = .init(allocator);
    var directory: ?[]const u8 = task.cwd;
    var first = true;
    while (directory) |current| {
        const bin = try std.fs.path.join(allocator, &.{ current, "node_modules", ".bin" });
        if (!first) try path.writer.writeByte(pathDelimiter());
        try path.writer.writeAll(bin);
        first = false;
        if (std.mem.eql(u8, current, root_dir)) break;
        const parent = std.fs.path.dirname(current) orelse break;
        if (std.mem.eql(u8, parent, current)) break;
        directory = parent;
    }
    if (environment.get("PATH")) |original| {
        if (original.len > 0) {
            if (!first) try path.writer.writeByte(pathDelimiter());
            try path.writer.writeAll(original);
        }
    }
    try environment.put("PATH", path.written());
}

fn replaceBunCommand(allocator: std.mem.Allocator, io: std.Io, script: []const u8) ![]const u8 {
    const trimmed = std.mem.trimStart(u8, script, " \t");
    if (!std.mem.startsWith(u8, trimmed, "bun") or
        (trimmed.len > "bun".len and !std.ascii.isWhitespace(trimmed["bun".len]))) return script;

    const executable = try std.process.executablePathAlloc(io, allocator);
    const prefix_len = script.len - trimmed.len;
    if (builtin.os.tag == .windows) {
        return std.fmt.allocPrint(allocator, "{s}\"{s}\"{s}", .{ script[0..prefix_len], executable, trimmed["bun".len..] });
    }
    return std.fmt.allocPrint(allocator, "{s}'{s}'{s}", .{ script[0..prefix_len], executable, trimmed["bun".len..] });
}

fn pathDelimiter() u8 {
    return if (builtin.os.tag == .windows) ';' else ':';
}

fn jsonString(value: *const Value, key: []const u8) ?[]const u8 {
    if (value.* != .object) return null;
    const field = value.object.get(key) orelse return null;
    return if (field == .string) field.string else null;
}

test "lifecycle command replacement only changes the bun executable token" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const unchanged = try replaceBunCommand(arena.allocator(), std.testing.io, "bundle input.ts");
    try std.testing.expectEqualStrings("bundle input.ts", unchanged);
    const replaced = try replaceBunCommand(arena.allocator(), std.testing.io, "bun script.js");
    try std.testing.expect(std.mem.endsWith(u8, replaced, " script.js"));
    try std.testing.expect(!std.mem.eql(u8, replaced, "bun script.js"));
}
