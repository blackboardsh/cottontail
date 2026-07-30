const std = @import("std");

// This protocol-only C ABI intentionally owns no sockets, JSC values, or query
// state so the codec can move unchanged into an optional database library.
pub const WireSlice = extern struct {
    offset: usize,
    len: usize,
    is_null: u8,
};

pub const WireFrame = extern struct {
    kind: u8,
    sequence_id: u8,
    payload_offset: usize,
    payload_len: usize,
};

pub const PostgresColumn = extern struct {
    name: WireSlice,
    table_oid: u32,
    attribute: u16,
    type_oid: u32,
    type_size: i16,
    type_modifier: i32,
    format: u16,
};

pub const PostgresParameter = extern struct {
    oid: u32,
    flags: u32,
    bytes: ?[*]const u8,
    len: usize,
};

pub const MySQLColumn = extern struct {
    catalog: WireSlice,
    schema: WireSlice,
    table: WireSlice,
    original_table: WireSlice,
    name: WireSlice,
    original_name: WireSlice,
    character_set: u16,
    column_length: u32,
    field_type: u8,
    flags: u16,
    decimals: u8,
};

pub const postgres_parameter_null: u32 = 1 << 0;
pub const postgres_parameter_bytea: u32 = 1 << 1;

const max_mysql_payload = 0x00ff_ffff;
const max_postgres_parameter_len = std.math.maxInt(i32);

fn bytesFromPointer(pointer: ?[*]const u8, len: usize) []const u8 {
    if (len == 0) return &.{};
    return pointer.?[0..len];
}

fn checkedBytesFromPointer(
    pointer: ?[*]const u8,
    len: usize,
    error_out: *?[*:0]u8,
) ?[]const u8 {
    if (len > 0 and pointer == null) {
        setError(error_out, "SQL wire input pointer is null");
        return null;
    }
    return bytesFromPointer(pointer, len);
}

fn setError(error_out: *?[*:0]u8, message: []const u8) void {
    const copy = std.fmt.allocPrintSentinel(std.heap.c_allocator, "{s}", .{message}, 0) catch {
        error_out.* = null;
        return;
    };
    error_out.* = copy.ptr;
}

fn setFormattedError(error_out: *?[*:0]u8, comptime format: []const u8, args: anytype) void {
    const copy = std.fmt.allocPrintSentinel(std.heap.c_allocator, format, args, 0) catch {
        error_out.* = null;
        return;
    };
    error_out.* = copy.ptr;
}

fn checkedAdd(left: usize, right: usize) ?usize {
    if (right > std.math.maxInt(usize) - left) return null;
    return left + right;
}

fn checkedMul(left: usize, right: usize) ?usize {
    if (left != 0 and right > std.math.maxInt(usize) / left) return null;
    return left * right;
}

fn readU16BE(bytes: []const u8, offset: usize) u16 {
    return (@as(u16, bytes[offset]) << 8) |
        @as(u16, bytes[offset + 1]);
}

fn readU16LE(bytes: []const u8, offset: usize) u16 {
    return @as(u16, bytes[offset]) |
        (@as(u16, bytes[offset + 1]) << 8);
}

fn readU24LE(bytes: []const u8, offset: usize) u32 {
    return @as(u32, bytes[offset]) |
        (@as(u32, bytes[offset + 1]) << 8) |
        (@as(u32, bytes[offset + 2]) << 16);
}

fn readU32BE(bytes: []const u8, offset: usize) u32 {
    return (@as(u32, bytes[offset]) << 24) |
        (@as(u32, bytes[offset + 1]) << 16) |
        (@as(u32, bytes[offset + 2]) << 8) |
        @as(u32, bytes[offset + 3]);
}

fn readU32LE(bytes: []const u8, offset: usize) u32 {
    return @as(u32, bytes[offset]) |
        (@as(u32, bytes[offset + 1]) << 8) |
        (@as(u32, bytes[offset + 2]) << 16) |
        (@as(u32, bytes[offset + 3]) << 24);
}

fn readU64LE(bytes: []const u8, offset: usize) u64 {
    var value: u64 = 0;
    for (0..8) |index| {
        value |= @as(u64, bytes[offset + index]) << @intCast(index * 8);
    }
    return value;
}

fn writeU16BE(bytes: []u8, offset: usize, value: u16) void {
    bytes[offset] = @truncate(value >> 8);
    bytes[offset + 1] = @truncate(value);
}

fn writeU24LE(bytes: []u8, offset: usize, value: usize) void {
    bytes[offset] = @truncate(value);
    bytes[offset + 1] = @truncate(value >> 8);
    bytes[offset + 2] = @truncate(value >> 16);
}

fn writeU32BE(bytes: []u8, offset: usize, value: u32) void {
    bytes[offset] = @truncate(value >> 24);
    bytes[offset + 1] = @truncate(value >> 16);
    bytes[offset + 2] = @truncate(value >> 8);
    bytes[offset + 3] = @truncate(value);
}

fn writeTypedMessageHeader(output: []u8, offset: *usize, kind: u8, body_len: usize) void {
    output[offset.*] = kind;
    writeU32BE(output, offset.* + 1, @intCast(body_len + 4));
    offset.* += 5;
}

pub export fn ct_sql_postgres_frame_messages(
    input_pointer: ?[*]const u8,
    input_len: usize,
    frames_out: *?[*]WireFrame,
    frame_count_out: *usize,
    consumed_out: *usize,
    error_out: *?[*:0]u8,
) c_int {
    frames_out.* = null;
    frame_count_out.* = 0;
    consumed_out.* = 0;
    error_out.* = null;
    const input = checkedBytesFromPointer(input_pointer, input_len, error_out) orelse return -1;

    var count: usize = 0;
    var cursor: usize = 0;
    while (input.len - cursor >= 5) {
        const message_len = readU32BE(input, cursor + 1);
        if (message_len < 4) {
            setFormattedError(error_out, "Invalid PostgreSQL message length: {d}", .{message_len});
            return -1;
        }
        const total_len = checkedAdd(1, @as(usize, message_len)) orelse {
            setError(error_out, "PostgreSQL message length overflow");
            return -1;
        };
        if (total_len > input.len - cursor) break;
        cursor += total_len;
        count += 1;
    }

    consumed_out.* = cursor;
    if (count == 0) return 0;
    const frames = std.heap.c_allocator.alloc(WireFrame, count) catch {
        setError(error_out, "Out of memory");
        return -1;
    };

    cursor = 0;
    for (frames) |*frame| {
        const message_len = readU32BE(input, cursor + 1);
        frame.* = .{
            .kind = input[cursor],
            .sequence_id = 0,
            .payload_offset = cursor + 5,
            .payload_len = message_len - 4,
        };
        cursor += 1 + @as(usize, message_len);
    }
    frames_out.* = frames.ptr;
    frame_count_out.* = frames.len;
    return 0;
}

pub export fn ct_sql_mysql_frame_packets(
    input_pointer: ?[*]const u8,
    input_len: usize,
    frames_out: *?[*]WireFrame,
    frame_count_out: *usize,
    consumed_out: *usize,
    error_out: *?[*:0]u8,
) c_int {
    frames_out.* = null;
    frame_count_out.* = 0;
    consumed_out.* = 0;
    error_out.* = null;
    const input = checkedBytesFromPointer(input_pointer, input_len, error_out) orelse return -1;

    var count: usize = 0;
    var cursor: usize = 0;
    while (input.len - cursor >= 4) {
        const payload_len: usize = readU24LE(input, cursor);
        const total_len = payload_len + 4;
        if (total_len > input.len - cursor) break;
        cursor += total_len;
        count += 1;
    }

    consumed_out.* = cursor;
    if (count == 0) return 0;
    const frames = std.heap.c_allocator.alloc(WireFrame, count) catch {
        setError(error_out, "Out of memory");
        return -1;
    };

    cursor = 0;
    for (frames) |*frame| {
        const payload_len: usize = readU24LE(input, cursor);
        frame.* = .{
            .kind = 0,
            .sequence_id = input[cursor + 3],
            .payload_offset = cursor + 4,
            .payload_len = payload_len,
        };
        cursor += payload_len + 4;
    }
    frames_out.* = frames.ptr;
    frame_count_out.* = frames.len;
    return 0;
}

pub export fn ct_sql_postgres_decode_row_description(
    input_pointer: ?[*]const u8,
    input_len: usize,
    columns_out: *?[*]PostgresColumn,
    column_count_out: *usize,
    error_out: *?[*:0]u8,
) c_int {
    columns_out.* = null;
    column_count_out.* = 0;
    error_out.* = null;
    const input = checkedBytesFromPointer(input_pointer, input_len, error_out) orelse return -1;
    if (input.len < 2) {
        setError(error_out, "Truncated PostgreSQL row description");
        return -1;
    }

    const count: usize = readU16BE(input, 0);
    if (count == 0) return 0;
    const columns = std.heap.c_allocator.alloc(PostgresColumn, count) catch {
        setError(error_out, "Out of memory");
        return -1;
    };

    var offset: usize = 2;
    for (columns) |*column| {
        const name_start = offset;
        while (offset < input.len and input[offset] != 0) : (offset += 1) {}
        if (offset >= input.len or input.len - offset - 1 < 18) {
            std.heap.c_allocator.free(columns);
            setError(error_out, "Truncated PostgreSQL field description");
            return -1;
        }
        const name_end = offset;
        offset += 1;

        const table_oid = readU32BE(input, offset);
        offset += 4;
        const attribute = readU16BE(input, offset);
        offset += 2;
        const type_oid = readU32BE(input, offset);
        offset += 4;
        const type_size: i16 = @bitCast(readU16BE(input, offset));
        offset += 2;
        const type_modifier: i32 = @bitCast(readU32BE(input, offset));
        offset += 4;
        const format = readU16BE(input, offset);
        offset += 2;

        column.* = .{
            .name = .{ .offset = name_start, .len = name_end - name_start, .is_null = 0 },
            .table_oid = table_oid,
            .attribute = attribute,
            .type_oid = type_oid,
            .type_size = type_size,
            .type_modifier = type_modifier,
            .format = format,
        };
    }

    columns_out.* = columns.ptr;
    column_count_out.* = columns.len;
    return 0;
}

pub export fn ct_sql_postgres_decode_data_row(
    input_pointer: ?[*]const u8,
    input_len: usize,
    fields_out: *?[*]WireSlice,
    field_count_out: *usize,
    error_out: *?[*:0]u8,
) c_int {
    fields_out.* = null;
    field_count_out.* = 0;
    error_out.* = null;
    const input = checkedBytesFromPointer(input_pointer, input_len, error_out) orelse return -1;
    if (input.len < 2) {
        setError(error_out, "Truncated PostgreSQL data row");
        return -1;
    }

    const count: usize = readU16BE(input, 0);
    if (count == 0) return 0;
    const fields = std.heap.c_allocator.alloc(WireSlice, count) catch {
        setError(error_out, "Out of memory");
        return -1;
    };

    var offset: usize = 2;
    for (fields) |*field| {
        if (input.len - offset < 4) {
            std.heap.c_allocator.free(fields);
            setError(error_out, "Truncated PostgreSQL data row value");
            return -1;
        }
        const raw_len = readU32BE(input, offset);
        offset += 4;
        if (raw_len == std.math.maxInt(u32)) {
            field.* = .{ .offset = offset, .len = 0, .is_null = 1 };
            continue;
        }
        const value_len: usize = raw_len;
        if (value_len > input.len - offset) {
            std.heap.c_allocator.free(fields);
            setError(error_out, "Truncated PostgreSQL data row value");
            return -1;
        }
        field.* = .{ .offset = offset, .len = value_len, .is_null = 0 };
        offset += value_len;
    }

    fields_out.* = fields.ptr;
    field_count_out.* = fields.len;
    return 0;
}

pub export fn ct_sql_postgres_build_extended_query(
    statement_pointer: ?[*]const u8,
    statement_len: usize,
    parameters_pointer: ?[*]const PostgresParameter,
    parameter_count: usize,
    output_pointer_out: *?[*]u8,
    output_len_out: *usize,
    error_out: *?[*:0]u8,
) c_int {
    output_pointer_out.* = null;
    output_len_out.* = 0;
    error_out.* = null;
    const statement = checkedBytesFromPointer(statement_pointer, statement_len, error_out) orelse return -1;
    if (parameter_count > 0 and parameters_pointer == null) {
        setError(error_out, "PostgreSQL parameter pointer is null");
        return -1;
    }
    const parameters = if (parameter_count == 0)
        &[_]PostgresParameter{}
    else
        parameters_pointer.?[0..parameter_count];

    if (parameter_count > std.math.maxInt(u16)) {
        setError(error_out, "PostgreSQL supports at most 65535 query parameters");
        return -1;
    }
    if (std.mem.indexOfScalar(u8, statement, 0) != null) {
        setError(error_out, "PostgreSQL queries cannot contain null bytes");
        return -1;
    }

    var encoded_parameter_bytes: usize = 0;
    for (parameters) |parameter| {
        if (parameter.flags & postgres_parameter_null != 0) continue;
        if (parameter.len > 0 and parameter.bytes == null) {
            setError(error_out, "PostgreSQL parameter byte pointer is null");
            return -1;
        }
        var encoded_len = parameter.len;
        if (parameter.flags & postgres_parameter_bytea != 0) {
            const hex_len = checkedMul(parameter.len, 2) orelse {
                setError(error_out, "PostgreSQL parameter is too large");
                return -1;
            };
            encoded_len = checkedAdd(2, hex_len) orelse {
                setError(error_out, "PostgreSQL parameter is too large");
                return -1;
            };
        }
        if (encoded_len > max_postgres_parameter_len) {
            setError(error_out, "PostgreSQL parameter is too large");
            return -1;
        }
        encoded_parameter_bytes = checkedAdd(encoded_parameter_bytes, encoded_len) orelse {
            setError(error_out, "PostgreSQL query message is too large");
            return -1;
        };
    }

    const oid_bytes = checkedMul(parameter_count, 4) orelse {
        setError(error_out, "PostgreSQL query message is too large");
        return -1;
    };
    const parameter_length_bytes = checkedMul(parameter_count, 4) orelse {
        setError(error_out, "PostgreSQL query message is too large");
        return -1;
    };
    const statement_body_len = checkedAdd(statement.len, 4) orelse {
        setError(error_out, "PostgreSQL query message is too large");
        return -1;
    };
    const parse_body_len = checkedAdd(statement_body_len, oid_bytes) orelse {
        setError(error_out, "PostgreSQL query message is too large");
        return -1;
    };
    var bind_body_len = checkedAdd(8, parameter_length_bytes) orelse {
        setError(error_out, "PostgreSQL query message is too large");
        return -1;
    };
    bind_body_len = checkedAdd(bind_body_len, encoded_parameter_bytes) orelse {
        setError(error_out, "PostgreSQL query message is too large");
        return -1;
    };
    var output_len = checkedAdd(parse_body_len, bind_body_len) orelse {
        setError(error_out, "PostgreSQL query message is too large");
        return -1;
    };
    output_len = checkedAdd(output_len, 32) orelse {
        setError(error_out, "PostgreSQL query message is too large");
        return -1;
    };
    if (parse_body_len > std.math.maxInt(u32) - 4 or bind_body_len > std.math.maxInt(u32) - 4) {
        setError(error_out, "PostgreSQL query message is too large");
        return -1;
    }

    const output = std.heap.c_allocator.alloc(u8, output_len) catch {
        setError(error_out, "Out of memory");
        return -1;
    };
    var offset: usize = 0;

    writeTypedMessageHeader(output, &offset, 'P', parse_body_len);
    output[offset] = 0;
    offset += 1;
    @memcpy(output[offset .. offset + statement.len], statement);
    offset += statement.len;
    output[offset] = 0;
    offset += 1;
    writeU16BE(output, offset, @intCast(parameter_count));
    offset += 2;
    for (parameters) |parameter| {
        writeU32BE(output, offset, parameter.oid);
        offset += 4;
    }

    writeTypedMessageHeader(output, &offset, 'B', bind_body_len);
    output[offset] = 0;
    output[offset + 1] = 0;
    offset += 2;
    writeU16BE(output, offset, 0);
    offset += 2;
    writeU16BE(output, offset, @intCast(parameter_count));
    offset += 2;
    const hex = "0123456789abcdef";
    for (parameters) |parameter| {
        if (parameter.flags & postgres_parameter_null != 0) {
            writeU32BE(output, offset, std.math.maxInt(u32));
            offset += 4;
            continue;
        }
        const bytes = bytesFromPointer(parameter.bytes, parameter.len);
        if (parameter.flags & postgres_parameter_bytea != 0) {
            const encoded_len = 2 + bytes.len * 2;
            writeU32BE(output, offset, @intCast(encoded_len));
            offset += 4;
            output[offset] = '\\';
            output[offset + 1] = 'x';
            offset += 2;
            for (bytes) |byte| {
                output[offset] = hex[byte >> 4];
                output[offset + 1] = hex[byte & 0x0f];
                offset += 2;
            }
        } else {
            writeU32BE(output, offset, @intCast(bytes.len));
            offset += 4;
            @memcpy(output[offset .. offset + bytes.len], bytes);
            offset += bytes.len;
        }
    }
    writeU16BE(output, offset, 0);
    offset += 2;

    writeTypedMessageHeader(output, &offset, 'D', 2);
    output[offset] = 'P';
    output[offset + 1] = 0;
    offset += 2;

    writeTypedMessageHeader(output, &offset, 'E', 5);
    @memset(output[offset .. offset + 5], 0);
    offset += 5;

    writeTypedMessageHeader(output, &offset, 'S', 0);
    std.debug.assert(offset == output.len);
    output_pointer_out.* = output.ptr;
    output_len_out.* = output.len;
    return 0;
}

const LengthEncodedError = error{
    TruncatedInteger,
    InvalidInteger,
};

fn readMySQLLengthEncodedInteger(input: []const u8, offset: *usize) LengthEncodedError!?u64 {
    if (offset.* >= input.len) return error.TruncatedInteger;
    const first = input[offset.*];
    offset.* += 1;
    if (first < 0xfb) return first;
    if (first == 0xfb) return null;
    const byte_count: usize = switch (first) {
        0xfc => 2,
        0xfd => 3,
        0xfe => 8,
        else => return error.InvalidInteger,
    };
    if (byte_count > input.len - offset.*) return error.TruncatedInteger;
    const value: u64 = switch (byte_count) {
        2 => readU16LE(input, offset.*),
        3 => readU24LE(input, offset.*),
        8 => readU64LE(input, offset.*),
        else => unreachable,
    };
    offset.* += byte_count;
    return value;
}

fn setLengthEncodedError(error_out: *?[*:0]u8, err: LengthEncodedError) void {
    setError(error_out, switch (err) {
        error.TruncatedInteger => "Truncated length-encoded integer",
        error.InvalidInteger => "Invalid length-encoded integer",
    });
}

fn readMySQLLengthEncodedSlice(
    input: []const u8,
    offset: *usize,
) (LengthEncodedError || error{TruncatedString})!WireSlice {
    const maybe_len = try readMySQLLengthEncodedInteger(input, offset);
    if (maybe_len == null) return .{ .offset = offset.*, .len = 0, .is_null = 1 };
    const value_len_u64 = maybe_len.?;
    if (value_len_u64 > std.math.maxInt(usize)) return error.TruncatedString;
    const value_len: usize = @intCast(value_len_u64);
    if (value_len > input.len - offset.*) return error.TruncatedString;
    const result = WireSlice{ .offset = offset.*, .len = value_len, .is_null = 0 };
    offset.* += value_len;
    return result;
}

pub export fn ct_sql_mysql_read_length_encoded_integer(
    input_pointer: ?[*]const u8,
    input_len: usize,
    initial_offset: usize,
    value_out: *u64,
    next_offset_out: *usize,
    is_null_out: *u8,
    error_out: *?[*:0]u8,
) c_int {
    value_out.* = 0;
    next_offset_out.* = initial_offset;
    is_null_out.* = 0;
    error_out.* = null;
    const input = checkedBytesFromPointer(input_pointer, input_len, error_out) orelse return -1;
    var offset = initial_offset;
    const value = readMySQLLengthEncodedInteger(input, &offset) catch |err| {
        setLengthEncodedError(error_out, err);
        return -1;
    };
    next_offset_out.* = offset;
    if (value) |integer| {
        value_out.* = integer;
    } else {
        is_null_out.* = 1;
    }
    return 0;
}

pub export fn ct_sql_mysql_decode_column(
    input_pointer: ?[*]const u8,
    input_len: usize,
    column_out: *MySQLColumn,
    error_out: *?[*:0]u8,
) c_int {
    column_out.* = std.mem.zeroes(MySQLColumn);
    error_out.* = null;
    const input = checkedBytesFromPointer(input_pointer, input_len, error_out) orelse return -1;
    var offset: usize = 0;
    var names: [6]WireSlice = undefined;
    for (&names) |*name| {
        name.* = readMySQLLengthEncodedSlice(input, &offset) catch |err| {
            switch (err) {
                error.TruncatedString => setError(error_out, "Truncated length-encoded string"),
                error.TruncatedInteger => setError(error_out, "Truncated length-encoded integer"),
                error.InvalidInteger => setError(error_out, "Invalid length-encoded integer"),
            }
            return -1;
        };
    }
    _ = readMySQLLengthEncodedInteger(input, &offset) catch |err| {
        setLengthEncodedError(error_out, err);
        return -1;
    };
    if (input.len - offset < 10) {
        setError(error_out, "Truncated MySQL column definition");
        return -1;
    }

    column_out.* = .{
        .catalog = names[0],
        .schema = names[1],
        .table = names[2],
        .original_table = names[3],
        .name = names[4],
        .original_name = names[5],
        .character_set = readU16LE(input, offset),
        .column_length = readU32LE(input, offset + 2),
        .field_type = input[offset + 6],
        .flags = readU16LE(input, offset + 7),
        .decimals = input[offset + 9],
    };
    return 0;
}

pub export fn ct_sql_mysql_decode_row(
    input_pointer: ?[*]const u8,
    input_len: usize,
    expected_field_count: usize,
    fields_out: *?[*]WireSlice,
    field_count_out: *usize,
    error_out: *?[*:0]u8,
) c_int {
    fields_out.* = null;
    field_count_out.* = 0;
    error_out.* = null;
    const input = checkedBytesFromPointer(input_pointer, input_len, error_out) orelse return -1;
    if (expected_field_count == 0) return 0;
    const fields = std.heap.c_allocator.alloc(WireSlice, expected_field_count) catch {
        setError(error_out, "Out of memory");
        return -1;
    };

    var offset: usize = 0;
    for (fields) |*field| {
        field.* = readMySQLLengthEncodedSlice(input, &offset) catch |err| {
            switch (err) {
                error.TruncatedString => setError(error_out, "Truncated length-encoded string"),
                error.TruncatedInteger => setError(error_out, "Truncated length-encoded integer"),
                error.InvalidInteger => setError(error_out, "Invalid length-encoded integer"),
            }
            std.heap.c_allocator.free(fields);
            return -1;
        };
    }
    fields_out.* = fields.ptr;
    field_count_out.* = fields.len;
    return 0;
}

pub export fn ct_sql_mysql_frame_payload(
    input_pointer: ?[*]const u8,
    input_len: usize,
    initial_sequence_id: u8,
    output_pointer_out: *?[*]u8,
    output_len_out: *usize,
    next_sequence_id_out: *u8,
    error_out: *?[*:0]u8,
) c_int {
    output_pointer_out.* = null;
    output_len_out.* = 0;
    next_sequence_id_out.* = initial_sequence_id;
    error_out.* = null;
    const input = checkedBytesFromPointer(input_pointer, input_len, error_out) orelse return -1;

    var packet_count: usize = if (input.len == 0)
        1
    else
        input.len / max_mysql_payload + @intFromBool(input.len % max_mysql_payload != 0);
    if (input.len > 0 and input.len % max_mysql_payload == 0) packet_count += 1;
    const header_bytes = checkedMul(packet_count, 4) orelse {
        setError(error_out, "MySQL packet payload is too large");
        return -1;
    };
    const output_len = checkedAdd(input.len, header_bytes) orelse {
        setError(error_out, "MySQL packet payload is too large");
        return -1;
    };
    const output = std.heap.c_allocator.alloc(u8, output_len) catch {
        setError(error_out, "Out of memory");
        return -1;
    };

    var input_offset: usize = 0;
    var output_offset: usize = 0;
    var sequence_id = initial_sequence_id;
    var remaining_packets = packet_count;
    while (remaining_packets > 0) : (remaining_packets -= 1) {
        const payload_len = @min(max_mysql_payload, input.len - input_offset);
        writeU24LE(output, output_offset, payload_len);
        output[output_offset + 3] = sequence_id;
        output_offset += 4;
        if (payload_len > 0) {
            @memcpy(output[output_offset .. output_offset + payload_len], input[input_offset .. input_offset + payload_len]);
            output_offset += payload_len;
            input_offset += payload_len;
        }
        sequence_id +%= 1;
    }
    std.debug.assert(output_offset == output.len);
    output_pointer_out.* = output.ptr;
    output_len_out.* = output.len;
    next_sequence_id_out.* = sequence_id;
    return 0;
}

pub export fn ct_sql_wire_free(pointer: ?*anyopaque) void {
    std.c.free(pointer);
}

test "SQL wire PostgreSQL framing and row decoding" {
    const first = [_]u8{ 'T', 0, 0, 0, 6, 0, 0 };
    const second = [_]u8{ 'D', 0, 0, 0, 4 };
    const partial = [_]u8{ 'Z', 0, 0 };
    const input = first ++ second ++ partial;

    var frames_pointer: ?[*]WireFrame = null;
    var frame_count: usize = 0;
    var consumed: usize = 0;
    var error_message: ?[*:0]u8 = null;
    try std.testing.expectEqual(@as(c_int, 0), ct_sql_postgres_frame_messages(
        &input,
        input.len,
        &frames_pointer,
        &frame_count,
        &consumed,
        &error_message,
    ));
    defer ct_sql_wire_free(frames_pointer);
    try std.testing.expectEqual(@as(usize, 2), frame_count);
    try std.testing.expectEqual(first.len + second.len, consumed);
    try std.testing.expectEqual(@as(u8, 'T'), frames_pointer.?[0].kind);
    try std.testing.expectEqual(@as(usize, 2), frames_pointer.?[0].payload_len);

    const row = [_]u8{
        0,    4,
        0,    0,
        0,    3,
        '4',  '2',
        '!',  0xff,
        0xff, 0xff,
        0xff, 0,
        0,    0,
        0,    0,
        0,    0,
        3,    0x00,
        0xff, 0x7e,
    };
    var fields_pointer: ?[*]WireSlice = null;
    var field_count: usize = 0;
    try std.testing.expectEqual(@as(c_int, 0), ct_sql_postgres_decode_data_row(
        &row,
        row.len,
        &fields_pointer,
        &field_count,
        &error_message,
    ));
    defer ct_sql_wire_free(fields_pointer);
    try std.testing.expectEqual(@as(usize, 4), field_count);
    try std.testing.expectEqualSlices(u8, "42!", row[fields_pointer.?[0].offset..][0..fields_pointer.?[0].len]);
    try std.testing.expectEqual(@as(u8, 1), fields_pointer.?[1].is_null);
    try std.testing.expectEqual(@as(usize, 0), fields_pointer.?[2].len);
    try std.testing.expectEqualSlices(
        u8,
        &.{ 0x00, 0xff, 0x7e },
        row[fields_pointer.?[3].offset..][0..fields_pointer.?[3].len],
    );
}

test "SQL wire PostgreSQL extended query serializes bytea natively" {
    const statement = "select $1, $2";
    const raw = [_]u8{ 0x00, 0xab, 0xff };
    const parameters = [_]PostgresParameter{
        .{ .oid = 17, .flags = postgres_parameter_bytea, .bytes = &raw, .len = raw.len },
        .{ .oid = 0, .flags = postgres_parameter_null, .bytes = null, .len = 0 },
    };
    var output_pointer: ?[*]u8 = null;
    var output_len: usize = 0;
    var error_message: ?[*:0]u8 = null;
    try std.testing.expectEqual(@as(c_int, 0), ct_sql_postgres_build_extended_query(
        statement.ptr,
        statement.len,
        &parameters,
        parameters.len,
        &output_pointer,
        &output_len,
        &error_message,
    ));
    defer ct_sql_wire_free(output_pointer);
    const output = output_pointer.?[0..output_len];
    try std.testing.expect(std.mem.indexOf(u8, output, "\\x00abff") != null);
    try std.testing.expectEqual(@as(u8, 'P'), output[0]);
    try std.testing.expectEqual(@as(u8, 'S'), output[output.len - 5]);
}

test "SQL wire MySQL length-encoded fields and packet framing" {
    const fields = [_]u8{
        0xfb,
        0xfc,
        0x03,
        0x00,
        'a',
        'b',
        'c',
        0xfd,
        0x03,
        0x00,
        0x00,
        0x00,
        0xff,
        0x7e,
    };
    var slices_pointer: ?[*]WireSlice = null;
    var slice_count: usize = 0;
    var error_message: ?[*:0]u8 = null;
    try std.testing.expectEqual(@as(c_int, 0), ct_sql_mysql_decode_row(
        &fields,
        fields.len,
        3,
        &slices_pointer,
        &slice_count,
        &error_message,
    ));
    defer ct_sql_wire_free(slices_pointer);
    try std.testing.expectEqual(@as(u8, 1), slices_pointer.?[0].is_null);
    try std.testing.expectEqualSlices(u8, "abc", fields[slices_pointer.?[1].offset..][0..slices_pointer.?[1].len]);
    try std.testing.expectEqualSlices(
        u8,
        &.{ 0x00, 0xff, 0x7e },
        fields[slices_pointer.?[2].offset..][0..slices_pointer.?[2].len],
    );

    var packet_pointer: ?[*]u8 = null;
    var packet_len: usize = 0;
    var next_sequence: u8 = 0;
    try std.testing.expectEqual(@as(c_int, 0), ct_sql_mysql_frame_payload(
        "hello".ptr,
        5,
        9,
        &packet_pointer,
        &packet_len,
        &next_sequence,
        &error_message,
    ));
    defer ct_sql_wire_free(packet_pointer);
    try std.testing.expectEqual(@as(usize, 9), packet_len);
    try std.testing.expectEqual(@as(u8, 10), next_sequence);
    try std.testing.expectEqualSlices(u8, &.{ 5, 0, 0, 9 }, packet_pointer.?[0..4]);
    try std.testing.expectEqualSlices(u8, "hello", packet_pointer.?[4..9]);
}

test "SQL wire rejects malformed packet and row bounds" {
    var frames_pointer: ?[*]WireFrame = null;
    var frame_count: usize = 0;
    var consumed: usize = 0;
    var error_message: ?[*:0]u8 = null;

    const invalid_postgres_frame = [_]u8{ 'D', 0, 0, 0, 3 };
    try std.testing.expectEqual(@as(c_int, -1), ct_sql_postgres_frame_messages(
        &invalid_postgres_frame,
        invalid_postgres_frame.len,
        &frames_pointer,
        &frame_count,
        &consumed,
        &error_message,
    ));
    try std.testing.expectEqualStrings("Invalid PostgreSQL message length: 3", std.mem.span(error_message.?));
    ct_sql_wire_free(error_message);
    error_message = null;

    const truncated_postgres_description = [_]u8{ 0, 1, 'x', 0 };
    var columns_pointer: ?[*]PostgresColumn = null;
    var column_count: usize = 0;
    try std.testing.expectEqual(@as(c_int, -1), ct_sql_postgres_decode_row_description(
        &truncated_postgres_description,
        truncated_postgres_description.len,
        &columns_pointer,
        &column_count,
        &error_message,
    ));
    try std.testing.expectEqualStrings("Truncated PostgreSQL field description", std.mem.span(error_message.?));
    ct_sql_wire_free(error_message);
    error_message = null;

    const incomplete_mysql_packet = [_]u8{ 5, 0, 0, 7, 'x' };
    try std.testing.expectEqual(@as(c_int, 0), ct_sql_mysql_frame_packets(
        &incomplete_mysql_packet,
        incomplete_mysql_packet.len,
        &frames_pointer,
        &frame_count,
        &consumed,
        &error_message,
    ));
    try std.testing.expectEqual(@as(usize, 0), frame_count);
    try std.testing.expectEqual(@as(usize, 0), consumed);

    try std.testing.expectEqual(@as(c_int, -1), ct_sql_mysql_frame_packets(
        null,
        1,
        &frames_pointer,
        &frame_count,
        &consumed,
        &error_message,
    ));
    try std.testing.expectEqualStrings("SQL wire input pointer is null", std.mem.span(error_message.?));
    ct_sql_wire_free(error_message);
    error_message = null;

    const truncated_postgres_row = [_]u8{ 0, 1, 0, 0, 0, 3, 'x' };
    var slices_pointer: ?[*]WireSlice = null;
    var slice_count: usize = 0;
    try std.testing.expectEqual(@as(c_int, -1), ct_sql_postgres_decode_data_row(
        &truncated_postgres_row,
        truncated_postgres_row.len,
        &slices_pointer,
        &slice_count,
        &error_message,
    ));
    try std.testing.expectEqualStrings("Truncated PostgreSQL data row value", std.mem.span(error_message.?));
    ct_sql_wire_free(error_message);
    error_message = null;

    const truncated_mysql_integer = [_]u8{ 0xfc, 1 };
    var integer: u64 = 0;
    var next_offset: usize = 0;
    var is_null: u8 = 0;
    try std.testing.expectEqual(@as(c_int, -1), ct_sql_mysql_read_length_encoded_integer(
        &truncated_mysql_integer,
        truncated_mysql_integer.len,
        0,
        &integer,
        &next_offset,
        &is_null,
        &error_message,
    ));
    try std.testing.expectEqualStrings("Truncated length-encoded integer", std.mem.span(error_message.?));
    ct_sql_wire_free(error_message);
    error_message = null;

    const truncated_mysql_row = [_]u8{ 3, 'x' };
    try std.testing.expectEqual(@as(c_int, -1), ct_sql_mysql_decode_row(
        &truncated_mysql_row,
        truncated_mysql_row.len,
        1,
        &slices_pointer,
        &slice_count,
        &error_message,
    ));
    try std.testing.expectEqualStrings("Truncated length-encoded string", std.mem.span(error_message.?));
    ct_sql_wire_free(error_message);
    error_message = null;

    const truncated_mysql_column = [_]u8{
        0,    0, 0, 0, 0, 0,
        0x0c, 0, 0, 0, 0, 0,
        0,    0, 0, 0,
    };
    var column: MySQLColumn = undefined;
    try std.testing.expectEqual(@as(c_int, -1), ct_sql_mysql_decode_column(
        &truncated_mysql_column,
        truncated_mysql_column.len,
        &column,
        &error_message,
    ));
    try std.testing.expectEqualStrings("Truncated MySQL column definition", std.mem.span(error_message.?));
    ct_sql_wire_free(error_message);
}
