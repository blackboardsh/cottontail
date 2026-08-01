const std = @import("std");
const windows = std.os.windows;

const generic_read: windows.DWORD = 0x80000000;
const generic_write: windows.DWORD = 0x40000000;
const file_share_read: windows.DWORD = 0x00000001;
const file_share_write: windows.DWORD = 0x00000002;
const console_textmode_buffer: windows.DWORD = 1;
const std_output_handle: windows.DWORD = 0xfffffff5;
const std_error_handle: windows.DWORD = 0xfffffff4;
const legacy_code_page: windows.DWORD = 437;

const SmallRect = extern struct {
    left: i16,
    top: i16,
    right: i16,
    bottom: i16,
};

const ConsoleScreenBufferInfo = extern struct {
    size: windows.COORD,
    cursor_position: windows.COORD,
    attributes: windows.WORD,
    window: SmallRect,
    maximum_window_size: windows.COORD,
};

extern "kernel32" fn AllocConsole() callconv(.winapi) windows.BOOL;
extern "kernel32" fn FreeConsole() callconv(.winapi) windows.BOOL;
extern "kernel32" fn CreateConsoleScreenBuffer(
    desired_access: windows.DWORD,
    share_mode: windows.DWORD,
    security_attributes: ?*const windows.SECURITY_ATTRIBUTES,
    flags: windows.DWORD,
    screen_buffer_data: ?*anyopaque,
) callconv(.winapi) windows.HANDLE;
extern "kernel32" fn GetConsoleOutputCP() callconv(.winapi) windows.DWORD;
extern "kernel32" fn SetConsoleOutputCP(code_page: windows.DWORD) callconv(.winapi) windows.BOOL;
extern "kernel32" fn GetStdHandle(std_handle: windows.DWORD) callconv(.winapi) windows.HANDLE;
extern "kernel32" fn SetStdHandle(std_handle: windows.DWORD, handle: windows.HANDLE) callconv(.winapi) windows.BOOL;
extern "kernel32" fn GetConsoleScreenBufferInfo(
    console_output: windows.HANDLE,
    info: *ConsoleScreenBufferInfo,
) callconv(.winapi) windows.BOOL;
extern "kernel32" fn ReadConsoleOutputCharacterW(
    console_output: windows.HANDLE,
    characters: [*]windows.WCHAR,
    length: windows.DWORD,
    read_coordinate: windows.COORD,
    characters_read: *windows.DWORD,
) callconv(.winapi) windows.BOOL;

const ConsoleCapture = struct {
    stdout_handle: windows.HANDLE,
    stderr_handle: windows.HANDLE,
    previous_stdout_handle: windows.HANDLE,
    previous_stderr_handle: windows.HANDLE,
    previous_code_page: windows.DWORD,
    allocated_console: bool,

    fn init() !ConsoleCapture {
        var allocated_console = false;
        var stdout_handle = createScreenBuffer();
        if (stdout_handle == windows.INVALID_HANDLE_VALUE) {
            if (!AllocConsole().toBool()) return error.ConsoleAllocationFailed;
            allocated_console = true;
            stdout_handle = createScreenBuffer();
        }
        if (stdout_handle == windows.INVALID_HANDLE_VALUE) {
            if (allocated_console) _ = FreeConsole();
            return error.ConsoleScreenBufferCreationFailed;
        }
        errdefer {
            if (allocated_console) _ = FreeConsole();
        }
        errdefer windows.CloseHandle(stdout_handle);

        const stderr_handle = createScreenBuffer();
        if (stderr_handle == windows.INVALID_HANDLE_VALUE) {
            return error.ConsoleScreenBufferCreationFailed;
        }
        errdefer windows.CloseHandle(stderr_handle);

        const previous_stdout_handle = GetStdHandle(std_output_handle);
        const previous_stderr_handle = GetStdHandle(std_error_handle);
        const previous_code_page = GetConsoleOutputCP();

        if (!SetConsoleOutputCP(legacy_code_page).toBool()) return error.SetConsoleCodePageFailed;
        errdefer {
            if (previous_code_page != 0) _ = SetConsoleOutputCP(previous_code_page);
        }

        if (!SetStdHandle(std_output_handle, stdout_handle).toBool()) {
            return error.SetStdHandleFailed;
        }
        errdefer _ = SetStdHandle(std_output_handle, previous_stdout_handle);

        if (!SetStdHandle(std_error_handle, stderr_handle).toBool()) {
            return error.SetStdHandleFailed;
        }

        return .{
            .stdout_handle = stdout_handle,
            .stderr_handle = stderr_handle,
            .previous_stdout_handle = previous_stdout_handle,
            .previous_stderr_handle = previous_stderr_handle,
            .previous_code_page = previous_code_page,
            .allocated_console = allocated_console,
        };
    }

    fn deinit(capture: *ConsoleCapture) void {
        _ = SetStdHandle(std_output_handle, capture.previous_stdout_handle);
        _ = SetStdHandle(std_error_handle, capture.previous_stderr_handle);
        if (capture.previous_code_page != 0) _ = SetConsoleOutputCP(capture.previous_code_page);
        windows.CloseHandle(capture.stdout_handle);
        windows.CloseHandle(capture.stderr_handle);
        if (capture.allocated_console) _ = FreeConsole();
        capture.* = undefined;
    }
};

fn createScreenBuffer() windows.HANDLE {
    var security_attributes: windows.SECURITY_ATTRIBUTES = .{
        .nLength = @sizeOf(windows.SECURITY_ATTRIBUTES),
        .lpSecurityDescriptor = null,
        .bInheritHandle = .TRUE,
    };
    return CreateConsoleScreenBuffer(
        generic_read | generic_write,
        file_share_read | file_share_write,
        &security_attributes,
        console_textmode_buffer,
        null,
    );
}

fn readScreenBuffer(handle: windows.HANDLE, buffer: []windows.WCHAR) !usize {
    var info: ConsoleScreenBufferInfo = undefined;
    if (!GetConsoleScreenBufferInfo(handle, &info).toBool()) {
        return error.ConsoleScreenBufferReadFailed;
    }

    const width: usize = @intCast(info.size.X);
    const height: usize = @intCast(info.size.Y);
    const requested: windows.DWORD = @intCast(@min(buffer.len, width * height));
    var read: windows.DWORD = 0;
    if (!ReadConsoleOutputCharacterW(handle, buffer.ptr, requested, .{ .X = 0, .Y = 0 }, &read).toBool()) {
        return error.ConsoleScreenBufferReadFailed;
    }
    return @intCast(read);
}

fn containsSequence(haystack: []const windows.WCHAR, needle: []const windows.WCHAR) bool {
    if (needle.len > haystack.len) return false;
    for (0..haystack.len - needle.len + 1) |start| {
        if (std.mem.eql(windows.WCHAR, haystack[start..][0..needle.len], needle)) return true;
    }
    return false;
}

fn writeFailure(io: std.Io, comptime format: []const u8, args: anytype) void {
    var stderr_buffer: [2048]u8 = undefined;
    var stderr_writer = std.Io.File.stderr().writer(io, &stderr_buffer);
    const stderr = &stderr_writer.interface;
    stderr.print(format, args) catch {};
    stderr.flush() catch {};
}

pub fn main(init: std.process.Init) !void {
    const allocator = init.arena.allocator();
    const args = try init.minimal.args.toSlice(allocator);
    if (args.len != 2) {
        writeFailure(init.io, "usage: {s} <cottontail-executable>\n", .{args[0]});
        return error.InvalidArguments;
    }

    const temp_root = init.environ_map.get("TEMP") orelse init.environ_map.get("TMP") orelse {
        return error.TempDirectoryNotFound;
    };
    const script_name = try std.fmt.allocPrint(allocator, "cottontail-unicode-console-{d}.js", .{windows.GetCurrentProcessId()});
    const script_path = try std.fs.path.join(allocator, &.{ temp_root, script_name });
    try std.Io.Dir.cwd().writeFile(init.io, .{
        .sub_path = script_path,
        .data =
        \\console.log("\u2713", "stdout");
        \\console.error("\u2713", "stderr");
        ,
    });
    defer std.Io.Dir.deleteFileAbsolute(init.io, script_path) catch {};

    var capture = try ConsoleCapture.init();
    var capture_active = true;
    defer if (capture_active) capture.deinit();

    var child = try std.process.spawn(init.io, .{
        .argv = &.{ args[1], script_path },
        .stdin = .inherit,
        .stdout = .inherit,
        .stderr = .inherit,
    });
    defer child.kill(init.io);

    const term = try child.wait(init.io);
    var stdout_buffer: [4096]windows.WCHAR = undefined;
    var stderr_buffer: [4096]windows.WCHAR = undefined;
    const stdout_length = try readScreenBuffer(capture.stdout_handle, &stdout_buffer);
    const stderr_length = try readScreenBuffer(capture.stderr_handle, &stderr_buffer);

    capture.deinit();
    capture_active = false;

    const exit_code = switch (term) {
        .exited => |code| code,
        else => {
            writeFailure(init.io, "Cottontail terminated unexpectedly: {s}\n", .{@tagName(term)});
            return error.UnexpectedChildTermination;
        },
    };
    if (exit_code != 0) {
        writeFailure(init.io, "Cottontail exited with code {d}\n", .{exit_code});
        return error.UnexpectedChildExitCode;
    }

    const expected_stdout = [_]windows.WCHAR{ 0x2713, ' ', 's', 't', 'd', 'o', 'u', 't' };
    const expected_stderr = [_]windows.WCHAR{ 0x2713, ' ', 's', 't', 'd', 'e', 'r', 'r' };
    const mojibake = [_]windows.WCHAR{ 0x0393, 0x00a3, 0x00f4 };
    const stdout = stdout_buffer[0..stdout_length];
    const stderr = stderr_buffer[0..stderr_length];
    if (!containsSequence(stdout, &expected_stdout) or !containsSequence(stderr, &expected_stderr)) {
        writeFailure(init.io, "Cottontail did not write Unicode console output through the wide Windows API\n", .{});
        return error.UnicodeConsoleOutputMissing;
    }
    if (containsSequence(stdout, &mojibake) or containsSequence(stderr, &mojibake)) {
        writeFailure(init.io, "Cottontail console output was decoded through code page 437\n", .{});
        return error.UnicodeConsoleOutputMojibake;
    }
}
