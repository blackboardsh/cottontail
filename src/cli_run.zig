const std = @import("std");
const builtin = @import("builtin");
const Lockfile = @import("package_manager_lockfile.zig");
const script_command = @import("cli_script_command.zig");

const Allocator = std.mem.Allocator;

const RunMode = enum {
    parallel,
    sequential,
    workspace,
};

const Invocation = struct {
    mode: RunMode,
    filters: []const []const u8,
    scripts: []const []const u8,
    script_args: []const []const u8,
    workspaces: bool,
    if_present: bool,
    no_exit_on_error: bool,
    elide_lines: ?usize,
};

const ConfigEntry = struct {
    name: []const u8,
    value: []const u8,
};

const Package = struct {
    dir: []const u8,
    relative_dir: []const u8,
    name: []const u8,
    version: []const u8,
    package_json: []const u8,
    scripts: ?std.json.ObjectMap,
    dependencies: []const []const u8,
    config: []const ConfigEntry,

    fn label(self: Package) []const u8 {
        return if (self.name.len > 0) self.name else self.relative_dir;
    }
};

const Stage = struct {
    name: []const u8,
    command: []const u8,
    original_command: []const u8,
};

const GroupResult = struct {
    code: u8 = 0,
    signaled: bool = false,
    aborted: bool = false,
    internal_error: bool = false,
};

const Group = struct {
    label: []const u8,
    package_label: []const u8,
    script_name: []const u8,
    cwd: []const u8,
    init_cwd: []const u8,
    package_name: []const u8,
    package_version: []const u8,
    package_json: []const u8,
    stages: []const Stage,
    config: []const ConfigEntry,
    package_index: usize = 0,
    color_index: usize = 0,
    result: GroupResult = .{},
    output_lines: std.atomic.Value(usize) = .init(0),
};

const OutputMode = enum { multi, workspace };
const Stream = enum { stdout, stderr };

const SharedOutput = struct {
    io: std.Io,
    mode: OutputMode,
    max_label_len: usize,
    color: bool,
    elide_lines: ?usize,
    stdout_mutex: std.Io.Mutex = .init,
    stderr_mutex: std.Io.Mutex = .init,

    const colors = [_][]const u8{
        "\x1b[36m",
        "\x1b[35m",
        "\x1b[33m",
        "\x1b[32m",
        "\x1b[34m",
        "\x1b[31m",
    };

    fn fileFor(stream: Stream) std.Io.File {
        return switch (stream) {
            .stdout => std.Io.File.stdout(),
            .stderr => std.Io.File.stderr(),
        };
    }

    fn mutexFor(self: *SharedOutput, stream: Stream) *std.Io.Mutex {
        return switch (stream) {
            .stdout => &self.stdout_mutex,
            .stderr => &self.stderr_mutex,
        };
    }

    fn writePrefix(self: *SharedOutput, file: std.Io.File, group: *const Group) !void {
        if (self.mode == .workspace) {
            try file.writeStreamingAll(self.io, group.package_label);
            try file.writeStreamingAll(self.io, " ");
            try file.writeStreamingAll(self.io, group.script_name);
            try file.writeStreamingAll(self.io, ": ");
            return;
        }

        if (self.color) {
            try file.writeStreamingAll(self.io, colors[group.color_index % colors.len]);
            try file.writeStreamingAll(self.io, group.label);
            try file.writeStreamingAll(self.io, "\x1b[0m");
        } else {
            try file.writeStreamingAll(self.io, group.label);
        }
        if (self.max_label_len > group.label.len) {
            const spaces = "                                                                                ";
            var remaining = self.max_label_len - group.label.len;
            while (remaining > 0) {
                const count = @min(remaining, spaces.len);
                try file.writeStreamingAll(self.io, spaces[0..count]);
                remaining -= count;
            }
        }
        try file.writeStreamingAll(self.io, " | ");
    }

    fn line(self: *SharedOutput, stream: Stream, group: *Group, content: []const u8) void {
        const mutex = self.mutexFor(stream);
        mutex.lockUncancelable(self.io);
        defer mutex.unlock(self.io);
        const file = fileFor(stream);
        self.writePrefix(file, group) catch return;
        file.writeStreamingAll(self.io, content) catch return;
        file.writeStreamingAll(self.io, "\n") catch return;
        _ = group.output_lines.fetchAdd(1, .monotonic);
    }

    fn status(self: *SharedOutput, group: *Group, result: GroupResult, elapsed_ms: u64) void {
        const stream: Stream = if (self.mode == .multi) .stderr else .stdout;
        const mutex = self.mutexFor(stream);
        mutex.lockUncancelable(self.io);
        defer mutex.unlock(self.io);
        const file = fileFor(stream);
        self.writePrefix(file, group) catch return;
        if (self.mode == .workspace) {
            if (result.signaled) {
                file.writeStreamingAll(self.io, "Signaled\n") catch return;
            } else {
                var buffer: [64]u8 = undefined;
                const text = std.fmt.bufPrint(&buffer, "Exited with code {d}\n", .{result.code}) catch return;
                file.writeStreamingAll(self.io, text) catch return;
            }
            if (self.elide_lines) |limit| {
                const line_count = group.output_lines.load(.monotonic);
                if (limit > 0 and line_count > limit) {
                    self.writePrefix(file, group) catch return;
                    var buffer: [64]u8 = undefined;
                    const text = std.fmt.bufPrint(&buffer, "[{d} lines elided]\n", .{line_count - limit}) catch return;
                    file.writeStreamingAll(self.io, text) catch return;
                }
            }
            return;
        }

        if (result.signaled) {
            file.writeStreamingAll(self.io, "Signaled\n") catch return;
        } else if (result.code != 0) {
            var buffer: [64]u8 = undefined;
            const text = std.fmt.bufPrint(&buffer, "Exited with code {d}\n", .{result.code}) catch return;
            file.writeStreamingAll(self.io, text) catch return;
        } else {
            var buffer: [64]u8 = undefined;
            const text = std.fmt.bufPrint(&buffer, "Done in {d}ms\n", .{elapsed_ms}) catch return;
            file.writeStreamingAll(self.io, text) catch return;
        }
    }

    fn diagnostic(self: *SharedOutput, comptime fmt: []const u8, values: anytype) void {
        self.stderr_mutex.lockUncancelable(self.io);
        defer self.stderr_mutex.unlock(self.io);
        var buffer: [2048]u8 = undefined;
        const text = std.fmt.bufPrint(&buffer, fmt, values) catch return;
        std.Io.File.stderr().writeStreamingAll(self.io, text) catch {};
    }
};

const Coordinator = struct {
    abort_requested: std.atomic.Value(bool) = .init(false),
    no_exit_on_error: bool,
};

const StreamContext = struct {
    io: std.Io,
    file: std.Io.File,
    output: *SharedOutput,
    group: *Group,
    stream: Stream,

    fn run(self: *StreamContext) void {
        defer self.file.close(self.io);
        const allocator = std.heap.c_allocator;
        var pending: std.ArrayList(u8) = .empty;
        defer pending.deinit(allocator);
        var read_buffer: [16 * 1024]u8 = undefined;

        while (true) {
            const count = self.file.readStreaming(self.io, &.{read_buffer[0..]}) catch |err| switch (err) {
                error.EndOfStream => break,
                else => break,
            };
            if (count == 0) continue;

            var start: usize = 0;
            for (read_buffer[0..count], 0..) |byte, index| {
                if (byte != '\n') continue;
                pending.appendSlice(allocator, read_buffer[start..index]) catch return;
                self.output.line(self.stream, self.group, pending.items);
                pending.clearRetainingCapacity();
                start = index + 1;
            }
            pending.appendSlice(allocator, read_buffer[start..count]) catch return;
        }

        if (pending.items.len > 0) self.output.line(self.stream, self.group, pending.items);
    }
};

const StageResult = struct {
    code: u8,
    signaled: bool = false,
    aborted: bool = false,
};

fn termFromStatus(status: u32) std.process.Child.Term {
    return if (std.posix.W.IFEXITED(status))
        .{ .exited = std.posix.W.EXITSTATUS(status) }
    else if (std.posix.W.IFSIGNALED(status))
        .{ .signal = std.posix.W.TERMSIG(status) }
    else if (std.posix.W.IFSTOPPED(status))
        .{ .stopped = std.posix.W.STOPSIG(status) }
    else
        .{ .unknown = status };
}

fn pollPosixChild(child: *std.process.Child) !?std.process.Child.Term {
    var status: if (builtin.link_libc) c_int else u32 = undefined;
    while (true) {
        const rc = std.posix.system.wait4(child.id.?, &status, @intCast(std.posix.W.NOHANG), null);
        switch (std.posix.errno(rc)) {
            .SUCCESS => {
                if (rc == 0) return null;
                child.id = null;
                return termFromStatus(@bitCast(status));
            },
            .INTR => continue,
            else => |err| return std.posix.unexpectedErrno(err),
        }
    }
}

fn terminateProcessGroup(child: *std.process.Child) void {
    if (comptime builtin.os.tag == .windows) {
        return;
    } else {
        const pid = child.id orelse return;
        std.posix.kill(-pid, .KILL) catch std.posix.kill(pid, .KILL) catch {};
    }
}

fn termResult(term: std.process.Child.Term, aborted: bool) StageResult {
    return switch (term) {
        .exited => |code| .{ .code = code, .aborted = aborted },
        .signal => .{ .code = 1, .signaled = true, .aborted = aborted },
        .stopped, .unknown => .{ .code = 1, .signaled = true, .aborted = aborted },
    };
}

fn configureEnvironment(
    init: std.process.Init,
    group: *const Group,
    stage: Stage,
) !std.process.Environ.Map {
    const allocator = std.heap.c_allocator;
    var env = try init.environ_map.clone(allocator);
    errdefer env.deinit();

    const executable = try std.process.executablePathAlloc(init.io, allocator);
    defer allocator.free(executable);
    try env.put("BUN", executable);
    try env.put("npm_execpath", executable);
    try env.put("npm_node_execpath", executable);
    try env.put("npm_lifecycle_event", stage.name);
    try env.put("npm_lifecycle_script", stage.original_command);
    try env.put("npm_command", "run-script");
    try env.put("INIT_CWD", group.init_cwd);
    try env.put("npm_config_local_prefix", group.init_cwd);
    try env.put("npm_config_user_agent", "bun/1.3.10 npm/? node/? cottontail");
    if (group.package_name.len > 0) try env.put("npm_package_name", group.package_name);
    if (group.package_version.len > 0) try env.put("npm_package_version", group.package_version);
    if (group.package_json.len > 0) try env.put("npm_package_json", group.package_json);
    for (group.config) |entry| try env.put(entry.name, entry.value);

    var path_parts: std.ArrayList([]const u8) = .empty;
    defer path_parts.deinit(allocator);
    var owned_parts: std.ArrayList([]u8) = .empty;
    defer {
        for (owned_parts.items) |part| allocator.free(part);
        owned_parts.deinit(allocator);
    }
    var current = group.cwd;
    while (true) {
        const part = try std.fs.path.join(allocator, &.{ current, "node_modules", ".bin" });
        try owned_parts.append(allocator, part);
        try path_parts.append(allocator, part);
        const parent = std.fs.path.dirname(current) orelse break;
        if (std.mem.eql(u8, parent, current)) break;
        current = parent;
    }
    if (env.get("PATH")) |old_path| try path_parts.append(allocator, old_path);
    const separator = if (builtin.os.tag == .windows) ";" else ":";
    const path = try std.mem.join(allocator, separator, path_parts.items);
    defer allocator.free(path);
    try env.put("PATH", path);
    return env;
}

fn runStage(
    init: std.process.Init,
    coordinator: *Coordinator,
    output: *SharedOutput,
    group: *Group,
    stage: Stage,
) !StageResult {
    var env = try configureEnvironment(init, group, stage);
    defer env.deinit();

    const argv: []const []const u8 = if (builtin.os.tag == .windows)
        &.{ "cmd.exe", "/d", "/s", "/c", stage.command }
    else
        &.{ "/bin/sh", "-c", stage.command };
    var child = try std.process.spawn(init.io, .{
        .argv = argv,
        .cwd = .{ .path = group.cwd },
        .environ_map = &env,
        .stdin = .ignore,
        .stdout = .pipe,
        .stderr = .pipe,
        .pgid = if (builtin.os.tag == .windows) null else 0,
        .create_no_window = true,
    });

    var stdout_context = StreamContext{
        .io = init.io,
        .file = child.stdout.?,
        .output = output,
        .group = group,
        .stream = if (output.mode == .workspace) .stdout else .stdout,
    };
    child.stdout = null;
    var stderr_context = StreamContext{
        .io = init.io,
        .file = child.stderr.?,
        .output = output,
        .group = group,
        .stream = if (output.mode == .workspace) .stdout else .stderr,
    };
    child.stderr = null;

    const stdout_thread = try std.Thread.spawn(.{}, StreamContext.run, .{&stdout_context});
    const stderr_thread = std.Thread.spawn(.{}, StreamContext.run, .{&stderr_context}) catch |err| {
        terminateProcessGroup(&child);
        child.kill(init.io);
        stdout_thread.join();
        return err;
    };
    defer stdout_thread.join();
    defer stderr_thread.join();

    var was_aborted = false;
    const term: std.process.Child.Term = if (comptime builtin.os.tag == .windows)
        try child.wait(init.io)
    else wait: {
        while (true) {
            if (try pollPosixChild(&child)) |value| break :wait value;
            if (!was_aborted and coordinator.abort_requested.load(.acquire)) {
                was_aborted = true;
                terminateProcessGroup(&child);
            }
            std.Io.sleep(init.io, .fromMilliseconds(5), .awake) catch {};
        }
    };

    const result = termResult(term, was_aborted);
    if ((result.code != 0 or result.signaled) and !coordinator.no_exit_on_error) {
        // Publish failure before the deferred pipe-reader joins. A descendant
        // can keep a copied pipe descriptor open after the shell exits; sibling
        // groups must still be cancelled while this worker drains its streams.
        coordinator.abort_requested.store(true, .release);
    }
    return result;
}

const WorkerContext = struct {
    init: std.process.Init,
    coordinator: *Coordinator,
    output: *SharedOutput,
    group: *Group,

    fn run(self: *WorkerContext) void {
        self.runFallible() catch |err| {
            self.group.result = .{ .code = 1, .internal_error = true };
            self.output.diagnostic("error: Failed to run \"{s}\": {s}\n", .{ self.group.label, @errorName(err) });
            if (!self.coordinator.no_exit_on_error) self.coordinator.abort_requested.store(true, .release);
        };
    }

    fn runFallible(self: *WorkerContext) !void {
        const started = std.Io.Clock.awake.now(self.init.io).nanoseconds;
        var final = StageResult{ .code = 0 };
        for (self.group.stages) |stage| {
            if (self.coordinator.abort_requested.load(.acquire) and !self.coordinator.no_exit_on_error) {
                self.group.result.aborted = true;
                return;
            }
            final = try runStage(self.init, self.coordinator, self.output, self.group, stage);
            if (final.aborted) {
                self.group.result = .{ .code = final.code, .signaled = final.signaled, .aborted = true };
                return;
            }
            if (final.code != 0 or final.signaled) break;
        }

        self.group.result = .{ .code = final.code, .signaled = final.signaled };
        if ((final.code != 0 or final.signaled) and !self.coordinator.no_exit_on_error) {
            self.coordinator.abort_requested.store(true, .release);
        }
        const finished = std.Io.Clock.awake.now(self.init.io).nanoseconds;
        const elapsed_ns = if (finished > started) finished - started else 0;
        self.output.status(self.group, self.group.result, @intCast(@divTrunc(elapsed_ns, std.time.ns_per_ms)));
    }
};

fn executeGroups(
    init: std.process.Init,
    groups: []const *Group,
    mode: RunMode,
    no_exit_on_error: bool,
    output: *SharedOutput,
) !u8 {
    if (groups.len == 0) return 0;
    var coordinator = Coordinator{ .no_exit_on_error = no_exit_on_error };
    const allocator = init.arena.allocator();
    const contexts = try allocator.alloc(WorkerContext, groups.len);

    if (mode == .sequential) {
        for (groups, 0..) |group, index| {
            contexts[index] = .{ .init = init, .coordinator = &coordinator, .output = output, .group = group };
            contexts[index].run();
            if (group.result.code != 0 and !no_exit_on_error) break;
        }
    } else {
        const threads = try allocator.alloc(std.Thread, groups.len);
        var started: usize = 0;
        errdefer for (threads[0..started]) |thread| thread.join();
        for (groups, 0..) |group, index| {
            contexts[index] = .{ .init = init, .coordinator = &coordinator, .output = output, .group = group };
            threads[index] = try std.Thread.spawn(.{}, WorkerContext.run, .{&contexts[index]});
            started += 1;
        }
        for (threads) |thread| thread.join();
    }

    for (groups) |group| {
        if (!group.result.aborted and group.result.code != 0) return group.result.code;
    }
    for (groups) |group| {
        if (group.result.code != 0) return group.result.code;
    }
    return 0;
}

fn parseUnsigned(value: []const u8) ?usize {
    return std.fmt.parseUnsigned(usize, value, 10) catch null;
}

fn parseInvocation(allocator: Allocator, io: std.Io, args: []const [:0]const u8) !?Invocation {
    if (args.len < 2) return null;
    const explicit_run = std.mem.eql(u8, args[1], "run");
    var index: usize = if (explicit_run) 2 else 1;
    var parallel = false;
    var sequential = false;
    var workspaces = false;
    var if_present = false;
    var no_exit_on_error = false;
    var elide_lines: ?usize = null;
    var triggered = false;
    var filters = std.array_list.Managed([]const u8).init(allocator);

    while (index < args.len) {
        const arg = args[index];
        if (std.mem.eql(u8, arg, "--")) {
            index += 1;
            break;
        }
        if (std.mem.eql(u8, arg, "--parallel")) {
            parallel = true;
            triggered = true;
            index += 1;
            continue;
        }
        if (std.mem.eql(u8, arg, "--sequential")) {
            sequential = true;
            triggered = true;
            index += 1;
            continue;
        }
        if (std.mem.eql(u8, arg, "--workspaces")) {
            workspaces = true;
            triggered = true;
            index += 1;
            continue;
        }
        if (std.mem.eql(u8, arg, "--no-exit-on-error")) {
            no_exit_on_error = true;
            index += 1;
            continue;
        }
        if (std.mem.eql(u8, arg, "--if-present")) {
            if_present = true;
            index += 1;
            continue;
        }
        if (std.mem.eql(u8, arg, "--silent")) {
            index += 1;
            continue;
        }
        if ((std.mem.eql(u8, arg, "--filter") or std.mem.eql(u8, arg, "-F")) and index + 1 < args.len) {
            try filters.append(args[index + 1]);
            triggered = true;
            index += 2;
            continue;
        }
        if (std.mem.startsWith(u8, arg, "--filter=")) {
            try filters.append(arg["--filter=".len..]);
            triggered = true;
            index += 1;
            continue;
        }
        if (std.mem.startsWith(u8, arg, "-F=")) {
            try filters.append(arg["-F=".len..]);
            triggered = true;
            index += 1;
            continue;
        }
        if (std.mem.eql(u8, arg, "--elide-lines") and index + 1 < args.len) {
            elide_lines = parseUnsigned(args[index + 1]);
            index += 2;
            continue;
        }
        if (std.mem.startsWith(u8, arg, "--elide-lines=")) {
            elide_lines = parseUnsigned(arg["--elide-lines=".len..]);
            index += 1;
            continue;
        }
        if (std.mem.eql(u8, arg, "--cwd") and index + 1 < args.len) {
            try std.process.setCurrentPath(io, args[index + 1]);
            index += 2;
            continue;
        }
        if (std.mem.startsWith(u8, arg, "--cwd=")) {
            try std.process.setCurrentPath(io, arg["--cwd=".len..]);
            index += 1;
            continue;
        }
        if (std.mem.eql(u8, arg, "--shell") and index + 1 < args.len) {
            index += 2;
            continue;
        }
        if (std.mem.startsWith(u8, arg, "--shell=")) {
            index += 1;
            continue;
        }
        if (!explicit_run and triggered and std.mem.eql(u8, arg, "run")) {
            index += 1;
            continue;
        }
        break;
    }

    if (!triggered) return null;
    const mode: RunMode = if (parallel) .parallel else if (sequential) .sequential else .workspace;
    const positionals = args[index..];
    const scripts = if (mode == .workspace and positionals.len > 0) positionals[0..1] else positionals;
    const script_args = if (mode == .workspace and positionals.len > 0) positionals[1..] else &.{};
    return .{
        .mode = mode,
        .filters = try filters.toOwnedSlice(),
        .scripts = scripts,
        .script_args = script_args,
        .workspaces = workspaces,
        .if_present = if_present,
        .no_exit_on_error = no_exit_on_error,
        .elide_lines = elide_lines,
    };
}

fn normalizeSlashes(bytes: []u8) void {
    if (std.fs.path.sep == '/') return;
    for (bytes) |*byte| if (byte.* == std.fs.path.sep) {
        byte.* = '/';
    };
}

fn globMatches(pattern: []const u8, value: []const u8) bool {
    return globMatchesAt(pattern, 0, value, 0);
}

fn globMatchesAt(pattern: []const u8, pattern_index: usize, value: []const u8, value_index: usize) bool {
    var pi = pattern_index;
    var vi = value_index;
    while (pi < pattern.len) {
        if (pattern[pi] == '*') {
            const recursive = pi + 1 < pattern.len and pattern[pi + 1] == '*';
            while (pi < pattern.len and pattern[pi] == '*') pi += 1;
            if (pi == pattern.len) {
                return recursive or std.mem.indexOfScalar(u8, value[vi..], '/') == null;
            }
            var candidate = vi;
            while (candidate <= value.len) : (candidate += 1) {
                if (!recursive and candidate > vi and value[candidate - 1] == '/') break;
                if (globMatchesAt(pattern, pi, value, candidate)) return true;
            }
            return false;
        }
        if (vi >= value.len) return false;
        if (pattern[pi] == '?') {
            if (value[vi] == '/') return false;
            pi += 1;
            vi += 1;
            continue;
        }
        if (pattern[pi] != value[vi]) return false;
        pi += 1;
        vi += 1;
    }
    return vi == value.len;
}

fn hasGlob(value: []const u8) bool {
    return std.mem.findAny(u8, value, "*?[") != null;
}

fn readPackage(
    io: std.Io,
    allocator: Allocator,
    dir: []const u8,
    relative_dir: []const u8,
    warn_on_error: bool,
) !?Package {
    const package_json = try std.fs.path.join(allocator, &.{ dir, "package.json" });
    const source = std.Io.Dir.cwd().readFileAlloc(io, package_json, allocator, .limited(16 * 1024 * 1024)) catch return null;
    const normalized = Lockfile.normalizeJsonc(allocator, source) catch {
        if (warn_on_error) std.Io.File.stderr().writeStreamingAll(io, "warning: Failed to read package.json\n") catch {};
        return null;
    };
    const parsed = std.json.parseFromSliceLeaky(std.json.Value, allocator, normalized, .{
        .duplicate_field_behavior = .use_last,
    }) catch {
        if (warn_on_error) std.Io.File.stderr().writeStreamingAll(io, "warning: Failed to read package.json\n") catch {};
        return null;
    };
    if (parsed != .object) return null;
    const root = parsed.object;
    const name = if (root.get("name")) |value| if (value == .string) value.string else "" else "";
    const version = if (root.get("version")) |value| if (value == .string) value.string else "" else "";
    const scripts = if (root.get("scripts")) |value| if (value == .object) value.object else null else null;

    var dependencies = std.array_list.Managed([]const u8).init(allocator);
    for ([_][]const u8{ "dependencies", "devDependencies", "optionalDependencies" }) |field| {
        if (root.get(field)) |value| {
            if (value == .object) try dependencies.appendSlice(value.object.keys());
        }
    }

    var config = std.array_list.Managed(ConfigEntry).init(allocator);
    if (root.get("config")) |value| {
        if (value == .object) {
            for (value.object.keys(), value.object.values()) |key, item| {
                const config_value = switch (item) {
                    .string => |text| text,
                    .bool => |flag| if (flag) "true" else "false",
                    .integer => |number| try std.fmt.allocPrint(allocator, "{d}", .{number}),
                    .float => |number| try std.fmt.allocPrint(allocator, "{d}", .{number}),
                    .null => "",
                    else => try std.json.Stringify.valueAlloc(allocator, item, .{}),
                };
                try config.append(.{
                    .name = try std.fmt.allocPrint(allocator, "npm_package_config_{s}", .{key}),
                    .value = config_value,
                });
            }
        }
    }

    return .{
        .dir = dir,
        .relative_dir = relative_dir,
        .name = name,
        .version = version,
        .package_json = package_json,
        .scripts = scripts,
        .dependencies = try dependencies.toOwnedSlice(),
        .config = try config.toOwnedSlice(),
    };
}

const WorkspaceRoot = struct {
    dir: []const u8,
    patterns: []const []const u8,
    configured: bool,
};

fn workspacePatterns(allocator: Allocator, root: std.json.ObjectMap) !?[]const []const u8 {
    const workspaces = root.get("workspaces") orelse return null;
    const array = switch (workspaces) {
        .array => |value| value,
        .object => |object| blk: {
            const packages = object.get("packages") orelse return null;
            if (packages != .array) return null;
            break :blk packages.array;
        },
        else => return null,
    };
    var patterns = std.array_list.Managed([]const u8).init(allocator);
    for (array.items) |item| {
        if (item == .string) try patterns.append(item.string);
    }
    return try patterns.toOwnedSlice();
}

fn findWorkspaceRoot(io: std.Io, allocator: Allocator, cwd: []const u8) !WorkspaceRoot {
    var current = cwd;
    while (true) {
        const path = try std.fs.path.join(allocator, &.{ current, "package.json" });
        if (std.Io.Dir.cwd().readFileAlloc(io, path, allocator, .limited(16 * 1024 * 1024)) catch null) |source| {
            if (Lockfile.normalizeJsonc(allocator, source) catch null) |normalized| {
                if (std.json.parseFromSliceLeaky(std.json.Value, allocator, normalized, .{
                    .duplicate_field_behavior = .use_last,
                }) catch null) |parsed| {
                    if (parsed == .object) {
                        if (try workspacePatterns(allocator, parsed.object)) |patterns| {
                            return .{ .dir = current, .patterns = patterns, .configured = true };
                        }
                    }
                }
            }
        }
        const parent = std.fs.path.dirname(current) orelse break;
        if (std.mem.eql(u8, parent, current)) break;
        current = parent;
    }
    return .{ .dir = cwd, .patterns = &.{}, .configured = false };
}

fn pathMatchesWorkspacePatterns(patterns: []const []const u8, relative_dir: []const u8) bool {
    for (patterns) |pattern| {
        var trimmed = pattern;
        while (std.mem.startsWith(u8, trimmed, "./")) trimmed = trimmed[2..];
        while (trimmed.len > 0 and trimmed[trimmed.len - 1] == '/') trimmed = trimmed[0 .. trimmed.len - 1];
        if (globMatches(trimmed, relative_dir)) return true;
    }
    return false;
}

fn discoverPackages(init: std.process.Init, root: WorkspaceRoot) ![]Package {
    const allocator = init.arena.allocator();
    var directory = try std.Io.Dir.openDirAbsolute(init.io, root.dir, .{ .iterate = true });
    defer directory.close(init.io);
    var walker = try directory.walk(allocator);
    defer walker.deinit();
    var packages = std.array_list.Managed(Package).init(allocator);

    while (try walker.next(init.io)) |entry| {
        if (entry.kind == .directory) {
            if ((entry.basename.len > 0 and entry.basename[0] == '.') or std.mem.eql(u8, entry.basename, "node_modules")) {
                walker.leave(init.io);
            }
            continue;
        }
        if (entry.kind != .file or !std.mem.eql(u8, entry.basename, "package.json")) continue;
        const dirname = std.fs.path.dirname(entry.path) orelse "";
        if (dirname.len == 0) continue;
        const relative = try allocator.dupe(u8, dirname);
        normalizeSlashes(relative);
        if (root.configured and !pathMatchesWorkspacePatterns(root.patterns, relative)) continue;
        const dir = try std.fs.path.join(allocator, &.{ root.dir, dirname });
        if (try readPackage(init.io, allocator, dir, relative, true)) |package| try packages.append(package);
    }

    std.mem.sort(Package, packages.items, {}, struct {
        fn lessThan(_: void, lhs: Package, rhs: Package) bool {
            const label_order = std.mem.order(u8, lhs.label(), rhs.label());
            if (label_order != .eq) return label_order == .lt;
            return std.mem.order(u8, lhs.relative_dir, rhs.relative_dir) == .lt;
        }
    }.lessThan);
    return try packages.toOwnedSlice();
}

fn filterMatches(allocator: Allocator, cwd: []const u8, filters: []const []const u8, package: Package) !bool {
    if (filters.len == 0) return true;
    for (filters) |filter| {
        if (std.mem.eql(u8, filter, "*") or std.mem.eql(u8, filter, "**")) {
            if (package.name.len > 0) return true;
            continue;
        }
        if (std.mem.startsWith(u8, filter, ".")) {
            const absolute = try std.fs.path.resolve(allocator, &.{ cwd, filter });
            const normalized = try allocator.dupe(u8, absolute);
            normalizeSlashes(normalized);
            const package_dir = try allocator.dupe(u8, package.dir);
            normalizeSlashes(package_dir);
            if (globMatches(normalized, package_dir)) return true;
        } else if (globMatches(filter, package.name)) {
            return true;
        }
    }
    return false;
}

fn scriptValue(package: Package, name: []const u8) ?[]const u8 {
    const scripts = package.scripts orelse return null;
    const value = scripts.get(name) orelse return null;
    return if (value == .string) value.string else null;
}

fn shellEscape(allocator: Allocator, value: []const u8) ![]const u8 {
    var plain = value.len > 0;
    for (value) |byte| {
        if (!(std.ascii.isAlphanumeric(byte) or switch (byte) {
            '-', '_', '.', '/', ':', '=', '@', '%', '+', ',' => true,
            else => false,
        })) {
            plain = false;
            break;
        }
    }
    if (plain) return value;
    var result = std.array_list.Managed(u8).init(allocator);
    try result.append('\'');
    for (value) |byte| {
        if (byte == '\'') try result.appendSlice("'\\''") else try result.append(byte);
    }
    try result.append('\'');
    return result.items;
}

fn appendScriptStage(
    stages: *std.array_list.Managed(Stage),
    allocator: Allocator,
    io: std.Io,
    name: []const u8,
    command: []const u8,
) !void {
    try stages.append(.{
        .name = name,
        .command = try script_command.replacePackageManagerRun(allocator, io, command),
        .original_command = command,
    });
}

fn stagesForScript(
    allocator: Allocator,
    io: std.Io,
    package: Package,
    name: []const u8,
    script_args: []const []const u8,
) ![]const Stage {
    const main = scriptValue(package, name) orelse return &.{};
    var stages = std.array_list.Managed(Stage).init(allocator);
    const pre_name = try std.mem.concat(allocator, u8, &.{ "pre", name });
    const post_name = try std.mem.concat(allocator, u8, &.{ "post", name });
    if (scriptValue(package, pre_name)) |command| try appendScriptStage(&stages, allocator, io, pre_name, command);
    try appendScriptStage(&stages, allocator, io, name, main);
    if (script_args.len > 0) {
        var command = std.array_list.Managed(u8).init(allocator);
        try command.appendSlice(stages.items[stages.items.len - 1].command);
        for (script_args) |arg| {
            try command.append(' ');
            try command.appendSlice(try shellEscape(allocator, arg));
        }
        stages.items[stages.items.len - 1].command = command.items;
    }
    if (scriptValue(package, post_name)) |command| try appendScriptStage(&stages, allocator, io, post_name, command);
    return try stages.toOwnedSlice();
}

fn appendPackageGroup(
    init: std.process.Init,
    groups: *std.array_list.Managed(Group),
    package: Package,
    package_index: usize,
    script_name: []const u8,
    script_args: []const []const u8,
    workspace_label: bool,
    init_cwd: []const u8,
) !void {
    const allocator = init.arena.allocator();
    const stages = try stagesForScript(allocator, init.io, package, script_name, script_args);
    if (stages.len == 0) return;
    const label = if (workspace_label)
        try std.mem.concat(allocator, u8, &.{ package.label(), ":", script_name })
    else
        script_name;
    try groups.append(.{
        .label = label,
        .package_label = package.label(),
        .script_name = script_name,
        .cwd = package.dir,
        .init_cwd = init_cwd,
        .package_name = package.name,
        .package_version = package.version,
        .package_json = package.package_json,
        .stages = stages,
        .config = package.config,
        .package_index = package_index,
    });
}

fn matchingScriptNames(allocator: Allocator, package: Package, pattern: []const u8) ![]const []const u8 {
    const scripts = package.scripts orelse return &.{};
    var names = std.array_list.Managed([]const u8).init(allocator);
    for (scripts.keys(), scripts.values()) |name, value| {
        if (value == .string and globMatches(pattern, name)) try names.append(name);
    }
    std.mem.sort([]const u8, names.items, {}, struct {
        fn lessThan(_: void, lhs: []const u8, rhs: []const u8) bool {
            return std.mem.order(u8, lhs, rhs) == .lt;
        }
    }.lessThan);
    return try names.toOwnedSlice();
}

fn nearestPackage(init: std.process.Init, cwd: []const u8) !Package {
    const allocator = init.arena.allocator();
    var current = cwd;
    while (true) {
        if (try readPackage(init.io, allocator, current, "", false)) |package| return package;
        const parent = std.fs.path.dirname(current) orelse break;
        if (std.mem.eql(u8, parent, current)) break;
        current = parent;
    }
    return .{
        .dir = cwd,
        .relative_dir = "",
        .name = "",
        .version = "",
        .package_json = "",
        .scripts = null,
        .dependencies = &.{},
        .config = &.{},
    };
}

fn runnableFile(io: std.Io, path: []const u8) bool {
    const extension = std.fs.path.extension(path);
    const supported = [_][]const u8{ ".js", ".jsx", ".ts", ".tsx", ".mjs", ".mts", ".cjs", ".cts", ".sh" };
    var valid = false;
    for (supported) |candidate| if (std.mem.eql(u8, extension, candidate)) {
        valid = true;
        break;
    };
    if (!valid) return false;
    const stat = std.Io.Dir.cwd().statFile(io, path, .{}) catch return false;
    return stat.kind == .file;
}

fn appendRawGroup(init: std.process.Init, groups: *std.array_list.Managed(Group), cwd: []const u8, request: []const u8) !void {
    const allocator = init.arena.allocator();
    var command = request;
    if (runnableFile(init.io, request)) {
        const executable = try std.process.executablePathAlloc(init.io, allocator);
        command = try std.mem.concat(allocator, u8, &.{
            try shellEscape(allocator, executable),
            " run ",
            try shellEscape(allocator, request),
        });
    }
    const stages = try allocator.alloc(Stage, 1);
    stages[0] = .{ .name = request, .command = command, .original_command = request };
    try groups.append(.{
        .label = request,
        .package_label = request,
        .script_name = request,
        .cwd = cwd,
        .init_cwd = cwd,
        .package_name = "",
        .package_version = "",
        .package_json = "",
        .stages = stages,
        .config = &.{},
    });
}

fn configureOutput(init: std.process.Init, groups: []Group, mode: OutputMode, elide_lines: ?usize) SharedOutput {
    var max_label_len: usize = 0;
    for (groups) |group| max_label_len = @max(max_label_len, group.label.len);
    const force_color = if (init.environ_map.get("FORCE_COLOR")) |value| value.len > 0 and !std.mem.eql(u8, value, "0") else false;
    const no_color = if (init.environ_map.get("NO_COLOR")) |value| value.len == 0 or !std.mem.eql(u8, value, "0") else false;
    return .{
        .io = init.io,
        .mode = mode,
        .max_label_len = max_label_len,
        .color = force_color and !no_color,
        .elide_lines = elide_lines,
    };
}

fn runRootMulti(init: std.process.Init, invocation: Invocation, cwd: []const u8) !u8 {
    const allocator = init.arena.allocator();
    const package = try nearestPackage(init, cwd);
    var groups = std.array_list.Managed(Group).init(allocator);

    for (invocation.scripts) |request| {
        if (hasGlob(request)) {
            const matches = try matchingScriptNames(allocator, package, request);
            if (matches.len == 0) {
                var buffer: [1024]u8 = undefined;
                const message = try std.fmt.bufPrint(&buffer, "error: No scripts match pattern \"{s}\"\n", .{request});
                try std.Io.File.stderr().writeStreamingAll(init.io, message);
                return 1;
            }
            for (matches) |name| try appendPackageGroup(init, &groups, package, 0, name, invocation.script_args, false, cwd);
        } else if (scriptValue(package, request) != null) {
            try appendPackageGroup(init, &groups, package, 0, request, invocation.script_args, false, cwd);
        } else {
            try appendRawGroup(init, &groups, cwd, request);
        }
    }

    for (groups.items, 0..) |*group, index| group.color_index = index;
    var output = configureOutput(init, groups.items, .multi, null);
    const pointers = try allocator.alloc(*Group, groups.items.len);
    for (groups.items, 0..) |*group, index| pointers[index] = group;
    return try executeGroups(init, pointers, invocation.mode, invocation.no_exit_on_error, &output);
}

fn packageDependsOnSelected(package: Package, selected: []const Package, processed: []const bool) bool {
    for (package.dependencies) |dependency| {
        for (selected, 0..) |candidate, index| {
            if (!processed[index] and std.mem.eql(u8, dependency, candidate.name)) return true;
        }
    }
    return false;
}

fn runWorkspaceGroups(
    init: std.process.Init,
    invocation: Invocation,
    selected: []const Package,
    groups: []Group,
) !u8 {
    const allocator = init.arena.allocator();
    for (groups, 0..) |*group, index| group.color_index = index;
    var output = configureOutput(init, groups, if (invocation.mode == .workspace) .workspace else .multi, invocation.elide_lines);

    if (invocation.mode != .workspace) {
        const pointers = try allocator.alloc(*Group, groups.len);
        for (groups, 0..) |*group, index| pointers[index] = group;
        return try executeGroups(init, pointers, invocation.mode, invocation.no_exit_on_error, &output);
    }

    const processed = try allocator.alloc(bool, selected.len);
    @memset(processed, false);
    var remaining = selected.len;
    var first_failure: u8 = 0;
    while (remaining > 0) {
        var wave_packages = std.array_list.Managed(usize).init(allocator);
        for (selected, 0..) |package, index| {
            if (processed[index]) continue;
            if (!packageDependsOnSelected(package, selected, processed)) try wave_packages.append(index);
        }
        if (wave_packages.items.len == 0) {
            for (processed, 0..) |done, index| if (!done) try wave_packages.append(index);
        }

        var wave_groups = std.array_list.Managed(*Group).init(allocator);
        for (groups) |*group| {
            for (wave_packages.items) |package_index| {
                if (group.package_index == package_index) {
                    try wave_groups.append(group);
                    break;
                }
            }
        }
        const code = try executeGroups(init, wave_groups.items, .parallel, true, &output);
        if (first_failure == 0 and code != 0) first_failure = code;
        for (wave_packages.items) |package_index| {
            processed[package_index] = true;
            remaining -= 1;
        }
    }
    return first_failure;
}

fn runWorkspaces(init: std.process.Init, invocation: Invocation, cwd: []const u8) !u8 {
    const allocator = init.arena.allocator();
    const root = try findWorkspaceRoot(init.io, allocator, cwd);
    const discovered = try discoverPackages(init, root);
    var selected_list = std.array_list.Managed(Package).init(allocator);
    for (discovered) |package| {
        if (invocation.workspaces or try filterMatches(allocator, cwd, invocation.filters, package)) {
            try selected_list.append(package);
        }
    }
    const selected = try selected_list.toOwnedSlice();
    var groups = std.array_list.Managed(Group).init(allocator);
    var missing_workspace_script: ?[]const u8 = null;

    for (selected, 0..) |package, package_index| {
        for (invocation.scripts) |request| {
            if (hasGlob(request)) {
                const matches = try matchingScriptNames(allocator, package, request);
                if (matches.len == 0 and invocation.workspaces and !invocation.if_present) missing_workspace_script = request;
                for (matches) |name| try appendPackageGroup(init, &groups, package, package_index, name, invocation.script_args, true, cwd);
            } else if (scriptValue(package, request) != null) {
                try appendPackageGroup(init, &groups, package, package_index, request, invocation.script_args, true, cwd);
            } else if (invocation.workspaces and !invocation.if_present) {
                missing_workspace_script = request;
            }
        }
    }

    if (missing_workspace_script) |name| {
        var buffer: [1024]u8 = undefined;
        const message = if (groups.items.len == 0)
            try std.fmt.bufPrint(&buffer, "error: No workspace packages have script \"{s}\"\n", .{name})
        else
            try std.fmt.bufPrint(&buffer, "error: Missing \"{s}\" script in a workspace package\n", .{name});
        try std.Io.File.stderr().writeStreamingAll(init.io, message);
        return 1;
    }
    if (groups.items.len == 0) {
        if (invocation.if_present) return 0;
        const message = if (invocation.workspaces)
            "error: No workspace packages have script\n"
        else
            "error: No packages matched the filter\n";
        try std.Io.File.stderr().writeStreamingAll(init.io, message);
        return 1;
    }
    return try runWorkspaceGroups(init, invocation, selected, groups.items);
}

pub fn tryRun(init: std.process.Init, args: []const [:0]const u8) !?u8 {
    const invocation = (try parseInvocation(init.arena.allocator(), init.io, args)) orelse return null;
    if (invocation.mode == .parallel and invocation.scripts.len == 0 or
        invocation.mode == .sequential and invocation.scripts.len == 0)
    {
        try std.Io.File.stderr().writeStreamingAll(init.io, "error: --parallel/--sequential requires at least one script name\n");
        return 1;
    }
    var saw_parallel = false;
    var saw_sequential = false;
    for (args) |arg| {
        saw_parallel = saw_parallel or std.mem.eql(u8, arg, "--parallel");
        saw_sequential = saw_sequential or std.mem.eql(u8, arg, "--sequential");
    }
    if (saw_parallel and saw_sequential) {
        try std.Io.File.stderr().writeStreamingAll(init.io, "error: --parallel and --sequential cannot be used together\n");
        return 1;
    }

    const cwd = try std.Io.Dir.cwd().realPathFileAlloc(init.io, ".", init.arena.allocator());
    if (invocation.workspaces or invocation.filters.len > 0) {
        return try runWorkspaces(init, invocation, cwd);
    }
    return try runRootMulti(init, invocation, cwd);
}
