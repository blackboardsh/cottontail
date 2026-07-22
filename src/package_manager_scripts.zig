const std = @import("std");
const builtin = @import("builtin");

const Value = std.json.Value;

pub const PackageKind = enum {
    npm,
    local,
    workspace,
    git,
};

pub const lifecycle_stage_names = [_][]const u8{
    "preinstall",
    "install",
    "postinstall",
    "preprepare",
    "prepare",
    "postprepare",
};

pub const LifecycleScripts = struct {
    commands: [lifecycle_stage_names.len]?[]const u8 = .{null} ** lifecycle_stage_names.len,
    total: usize = 0,
};

pub fn inspectLifecycleScripts(
    io: std.Io,
    allocator: std.mem.Allocator,
    package_dir: []const u8,
    manifest: *const Value,
    kind: PackageKind,
) !LifecycleScripts {
    var result: LifecycleScripts = .{};
    const scripts = if (manifest.* == .object) manifest.object.get("scripts") else null;
    if (scripts != null and scripts.? == .object) {
        for (lifecycle_stage_names, 0..) |stage, index| {
            const include = switch (index) {
                0...2 => true,
                3, 5 => kind == .git,
                4 => kind == .git or kind == .workspace,
                else => unreachable,
            };
            if (!include) continue;
            const command = scripts.?.object.get(stage) orelse continue;
            if (command != .string or command.string.len == 0) continue;
            result.commands[index] = command.string;
            result.total += 1;
        }
    }

    if (result.commands[0] == null and result.commands[1] == null) {
        const binding_gyp = try std.fs.path.join(allocator, &.{ package_dir, "binding.gyp" });
        if (std.Io.Dir.cwd().access(io, binding_gyp, .{})) |_| {
            result.commands[1] = "node-gyp rebuild";
            result.total += 1;
        } else |_| {}
    }
    return result;
}

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
        const concurrency = @max(1, (std.Thread.getCpuCount() catch 2) * 2);
        var offset: usize = 0;
        while (offset < queue.tasks.items.len) {
            const end = @min(offset + concurrency, queue.tasks.items.len);
            const tasks = queue.tasks.items[offset..end];
            const states = try queue.allocator.alloc(RunState, tasks.len);
            defer queue.allocator.free(states);

            for (states, tasks) |*state, task| {
                state.* = .{
                    .process_init = process_init,
                    .root_dir = root_dir,
                    .task = task,
                    .diagnostics = .init(process_init.gpa),
                };
            }
            defer for (states) |*state| state.diagnostics.deinit();

            var group: std.Io.Group = .init;
            defer group.cancel(process_init.io);
            for (states) |*state| {
                try group.concurrent(process_init.io, RunState.run, .{state});
            }
            try group.await(process_init.io);

            for (states) |*state| {
                try stderr.writeAll(state.diagnostics.written());
                if (state.failure) |err| {
                    if (!state.task.optional) return err;
                }
            }
            offset = end;
        }
    }
};

const RunState = struct {
    process_init: std.process.Init,
    root_dir: []const u8,
    task: Task,
    diagnostics: std.Io.Writer.Allocating,
    failure: ?anyerror = null,

    fn run(state: *RunState) std.Io.Cancelable!void {
        runPackage(
            state.process_init,
            state.root_dir,
            state.task,
            &state.diagnostics.writer,
        ) catch |err| {
            state.failure = err;
        };
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

pub fn rootHasLifecycleScripts(root: *const Value) bool {
    const scripts = if (root.* == .object) root.object.get("scripts") orelse return false else return false;
    if (scripts != .object) return false;
    for ([_][]const u8{ "preinstall", "install", "postinstall", "preprepare", "prepare", "postprepare" }) |stage| {
        const command = scripts.object.get(stage) orelse continue;
        if (command == .string and command.string.len > 0) return true;
    }
    return false;
}

pub fn runNamedStage(
    init: std.process.Init,
    root_dir: []const u8,
    manifest: *const Value,
    stage: []const u8,
    stderr: *std.Io.Writer,
) !void {
    const scripts = if (manifest.* == .object) manifest.object.get("scripts") orelse return else return;
    if (scripts != .object) return;
    const task: Task = .{
        .name = jsonString(manifest, "name") orelse "root",
        .version = jsonString(manifest, "version") orelse "0.0.0",
        .cwd = root_dir,
        .kind = .git,
        .optional = false,
    };
    try runStage(init, root_dir, task, &scripts, stage, stderr, .version);
}

pub fn runPackStage(
    init: std.process.Init,
    root_dir: []const u8,
    manifest: *const Value,
    stage: []const u8,
    quiet: bool,
    stderr: *std.Io.Writer,
) !void {
    const scripts = if (manifest.* == .object) manifest.object.get("scripts") orelse return else return;
    if (scripts != .object) return;
    const value = scripts.object.get(stage) orelse return;
    if (value != .string or value.string.len == 0) return;

    const task: Task = .{
        .name = jsonString(manifest, "name") orelse "root",
        .version = jsonString(manifest, "version") orelse "0.0.0",
        .cwd = root_dir,
        .kind = .git,
        .optional = false,
    };
    const allocator = init.arena.allocator();
    var environment = try init.environ_map.clone(allocator);
    defer environment.deinit();
    try configureEnvironment(&environment, allocator, init.io, root_dir, task, stage, value.string);
    try environment.put("npm_command", "pack");

    const command = try replaceBunCommand(allocator, init.io, value.string);
    if (!quiet) {
        try stderr.print("$ {s}\n", .{value.string});
        try stderr.flush();
    }
    const shell_args: []const []const u8 = if (builtin.os.tag == .windows)
        &.{ "cmd.exe", "/d", "/s", "/c", command }
    else
        &.{ "/bin/sh", "-c", command };
    var child = try std.process.spawn(init.io, .{
        .argv = shell_args,
        .cwd = .{ .path = root_dir },
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
    try stderr.print("error: script \"{s}\" exited with code {d}\n", .{ stage, exit_code });
    try stderr.flush();
    return error.LifecycleScriptFailed;
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
    const scripts = try inspectLifecycleScripts(init.io, init.arena.allocator(), task.cwd, manifest, task.kind);
    for (lifecycle_stage_names, scripts.commands) |stage, maybe_command| {
        const command = maybe_command orelse continue;
        try runStageCommand(init, root_dir, task, stage, command, stderr, .install);
    }
}

const StageDiagnostic = enum { install, version };

fn runStage(
    init: std.process.Init,
    root_dir: []const u8,
    task: Task,
    scripts: *const Value,
    stage: []const u8,
    stderr: *std.Io.Writer,
    diagnostic: StageDiagnostic,
) !void {
    const value = scripts.object.get(stage) orelse return;
    if (value != .string or value.string.len == 0) return;

    try runStageCommand(init, root_dir, task, stage, value.string, stderr, diagnostic);
}

fn runStageCommand(
    init: std.process.Init,
    root_dir: []const u8,
    task: Task,
    stage: []const u8,
    script: []const u8,
    stderr: *std.Io.Writer,
    diagnostic: StageDiagnostic,
) !void {
    const allocator = init.arena.allocator();
    var environment = try init.environ_map.clone(allocator);
    defer environment.deinit();
    try configureEnvironment(&environment, allocator, init.io, root_dir, task, stage, script);

    const command = try replaceBunCommand(allocator, init.io, script);
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

    switch (diagnostic) {
        .install => try stderr.print("error: {s} script from \"{s}\" exited with {d}\n", .{ stage, task.name, exit_code }),
        .version => try stderr.print("error: script \"{s}\" exited with code {d}\n", .{ stage, exit_code }),
    }
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

test "lifecycle inspection applies Bun's binding.gyp fallback" {
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.writeFile(io, .{ .sub_path = "binding.gyp", .data = "{}" });

    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    const manifest = try std.json.parseFromSliceLeaky(Value, allocator,
        \\{"scripts":{"postinstall":"node post.js","prepare":"node prepare.js"}}
    , .{});
    const package_dir = try tmp.dir.realPathFileAlloc(io, ".", allocator);
    const scripts = try inspectLifecycleScripts(io, allocator, package_dir, &manifest, .npm);

    try std.testing.expectEqual(@as(usize, 2), scripts.total);
    try std.testing.expectEqualStrings("node-gyp rebuild", scripts.commands[1].?);
    try std.testing.expectEqualStrings("node post.js", scripts.commands[2].?);
    try std.testing.expect(scripts.commands[4] == null);
}
