const std = @import("std");

const max_payload_component_size = 512 * 1024 * 1024;
const max_exec_argv_size = 16 * 1024 * 1024;

const magic_v1 = "COTTONTAIL-STAND";
const magic_v2 = "COTTONTAIL-STAND2";
const magic_v3 = "COTTONTAIL-STAND3";
const magic_v4 = "COTTONTAIL-STAND4";
const magic_v5 = "COTTONTAIL-STAND5";

const trailer_v1_len = @sizeOf(u64) + magic_v1.len;
const trailer_v2_len = @sizeOf(u64) * 2 + magic_v2.len;
const trailer_v3_len = @sizeOf(u64) * 3 + magic_v3.len;
const trailer_v4_len = @sizeOf(u64) * 4 + @sizeOf(u32) + magic_v4.len;
const trailer_v5_len = @sizeOf(u64) * 5 + @sizeOf(u32) + magic_v5.len;

/// Runtime policy serialized into Bun 1.3.10 standalone module graphs. These
/// bits intentionally match Bun's flag order, while Cottontail owns its wire
/// format and stock-JSC consumers.
pub const Flags = packed struct(u32) {
    disable_default_env_files: bool = false,
    disable_autoload_bunfig: bool = false,
    disable_autoload_tsconfig: bool = false,
    disable_autoload_package_json: bool = false,
    _padding: u28 = 0,
};

pub const SourceMap = struct {
    path: []const u8,
    contents: []const u8,
};

pub const Source = struct {
    source: []const u8,
    source_map: ?[]const u8 = null,
    source_maps: []const SourceMap = &.{},
    files: ?[]const u8 = null,
    compile_exec_argv: []const u8 = "",
    flags: Flags = .{},
    bytecode: ?[]const u8 = null,
};

pub const Payload = struct {
    source: []const u8,
    source_map: ?[]const u8 = null,
    files: ?[]const u8 = null,
    compile_exec_argv: []const u8 = "",
    flags: Flags = .{},
    bytecode: ?[]const u8 = null,
};

fn readPayloadPart(
    init: std.process.Init,
    executable: std.Io.File,
    len: usize,
    offset: u64,
) ![]const u8 {
    const bytes = try init.arena.allocator().alloc(u8, len);
    if (try executable.readPositionalAll(init.io, bytes, offset) != bytes.len) {
        return error.InvalidStandaloneExecutable;
    }
    return bytes;
}

fn validPayloadLengths(trailer_offset: u64, lengths: []const usize) bool {
    var total: usize = 0;
    for (lengths) |len| {
        if (len > max_payload_component_size or len > std.math.maxInt(usize) - total) return false;
        total += len;
    }
    return @as(u64, @intCast(total)) <= trailer_offset;
}

pub fn load(init: std.process.Init) !?Payload {
    const allocator = init.arena.allocator();
    const executable_path = try std.process.executablePathAlloc(init.io, allocator);
    const executable = try std.Io.Dir.cwd().openFile(init.io, executable_path, .{});
    defer executable.close(init.io);
    const executable_len = try executable.length(init.io);

    if (executable_len >= trailer_v5_len) {
        var trailer: [trailer_v5_len]u8 = undefined;
        const trailer_offset = executable_len - trailer_v5_len;
        if (try executable.readPositionalAll(init.io, &trailer, trailer_offset) == trailer.len and
            std.mem.eql(u8, trailer[@sizeOf(u64) * 5 + @sizeOf(u32) ..], magic_v5))
        {
            const source_len = std.math.cast(usize, std.mem.readInt(u64, trailer[0..@sizeOf(u64)], .little)) orelse
                return error.InvalidStandaloneExecutable;
            const map_len = std.math.cast(usize, std.mem.readInt(u64, trailer[@sizeOf(u64) .. @sizeOf(u64) * 2], .little)) orelse
                return error.InvalidStandaloneExecutable;
            const files_len = std.math.cast(usize, std.mem.readInt(u64, trailer[@sizeOf(u64) * 2 .. @sizeOf(u64) * 3], .little)) orelse
                return error.InvalidStandaloneExecutable;
            const exec_argv_len = std.math.cast(usize, std.mem.readInt(u64, trailer[@sizeOf(u64) * 3 .. @sizeOf(u64) * 4], .little)) orelse
                return error.InvalidStandaloneExecutable;
            const bytecode_len = std.math.cast(usize, std.mem.readInt(u64, trailer[@sizeOf(u64) * 4 .. @sizeOf(u64) * 5], .little)) orelse
                return error.InvalidStandaloneExecutable;
            if (exec_argv_len > max_exec_argv_size or bytecode_len == 0 or
                !validPayloadLengths(trailer_offset, &.{ source_len, map_len, files_len, exec_argv_len, bytecode_len }))
            {
                return error.InvalidStandaloneExecutable;
            }

            const payload_offset = trailer_offset - source_len - map_len - files_len - exec_argv_len - bytecode_len;
            const source = try readPayloadPart(init, executable, source_len, payload_offset);
            const source_map = if (map_len > 0)
                try readPayloadPart(init, executable, map_len, payload_offset + source_len)
            else
                null;
            const files = if (files_len > 0)
                try readPayloadPart(init, executable, files_len, payload_offset + source_len + map_len)
            else
                null;
            const compile_exec_argv = if (exec_argv_len > 0)
                try readPayloadPart(init, executable, exec_argv_len, payload_offset + source_len + map_len + files_len)
            else
                "";
            const bytecode = try readPayloadPart(
                init,
                executable,
                bytecode_len,
                payload_offset + source_len + map_len + files_len + exec_argv_len,
            );
            const flags_bits = std.mem.readInt(
                u32,
                trailer[@sizeOf(u64) * 5 .. @sizeOf(u64) * 5 + @sizeOf(u32)],
                .little,
            );
            return .{
                .source = source,
                .source_map = source_map,
                .files = files,
                .compile_exec_argv = compile_exec_argv,
                .flags = @bitCast(flags_bits),
                .bytecode = bytecode,
            };
        }
    }

    if (executable_len >= trailer_v4_len) {
        var trailer: [trailer_v4_len]u8 = undefined;
        const trailer_offset = executable_len - trailer_v4_len;
        if (try executable.readPositionalAll(init.io, &trailer, trailer_offset) == trailer.len and
            std.mem.eql(u8, trailer[@sizeOf(u64) * 4 + @sizeOf(u32) ..], magic_v4))
        {
            const source_len = std.math.cast(usize, std.mem.readInt(u64, trailer[0..@sizeOf(u64)], .little)) orelse
                return error.InvalidStandaloneExecutable;
            const map_len = std.math.cast(usize, std.mem.readInt(u64, trailer[@sizeOf(u64) .. @sizeOf(u64) * 2], .little)) orelse
                return error.InvalidStandaloneExecutable;
            const files_len = std.math.cast(usize, std.mem.readInt(u64, trailer[@sizeOf(u64) * 2 .. @sizeOf(u64) * 3], .little)) orelse
                return error.InvalidStandaloneExecutable;
            const exec_argv_len = std.math.cast(usize, std.mem.readInt(u64, trailer[@sizeOf(u64) * 3 .. @sizeOf(u64) * 4], .little)) orelse
                return error.InvalidStandaloneExecutable;
            if (exec_argv_len > max_exec_argv_size or
                !validPayloadLengths(trailer_offset, &.{ source_len, map_len, files_len, exec_argv_len }))
            {
                return error.InvalidStandaloneExecutable;
            }

            const payload_offset = trailer_offset - source_len - map_len - files_len - exec_argv_len;
            const source = try readPayloadPart(init, executable, source_len, payload_offset);
            const source_map = if (map_len > 0)
                try readPayloadPart(init, executable, map_len, payload_offset + source_len)
            else
                null;
            const files = if (files_len > 0)
                try readPayloadPart(init, executable, files_len, payload_offset + source_len + map_len)
            else
                null;
            const compile_exec_argv = if (exec_argv_len > 0)
                try readPayloadPart(init, executable, exec_argv_len, payload_offset + source_len + map_len + files_len)
            else
                "";
            const flags_bits = std.mem.readInt(
                u32,
                trailer[@sizeOf(u64) * 4 .. @sizeOf(u64) * 4 + @sizeOf(u32)],
                .little,
            );
            return .{
                .source = source,
                .source_map = source_map,
                .files = files,
                .compile_exec_argv = compile_exec_argv,
                .flags = @bitCast(flags_bits),
            };
        }
    }

    if (executable_len >= trailer_v3_len) {
        var trailer: [trailer_v3_len]u8 = undefined;
        const trailer_offset = executable_len - trailer_v3_len;
        if (try executable.readPositionalAll(init.io, &trailer, trailer_offset) == trailer.len and
            std.mem.eql(u8, trailer[@sizeOf(u64) * 3 ..], magic_v3))
        {
            const source_len = std.math.cast(usize, std.mem.readInt(u64, trailer[0..@sizeOf(u64)], .little)) orelse
                return error.InvalidStandaloneExecutable;
            const map_len = std.math.cast(usize, std.mem.readInt(u64, trailer[@sizeOf(u64) .. @sizeOf(u64) * 2], .little)) orelse
                return error.InvalidStandaloneExecutable;
            const files_len = std.math.cast(usize, std.mem.readInt(u64, trailer[@sizeOf(u64) * 2 .. @sizeOf(u64) * 3], .little)) orelse
                return error.InvalidStandaloneExecutable;
            if (!validPayloadLengths(trailer_offset, &.{ source_len, map_len, files_len })) {
                return error.InvalidStandaloneExecutable;
            }
            const payload_offset = trailer_offset - source_len - map_len - files_len;
            return .{
                .source = try readPayloadPart(init, executable, source_len, payload_offset),
                .source_map = if (map_len > 0)
                    try readPayloadPart(init, executable, map_len, payload_offset + source_len)
                else
                    null,
                .files = if (files_len > 0)
                    try readPayloadPart(init, executable, files_len, payload_offset + source_len + map_len)
                else
                    null,
            };
        }
    }

    if (executable_len >= trailer_v2_len) {
        var trailer: [trailer_v2_len]u8 = undefined;
        const trailer_offset = executable_len - trailer_v2_len;
        if (try executable.readPositionalAll(init.io, &trailer, trailer_offset) == trailer.len and
            std.mem.eql(u8, trailer[@sizeOf(u64) * 2 ..], magic_v2))
        {
            const source_len = std.math.cast(usize, std.mem.readInt(u64, trailer[0..@sizeOf(u64)], .little)) orelse
                return error.InvalidStandaloneExecutable;
            const map_len = std.math.cast(usize, std.mem.readInt(u64, trailer[@sizeOf(u64) .. @sizeOf(u64) * 2], .little)) orelse
                return error.InvalidStandaloneExecutable;
            if (!validPayloadLengths(trailer_offset, &.{ source_len, map_len })) {
                return error.InvalidStandaloneExecutable;
            }
            const payload_offset = trailer_offset - source_len - map_len;
            return .{
                .source = try readPayloadPart(init, executable, source_len, payload_offset),
                .source_map = if (map_len > 0)
                    try readPayloadPart(init, executable, map_len, payload_offset + source_len)
                else
                    null,
            };
        }
    }

    if (executable_len < trailer_v1_len) return null;
    var trailer: [trailer_v1_len]u8 = undefined;
    const trailer_offset = executable_len - trailer_v1_len;
    if (try executable.readPositionalAll(init.io, &trailer, trailer_offset) != trailer.len or
        !std.mem.eql(u8, trailer[@sizeOf(u64)..], magic_v1))
    {
        return null;
    }
    const source_len = std.math.cast(usize, std.mem.readInt(u64, trailer[0..@sizeOf(u64)], .little)) orelse
        return error.InvalidStandaloneExecutable;
    if (!validPayloadLengths(trailer_offset, &.{source_len})) return error.InvalidStandaloneExecutable;
    return .{
        .source = try readPayloadPart(init, executable, source_len, trailer_offset - source_len),
    };
}

fn writeBuildFile(io: std.Io, path: []const u8, contents: []const u8) !void {
    if (std.fs.path.dirname(path)) |parent| {
        if (parent.len > 0) try std.Io.Dir.cwd().createDirPath(io, parent);
    }
    try std.Io.Dir.cwd().writeFile(io, .{ .sub_path = path, .data = contents });
}

fn supportsStandaloneMagic(init: std.process.Init, path: []const u8, comptime magic: []const u8) !bool {
    const executable = try std.Io.Dir.cwd().openFile(init.io, path, .{});
    defer executable.close(init.io);
    const executable_len = try executable.length(init.io);
    var buffer: [64 * 1024 + magic.len - 1]u8 = undefined;
    var offset: u64 = 0;
    var carry: usize = 0;
    while (offset < executable_len) {
        const remaining = executable_len - offset;
        const read_len: usize = @intCast(@min(remaining, buffer.len - carry));
        const count = try executable.readPositionalAll(init.io, buffer[carry .. carry + read_len], offset);
        if (count == 0) break;
        const available = carry + count;
        if (std.mem.indexOf(u8, buffer[0..available], magic) != null) return true;
        carry = @min(magic.len - 1, available);
        std.mem.copyForwards(u8, buffer[0..carry], buffer[available - carry .. available]);
        offset += count;
    }
    return false;
}

pub fn extraSourceMapPath(allocator: std.mem.Allocator, output_path: []const u8, map_path: []const u8) ![]const u8 {
    var relative = map_path;
    while (std.mem.startsWith(u8, relative, "./")) relative = relative[2..];
    if (relative.len == 0 or std.fs.path.isAbsolute(relative) or
        std.mem.eql(u8, relative, "..") or std.mem.startsWith(u8, relative, "../"))
    {
        return error.InvalidStandaloneSourceMapPath;
    }
    const output_dir = std.fs.path.dirname(output_path) orelse ".";
    return try std.fs.path.join(allocator, &.{ output_dir, relative });
}

pub fn write(
    init: std.process.Init,
    output_path: []const u8,
    base_executable_path: ?[]const u8,
    payload: Source,
    write_external_source_map: bool,
) !void {
    const allocator = init.arena.allocator();
    const executable_path = base_executable_path orelse try std.process.executablePathAlloc(init.io, allocator);
    const source_map_len = if (payload.source_map) |source_map| source_map.len else 0;
    const files_len = if (payload.files) |files| files.len else 0;
    const bytecode_len = if (payload.bytecode) |bytecode| bytecode.len else 0;
    if (payload.bytecode != null and bytecode_len == 0) return error.EmptyStandaloneBytecode;
    if (payload.source.len > max_payload_component_size or
        source_map_len > max_payload_component_size or
        files_len > max_payload_component_size or
        bytecode_len > max_payload_component_size or
        payload.compile_exec_argv.len > max_exec_argv_size)
    {
        return error.StandalonePayloadTooLarge;
    }
    if (base_executable_path != null) {
        const supported = if (payload.bytecode != null)
            try supportsStandaloneMagic(init, executable_path, magic_v5)
        else
            try supportsStandaloneMagic(init, executable_path, magic_v4);
        if (!supported) return error.IncompatibleStandaloneExecutable;
    }
    try std.Io.Dir.copyFile(
        std.Io.Dir.cwd(),
        executable_path,
        std.Io.Dir.cwd(),
        output_path,
        init.io,
        .{ .make_path = true },
    );
    errdefer std.Io.Dir.cwd().deleteFile(init.io, output_path) catch {};

    const output = try std.Io.Dir.cwd().openFile(init.io, output_path, .{ .mode = .read_write });
    defer output.close(init.io);
    const executable_len = try output.length(init.io);
    const source_map = payload.source_map orelse "";
    const files = payload.files orelse "";
    const exec_argv = payload.compile_exec_argv;
    const bytecode = payload.bytecode orelse "";
    var offset = executable_len;
    for ([_][]const u8{ payload.source, source_map, files, exec_argv, bytecode }) |part| {
        try output.writePositionalAll(init.io, part, offset);
        offset += part.len;
    }

    if (payload.bytecode != null) {
        var trailer: [trailer_v5_len]u8 = undefined;
        std.mem.writeInt(u64, trailer[0..@sizeOf(u64)], @intCast(payload.source.len), .little);
        std.mem.writeInt(u64, trailer[@sizeOf(u64) .. @sizeOf(u64) * 2], @intCast(source_map.len), .little);
        std.mem.writeInt(u64, trailer[@sizeOf(u64) * 2 .. @sizeOf(u64) * 3], @intCast(files.len), .little);
        std.mem.writeInt(u64, trailer[@sizeOf(u64) * 3 .. @sizeOf(u64) * 4], @intCast(exec_argv.len), .little);
        std.mem.writeInt(u64, trailer[@sizeOf(u64) * 4 .. @sizeOf(u64) * 5], @intCast(bytecode.len), .little);
        std.mem.writeInt(
            u32,
            trailer[@sizeOf(u64) * 5 .. @sizeOf(u64) * 5 + @sizeOf(u32)],
            @bitCast(payload.flags),
            .little,
        );
        @memcpy(trailer[@sizeOf(u64) * 5 + @sizeOf(u32) ..], magic_v5);
        try output.writePositionalAll(init.io, &trailer, offset);
    } else {
        var trailer: [trailer_v4_len]u8 = undefined;
        std.mem.writeInt(u64, trailer[0..@sizeOf(u64)], @intCast(payload.source.len), .little);
        std.mem.writeInt(u64, trailer[@sizeOf(u64) .. @sizeOf(u64) * 2], @intCast(source_map.len), .little);
        std.mem.writeInt(u64, trailer[@sizeOf(u64) * 2 .. @sizeOf(u64) * 3], @intCast(files.len), .little);
        std.mem.writeInt(u64, trailer[@sizeOf(u64) * 3 .. @sizeOf(u64) * 4], @intCast(exec_argv.len), .little);
        std.mem.writeInt(
            u32,
            trailer[@sizeOf(u64) * 4 .. @sizeOf(u64) * 4 + @sizeOf(u32)],
            @bitCast(payload.flags),
            .little,
        );
        @memcpy(trailer[@sizeOf(u64) * 4 + @sizeOf(u32) ..], magic_v4);
        try output.writePositionalAll(init.io, &trailer, offset);
    }

    if (write_external_source_map and payload.source_map != null) {
        const map_path = try std.mem.concat(allocator, u8, &.{ output_path, ".map" });
        try writeBuildFile(init.io, map_path, source_map);
        for (payload.source_maps) |extra_map| {
            const extra_path = try extraSourceMapPath(allocator, output_path, extra_map.path);
            try writeBuildFile(init.io, extra_path, extra_map.contents);
        }
    }
}

test "standalone flags preserve Bun's serialized bit order" {
    const flags = Flags{
        .disable_default_env_files = true,
        .disable_autoload_bunfig = true,
        .disable_autoload_tsconfig = false,
        .disable_autoload_package_json = true,
    };
    try std.testing.expectEqual(@as(u32, 0b1011), @as(u32, @bitCast(flags)));
}
