const std = @import("std");
const c = @cImport({
    @cInclude("stdlib.h");
});

pub const CtHostEnvEntry = extern struct {
    name: [*:0]const u8,
    value: [*:0]const u8,
};

pub const CtHostSpawnOptions = extern struct {
    cwd: ?[*:0]const u8,
    env_entries: ?[*]const CtHostEnvEntry,
    env_count: usize,
    capture_output: bool,
};

pub const CtHostSpawnResult = extern struct {
    exit_code: c_int,
    stdout_ptr: ?[*]u8,
    stdout_len: usize,
    stderr_ptr: ?[*]u8,
    stderr_len: usize,
};

var host_io: ?std.Io = null;

pub fn configure(io: std.Io) void {
    host_io = io;
}

pub fn forceLink() void {
    _ = &ct_host_string_free;
    _ = &ct_host_buffer_free;
    _ = &ct_host_exists;
    _ = &ct_host_mkdir;
    _ = &ct_host_rm;
    _ = &ct_host_unlink;
    _ = &ct_host_chmod;
    _ = &ct_host_spawn_sync;
}

fn getIo() std.Io {
    return host_io orelse @panic("cottontail host IO is not configured");
}

fn setErrorOut(error_out: *?[*:0]u8, message: []const u8) void {
    error_out.* = allocCString(message);
}

fn allocCString(bytes: []const u8) ?[*:0]u8 {
    const raw = c.malloc(bytes.len + 1) orelse return null;
    const ptr: [*]u8 = @ptrCast(raw);

    @memcpy(ptr[0..bytes.len], bytes);
    ptr[bytes.len] = 0;
    return @ptrCast(ptr);
}

fn allocBuffer(bytes: []const u8) ?[*]u8 {
    const raw = c.malloc(bytes.len + 1) orelse return null;
    const ptr: [*]u8 = @ptrCast(raw);

    @memcpy(ptr[0..bytes.len], bytes);
    ptr[bytes.len] = 0;
    return ptr;
}

fn termToExitCode(term: std.process.Child.Term) c_int {
    return switch (term) {
        .exited => |code| @as(c_int, code),
        .signal => |signal| 128 + @as(c_int, @intCast(@intFromEnum(signal))),
        .stopped => 1,
        .unknown => 1,
    };
}

fn cwdOption(path: ?[*:0]const u8) std.process.Child.Cwd {
    return if (path) |cwd_path|
        .{ .path = std.mem.span(cwd_path) }
    else
        .inherit;
}

export fn ct_host_string_free(value: ?[*:0]u8) void {
    if (value) |ptr| {
        c.free(@ptrCast(ptr));
    }
}

export fn ct_host_buffer_free(value: ?[*]u8) void {
    if (value) |ptr| {
        c.free(@ptrCast(ptr));
    }
}

export fn ct_host_exists(path: [*:0]const u8) bool {
    std.Io.Dir.cwd().access(getIo(), std.mem.span(path), .{}) catch return false;
    return true;
}

export fn ct_host_mkdir(path: [*:0]const u8, recursive: bool, error_out: *?[*:0]u8) c_int {
    error_out.* = null;

    const cwd = std.Io.Dir.cwd();
    const sub_path = std.mem.span(path);

    if (recursive) {
        cwd.createDirPath(getIo(), sub_path) catch |err| {
            setErrorOut(error_out, @errorName(err));
            return -1;
        };
    } else {
        cwd.createDir(getIo(), sub_path, .default_dir) catch |err| {
            setErrorOut(error_out, @errorName(err));
            return -1;
        };
    }

    return 0;
}

export fn ct_host_rm(
    path: [*:0]const u8,
    recursive: bool,
    force: bool,
    error_out: *?[*:0]u8,
) c_int {
    error_out.* = null;

    const cwd = std.Io.Dir.cwd();
    const sub_path = std.mem.span(path);

    if (force and !ct_host_exists(path)) {
        return 0;
    }

    if (recursive) {
        cwd.deleteTree(getIo(), sub_path) catch |err| {
            setErrorOut(error_out, @errorName(err));
            return -1;
        };
    } else {
        cwd.deleteFile(getIo(), sub_path) catch |err| {
            setErrorOut(error_out, @errorName(err));
            return -1;
        };
    }

    return 0;
}

export fn ct_host_unlink(path: [*:0]const u8, error_out: *?[*:0]u8) c_int {
    error_out.* = null;

    std.Io.Dir.cwd().deleteFile(getIo(), std.mem.span(path)) catch |err| {
        setErrorOut(error_out, @errorName(err));
        return -1;
    };

    return 0;
}

export fn ct_host_chmod(path: [*:0]const u8, mode: c_uint, error_out: *?[*:0]u8) c_int {
    error_out.* = null;

    const permissions = if (@hasDecl(std.Io.File.Permissions, "fromMode"))
        std.Io.File.Permissions.fromMode(@intCast(mode))
    else
        std.Io.File.Permissions.default_file;

    std.Io.Dir.cwd().setFilePermissions(getIo(), std.mem.span(path), permissions, .{}) catch |err| {
        setErrorOut(error_out, @errorName(err));
        return -1;
    };

    return 0;
}

export fn ct_host_spawn_sync(
    file: [*:0]const u8,
    args_ptr: ?[*]const [*:0]const u8,
    arg_count: usize,
    options: CtHostSpawnOptions,
    result_out: *CtHostSpawnResult,
    error_out: *?[*:0]u8,
) c_int {
    error_out.* = null;
    result_out.* = .{
        .exit_code = 0,
        .stdout_ptr = null,
        .stdout_len = 0,
        .stderr_ptr = null,
        .stderr_len = 0,
    };

    const gpa = std.heap.c_allocator;
    const io = getIo();

    var argv: std.ArrayList([]const u8) = .empty;
    defer argv.deinit(gpa);

    argv.append(gpa, std.mem.span(file)) catch {
        setErrorOut(error_out, "OutOfMemory");
        return -1;
    };

    if (args_ptr) |ptr| {
        for (0..arg_count) |index| {
            argv.append(gpa, std.mem.span(ptr[index])) catch {
                setErrorOut(error_out, "OutOfMemory");
                return -1;
            };
        }
    }

    var env_map: ?std.process.Environ.Map = null;
    defer if (env_map) |*map| map.deinit();

    if (options.env_entries != null and options.env_count > 0) {
        var map = std.process.Environ.Map.init(gpa);
        errdefer map.deinit();

        const env_entries = options.env_entries.?;
        for (0..options.env_count) |index| {
            map.put(std.mem.span(env_entries[index].name), std.mem.span(env_entries[index].value)) catch {
                setErrorOut(error_out, "OutOfMemory");
                return -1;
            };
        }

        env_map = map;
    }

    const env_map_ptr = if (env_map) |*map| map else null;
    const child_cwd = cwdOption(options.cwd);

    if (options.capture_output) {
        const run_result = std.process.run(gpa, io, .{
            .argv = argv.items,
            .cwd = child_cwd,
            .environ_map = env_map_ptr,
            .create_no_window = true,
        }) catch |err| {
            setErrorOut(error_out, @errorName(err));
            return -1;
        };
        defer gpa.free(run_result.stdout);
        defer gpa.free(run_result.stderr);

        result_out.exit_code = termToExitCode(run_result.term);

        result_out.stdout_ptr = allocBuffer(run_result.stdout) orelse {
            setErrorOut(error_out, "OutOfMemory");
            return -1;
        };
        result_out.stdout_len = run_result.stdout.len;

        result_out.stderr_ptr = allocBuffer(run_result.stderr) orelse {
            if (result_out.stdout_ptr) |stdout_ptr| ct_host_buffer_free(stdout_ptr);
            result_out.stdout_ptr = null;
            result_out.stdout_len = 0;
            setErrorOut(error_out, "OutOfMemory");
            return -1;
        };
        result_out.stderr_len = run_result.stderr.len;
    } else {
        var child = std.process.spawn(io, .{
            .argv = argv.items,
            .cwd = child_cwd,
            .environ_map = env_map_ptr,
            .stdin = .inherit,
            .stdout = .inherit,
            .stderr = .inherit,
            .create_no_window = true,
        }) catch |err| {
            setErrorOut(error_out, @errorName(err));
            return -1;
        };
        defer child.kill(io);

        const term = child.wait(io) catch |err| {
            setErrorOut(error_out, @errorName(err));
            return -1;
        };

        result_out.exit_code = termToExitCode(term);
    }

    return 0;
}
