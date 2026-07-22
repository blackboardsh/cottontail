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
    auto_node_gyp_only: bool = false,
    print_commands: bool = false,
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
            .auto_node_gyp_only = task.auto_node_gyp_only,
            .print_commands = task.print_commands,
        });
    }

    pub fn run(
        queue: *Queue,
        process_init: std.process.Init,
        root_dir: []const u8,
        max_concurrent_scripts: ?usize,
        stderr: *std.Io.Writer,
    ) !void {
        if (queue.tasks.items.len == 0) return;
        const node_gyp = try NodeGypWrapper.create(process_init);
        defer node_gyp.deinit(process_init.io);
        const concurrency = max_concurrent_scripts orelse @max(1, (std.Thread.getCpuCount() catch 2) * 2);
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
                    .node_gyp_dir = node_gyp.directory,
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
    node_gyp_dir: []const u8,
    diagnostics: std.Io.Writer.Allocating,
    failure: ?anyerror = null,

    fn run(state: *RunState) std.Io.Cancelable!void {
        runPackage(
            state.process_init,
            state.root_dir,
            state.task,
            state.node_gyp_dir,
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
    quiet: bool,
    stderr: *std.Io.Writer,
) !void {
    if (!rootHasLifecycleScripts(init.io, root_dir, root)) return;
    const node_gyp = try NodeGypWrapper.create(init);
    defer node_gyp.deinit(init.io);
    if (!quiet) try stderr.writeByte('\n');
    try runManifestScripts(init, root_dir, .{
        .name = jsonString(root, "name") orelse "root",
        .version = jsonString(root, "version") orelse "0.0.0",
        .cwd = root_dir,
        .kind = .git,
        .optional = false,
        .print_commands = !quiet,
    }, root, node_gyp.directory, stderr);
}

pub fn rootHasLifecycleScripts(io: std.Io, root_dir: []const u8, root: *const Value) bool {
    const scripts = manifestScripts(root);
    if (scripts) |value| {
        for ([_][]const u8{ "preinstall", "install", "postinstall", "preprepare", "prepare", "postprepare" }) |stage| {
            if (hasScript(value, stage)) return true;
        }
    }
    return shouldAutoRebuild(io, root_dir, scripts);
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
    const node_gyp = try NodeGypWrapper.create(init);
    defer node_gyp.deinit(init.io);
    const task: Task = .{
        .name = jsonString(manifest, "name") orelse "root",
        .version = jsonString(manifest, "version") orelse "0.0.0",
        .cwd = root_dir,
        .kind = .git,
        .optional = false,
    };
    try runStage(init, root_dir, task, &scripts, stage, node_gyp.directory, stderr, .version);
}

pub fn runPackStage(
    init: std.process.Init,
    root_dir: []const u8,
    manifest: *const Value,
    stage: []const u8,
    quiet: bool,
    stderr: *std.Io.Writer,
) !void {
    return runLifecycleStage(init, root_dir, manifest, stage, "pack", quiet, stderr);
}

pub fn runPublishStage(
    init: std.process.Init,
    root_dir: []const u8,
    manifest: *const Value,
    stage: []const u8,
    quiet: bool,
    stderr: *std.Io.Writer,
) !void {
    return runLifecycleStage(init, root_dir, manifest, stage, "publish", quiet, stderr);
}

fn runLifecycleStage(
    init: std.process.Init,
    root_dir: []const u8,
    manifest: *const Value,
    stage: []const u8,
    npm_command: []const u8,
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
    const node_gyp = try NodeGypWrapper.create(init);
    defer node_gyp.deinit(init.io);
    const allocator = init.arena.allocator();
    var environment = try init.environ_map.clone(allocator);
    defer environment.deinit();
    try configureEnvironment(&environment, allocator, init.io, root_dir, task, stage, value.string, node_gyp.directory);
    try environment.put("npm_command", npm_command);

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

fn runPackage(
    init: std.process.Init,
    root_dir: []const u8,
    task: Task,
    node_gyp_dir: []const u8,
    stderr: *std.Io.Writer,
) !void {
    const package_json_path = try std.fs.path.join(init.arena.allocator(), &.{ task.cwd, "package.json" });
    const source = std.Io.Dir.cwd().readFileAlloc(
        init.io,
        package_json_path,
        init.arena.allocator(),
        .limited(16 * 1024 * 1024),
    ) catch return;
    const manifest = std.json.parseFromSliceLeaky(Value, init.arena.allocator(), source, .{}) catch return;
    if (manifest != .object) return;
    try runManifestScripts(init, root_dir, task, &manifest, node_gyp_dir, stderr);
}

fn runManifestScripts(
    init: std.process.Init,
    root_dir: []const u8,
    task: Task,
    manifest: *const Value,
    node_gyp_dir: []const u8,
    stderr: *std.Io.Writer,
) !void {
    const scripts = try inspectLifecycleScripts(init.io, init.arena.allocator(), task.cwd, manifest, task.kind);
    if (task.auto_node_gyp_only) {
        const command = scripts.commands[1] orelse return;
        if (!std.mem.eql(u8, command, "node-gyp rebuild")) return;
        return runCommandStage(init, root_dir, task, "install", command, node_gyp_dir, stderr, .install);
    }
    for (lifecycle_stage_names, scripts.commands) |stage, maybe_command| {
        const command = maybe_command orelse continue;
        try runCommandStage(init, root_dir, task, stage, command, node_gyp_dir, stderr, .install);
    }
}

const StageDiagnostic = enum { install, version };

const CapturedOutput = struct {
    io: std.Io,
    file: std.Io.File,
    bytes: std.ArrayList(u8) = .empty,
    failure: ?anyerror = null,

    fn deinit(output: *CapturedOutput) void {
        output.bytes.deinit(std.heap.c_allocator);
    }

    fn read(output: *CapturedOutput) void {
        defer output.file.close(output.io);
        var buffer: [16 * 1024]u8 = undefined;
        while (true) {
            const count = output.file.readStreaming(output.io, &.{buffer[0..]}) catch |err| switch (err) {
                error.EndOfStream => break,
                else => {
                    output.failure = err;
                    break;
                },
            };
            if (count == 0) continue;
            output.bytes.appendSlice(std.heap.c_allocator, buffer[0..count]) catch |err| {
                output.failure = err;
                break;
            };
        }
    }
};

fn runStage(
    init: std.process.Init,
    root_dir: []const u8,
    task: Task,
    scripts: *const Value,
    stage: []const u8,
    node_gyp_dir: []const u8,
    stderr: *std.Io.Writer,
    diagnostic: StageDiagnostic,
) !void {
    const value = scripts.object.get(stage) orelse return;
    if (value != .string or value.string.len == 0) return;
    return runCommandStage(init, root_dir, task, stage, value.string, node_gyp_dir, stderr, diagnostic);
}

fn runCommandStage(
    init: std.process.Init,
    root_dir: []const u8,
    task: Task,
    stage: []const u8,
    script: []const u8,
    node_gyp_dir: []const u8,
    stderr: *std.Io.Writer,
    diagnostic: StageDiagnostic,
) !void {
    if (task.print_commands) {
        try stderr.print("$ {s}\n", .{script});
        try stderr.flush();
    }
    const allocator = init.arena.allocator();
    var environment = try init.environ_map.clone(allocator);
    defer environment.deinit();
    try configureEnvironment(&environment, allocator, init.io, root_dir, task, stage, script, node_gyp_dir);

    const command = try replaceBunCommand(allocator, init.io, script);
    const shell_args: []const []const u8 = if (builtin.os.tag == .windows)
        &.{ "cmd.exe", "/d", "/s", "/c", command }
    else
        &.{ "/bin/sh", "-c", command };
    const foreground = std.mem.eql(u8, task.cwd, root_dir);
    var child = try std.process.spawn(init.io, .{
        .argv = shell_args,
        .cwd = .{ .path = task.cwd },
        .environ_map = &environment,
        .stdin = if (foreground) .inherit else .ignore,
        .stdout = if (foreground) .inherit else .pipe,
        .stderr = if (foreground) .inherit else .pipe,
        .create_no_window = true,
    });
    defer child.kill(init.io);
    const result = if (foreground)
        try child.wait(init.io)
    else result: {
        var captured_stdout: CapturedOutput = .{ .io = init.io, .file = child.stdout.? };
        defer captured_stdout.deinit();
        child.stdout = null;
        var captured_stderr: CapturedOutput = .{ .io = init.io, .file = child.stderr.? };
        defer captured_stderr.deinit();
        child.stderr = null;

        const stdout_thread = std.Thread.spawn(.{}, CapturedOutput.read, .{&captured_stdout}) catch |err| {
            captured_stdout.file.close(init.io);
            captured_stderr.file.close(init.io);
            child.kill(init.io);
            return err;
        };
        const stderr_thread = std.Thread.spawn(.{}, CapturedOutput.read, .{&captured_stderr}) catch |err| {
            captured_stderr.file.close(init.io);
            child.kill(init.io);
            stdout_thread.join();
            return err;
        };
        const term = child.wait(init.io) catch |err| {
            child.kill(init.io);
            stdout_thread.join();
            stderr_thread.join();
            return err;
        };
        stdout_thread.join();
        stderr_thread.join();
        if (captured_stdout.failure) |err| return err;
        if (captured_stderr.failure) |err| return err;

        const succeeded = switch (term) {
            .exited => |code| code == 0,
            else => false,
        };
        if (!succeeded) {
            if (!task.optional) {
                if (captured_stdout.bytes.items.len > 0) try stderr.print("{s}\n", .{captured_stdout.bytes.items});
                if (captured_stderr.bytes.items.len > 0) try stderr.print("{s}\n", .{captured_stderr.bytes.items});
            }
        }
        break :result term;
    };
    const exit_code: u8 = switch (result) {
        .exited => |code| @intCast(@min(code, 255)),
        else => 1,
    };
    if (exit_code == 0) return;

    if (task.optional) return error.LifecycleScriptFailed;

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
    node_gyp_dir: []const u8,
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
    if (node_gyp_dir.len > 0) {
        if (path.written().len > 0) try path.writer.writeByte(pathDelimiter());
        try path.writer.writeAll(node_gyp_dir);
        try environment.put("BUN_WHICH_IGNORE_CWD", node_gyp_dir);
    }
    try environment.put("PATH", path.written());
}

const NodeGypWrapper = struct {
    directory: []const u8,

    fn create(init: std.process.Init) !NodeGypWrapper {
        const allocator = init.arena.allocator();
        const base = temporaryDirectory(init.environ_map);
        std.Io.Dir.cwd().access(init.io, base, .{}) catch |err| switch (err) {
            error.FileNotFound => try std.Io.Dir.cwd().createDirPath(init.io, base),
            else => return err,
        };

        var directory: []const u8 = undefined;
        for (0..8) |_| {
            var random: [8]u8 = undefined;
            init.io.random(&random);
            const suffix = std.fmt.bytesToHex(random, .lower);
            const name = try std.fmt.allocPrint(allocator, "cottontail-node-gyp-{s}", .{&suffix});
            directory = try std.fs.path.join(allocator, &.{ base, name });
            std.Io.Dir.cwd().createDir(init.io, directory, .default_dir) catch |err| switch (err) {
                error.PathAlreadyExists => continue,
                else => return err,
            };
            break;
        } else return error.TempDirCollision;
        errdefer std.Io.Dir.cwd().deleteTree(init.io, directory) catch {};

        const filename = if (builtin.os.tag == .windows) "node-gyp.cmd" else "node-gyp";
        const wrapper_path = try std.fs.path.join(allocator, &.{ directory, filename });
        const contents = if (builtin.os.tag == .windows)
            "@if not defined npm_config_node_gyp (\r\n" ++
                "  @\"%BUN%\" x --silent node-gyp %*\r\n" ++
                ") else (\r\n" ++
                "  @\"%BUN%\" \"%npm_config_node_gyp%\" %*\r\n" ++
                ")\r\n"
        else
            "#!/bin/sh\n" ++
                "if [ \"x$npm_config_node_gyp\" = \"x\" ]; then\n" ++
                "  exec \"$BUN\" x --silent node-gyp \"$@\"\n" ++
                "else\n" ++
                "  exec \"$npm_config_node_gyp\" \"$@\"\n" ++
                "fi\n";
        try writeExecutable(init.io, wrapper_path, contents);

        const node_filename = if (builtin.os.tag == .windows) "node.cmd" else "node";
        const node_path = try std.fs.path.join(allocator, &.{ directory, node_filename });
        const node_contents = if (builtin.os.tag == .windows)
            "@\"%BUN%\" %*\r\n"
        else
            "#!/bin/sh\nexec \"$BUN\" \"$@\"\n";
        try writeExecutable(init.io, node_path, node_contents);
        return .{ .directory = directory };
    }

    fn deinit(wrapper: NodeGypWrapper, io: std.Io) void {
        std.Io.Dir.cwd().deleteTree(io, wrapper.directory) catch {};
    }
};

fn writeExecutable(io: std.Io, path: []const u8, contents: []const u8) !void {
    const permissions: std.Io.File.Permissions = if (builtin.os.tag == .windows) .default_file else .executable_file;
    var file = try std.Io.Dir.cwd().createFile(io, path, .{ .truncate = true, .permissions = permissions });
    defer file.close(io);
    try file.writeStreamingAll(io, contents);
}

fn temporaryDirectory(environment: *const std.process.Environ.Map) []const u8 {
    for ([_][]const u8{ "BUN_TMPDIR", "TMPDIR", "TEMP", "TMP" }) |name| {
        if (environment.get(name)) |value| {
            if (value.len > 0) return value;
        }
    }
    return if (builtin.os.tag == .windows) "." else "/tmp";
}

fn manifestScripts(manifest: *const Value) ?*const Value {
    if (manifest.* != .object) return null;
    const scripts = manifest.object.getPtr("scripts") orelse return null;
    return if (scripts.* == .object) scripts else null;
}

fn hasScript(scripts: *const Value, stage: []const u8) bool {
    const value = scripts.object.get(stage) orelse return false;
    return value == .string and value.string.len > 0;
}

fn shouldAutoRebuild(io: std.Io, cwd: []const u8, scripts: ?*const Value) bool {
    if (scripts) |value| {
        if (hasScript(value, "preinstall") or hasScript(value, "install")) return false;
    }
    var path_buffer: [std.fs.max_path_bytes]u8 = undefined;
    const binding_gyp = std.fmt.bufPrint(&path_buffer, "{s}{c}binding.gyp", .{ cwd, std.fs.path.sep }) catch return false;
    std.Io.Dir.cwd().access(io, binding_gyp, .{}) catch return false;
    return true;
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
    try std.testing.expect(scripts.automatic_node_gyp);
    try std.testing.expectEqualStrings("node-gyp rebuild", scripts.commands[1].?);
    try std.testing.expectEqualStrings("node post.js", scripts.commands[2].?);
    try std.testing.expect(scripts.commands[4] == null);

    const explicit_manifest = try std.json.parseFromSliceLeaky(Value, allocator,
        \\{"scripts":{"install":"node-gyp rebuild"}}
    , .{});
    const explicit_scripts = try inspectLifecycleScripts(io, allocator, package_dir, &explicit_manifest, .npm);
    try std.testing.expect(!explicit_scripts.automatic_node_gyp);
}
