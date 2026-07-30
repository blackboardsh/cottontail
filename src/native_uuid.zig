const std = @import("std");

pub const Slice = extern struct {
    ptr: ?[*]const u8,
    len: usize,

    fn bytes(self: Slice) []const u8 {
        return if (self.ptr) |ptr| ptr[0..self.len] else &.{};
    }
};

pub const Utf16Slice = extern struct {
    ptr: ?[*]const u16,
    len: usize,

    fn units(self: Utf16Slice) []const u16 {
        return if (self.ptr) |ptr| ptr[0..self.len] else &.{};
    }
};

const Encoding = enum(u8) {
    hex = 0,
    buffer = 1,
    base64 = 2,
    base64url = 3,
};

const uuid_v7_sequence_bits = 74;
const uuid_v7_sequence_mask = (@as(u128, 1) << uuid_v7_sequence_bits) - 1;

const V7SequenceState = struct {
    initialized: bool = false,
    timestamp: u64 = 0,
    sequence: u128 = 0,

    fn next(
        self: *V7SequenceState,
        timestamp: u64,
        entropy: ?*const [10]u8,
    ) u128 {
        if (!self.initialized or self.timestamp != timestamp) {
            self.initialized = true;
            self.timestamp = timestamp;
            self.sequence = sequenceFromEntropy(entropy.?);
        } else {
            self.sequence = (self.sequence + 1) & uuid_v7_sequence_mask;
        }
        return self.sequence;
    }
};

var uuid_v7_mutex: std.atomic.Mutex = .unlocked;
var uuid_v7_state: V7SequenceState = .{};

fn sequenceFromEntropy(entropy: *const [10]u8) u128 {
    var sequence: u128 = 0;
    for (entropy) |byte| {
        sequence = (sequence << 8) | byte;
    }
    return sequence & uuid_v7_sequence_mask;
}

fn nextV7Sequence(timestamp: u64) u128 {
    while (!uuid_v7_mutex.tryLock()) std.atomic.spinLoopHint();
    defer uuid_v7_mutex.unlock();

    if (!uuid_v7_state.initialized or uuid_v7_state.timestamp != timestamp) {
        var entropy: [10]u8 = undefined;
        std.Io.random(std.Io.Threaded.global_single_threaded.io(), &entropy);
        return uuid_v7_state.next(timestamp, &entropy);
    }
    return uuid_v7_state.next(timestamp, null);
}

fn writeV7(timestamp: u64, sequence: u128, output: *[16]u8) void {
    output[0] = @truncate(timestamp >> 40);
    output[1] = @truncate(timestamp >> 32);
    output[2] = @truncate(timestamp >> 24);
    output[3] = @truncate(timestamp >> 16);
    output[4] = @truncate(timestamp >> 8);
    output[5] = @truncate(timestamp);

    // UUIDv7 places 74 sequence bits around the fixed version and variant:
    // 12 rand_a bits followed by 62 rand_b bits.
    output[6] = 0x70 | @as(u8, @truncate(sequence >> 70));
    output[7] = @truncate(sequence >> 62);
    output[8] = 0x80 | (@as(u8, @truncate(sequence >> 56)) & 0x3f);
    output[9] = @truncate(sequence >> 48);
    output[10] = @truncate(sequence >> 40);
    output[11] = @truncate(sequence >> 32);
    output[12] = @truncate(sequence >> 24);
    output[13] = @truncate(sequence >> 16);
    output[14] = @truncate(sequence >> 8);
    output[15] = @truncate(sequence);
}

pub export fn ct_uuid_v7(timestamp: u64, output: *[16]u8) void {
    writeV7(timestamp, nextV7Sequence(timestamp), output);
}

pub export fn ct_uuid_v5(namespace_bytes: Slice, name: Slice, output: *[16]u8) void {
    var hasher = std.crypto.hash.Sha1.init(.{});
    hasher.update(namespace_bytes.bytes());
    hasher.update(name.bytes());
    finishV5(&hasher, output);
}

pub export fn ct_uuid_v5_utf16(
    namespace_bytes: Slice,
    name: Utf16Slice,
    output: *[16]u8,
) void {
    var hasher = std.crypto.hash.Sha1.init(.{});
    hasher.update(namespace_bytes.bytes());
    hashUtf16AsUtf8(&hasher, name.units());
    finishV5(&hasher, output);
}

fn finishV5(hasher: *std.crypto.hash.Sha1, output: *[16]u8) void {
    var digest: [std.crypto.hash.Sha1.digest_length]u8 = undefined;
    hasher.final(&digest);
    @memcpy(output, digest[0..16]);
    output[6] = (output[6] & 0x0f) | 0x50;
    output[8] = (output[8] & 0x3f) | 0x80;
}

fn hashUtf16AsUtf8(hasher: *std.crypto.hash.Sha1, units: []const u16) void {
    var chunk: [512]u8 = undefined;
    var used: usize = 0;
    var index: usize = 0;

    while (index < units.len) {
        var code_point: u21 = units[index];
        index += 1;
        if (code_point >= 0xd800 and code_point <= 0xdbff) {
            if (index < units.len and units[index] >= 0xdc00 and units[index] <= 0xdfff) {
                code_point = 0x10000 +
                    ((code_point - 0xd800) << 10) +
                    (units[index] - 0xdc00);
                index += 1;
            } else {
                code_point = 0xfffd;
            }
        } else if (code_point >= 0xdc00 and code_point <= 0xdfff) {
            code_point = 0xfffd;
        }

        if (used + 4 > chunk.len) {
            hasher.update(chunk[0..used]);
            used = 0;
        }
        used += std.unicode.utf8Encode(code_point, chunk[used..]) catch unreachable;
    }

    if (used > 0) hasher.update(chunk[0..used]);
}

const encoded_positions = [16]u8{
    0, 2, 4, 6, 9, 11, 14, 16, 19, 21, 24, 26, 28, 30, 32, 34,
};

fn formatHex(uuid: *const [16]u8, output: *[36]u8) void {
    const hex = "0123456789abcdef";
    output[8] = '-';
    output[13] = '-';
    output[18] = '-';
    output[23] = '-';
    inline for (encoded_positions, 0..) |position, index| {
        output[position] = hex[uuid[index] >> 4];
        output[position + 1] = hex[uuid[index] & 0x0f];
    }
}

pub export fn ct_uuid_format(
    encoding_value: u8,
    uuid: *const [16]u8,
    output: *[36]u8,
) usize {
    return switch (encoding_value) {
        @intFromEnum(Encoding.hex) => result: {
            formatHex(uuid, output);
            break :result 36;
        },
        @intFromEnum(Encoding.buffer) => result: {
            @memcpy(output[0..16], uuid);
            break :result 16;
        },
        @intFromEnum(Encoding.base64) => std.base64.standard.Encoder.encode(output, uuid).len,
        @intFromEnum(Encoding.base64url) => std.base64.url_safe_no_pad.Encoder.encode(output, uuid).len,
        else => 0,
    };
}

test "UUID v5 matches RFC vector" {
    const namespace = [_]u8{
        0x6b, 0xa7, 0xb8, 0x10, 0x9d, 0xad, 0x11, 0xd1,
        0x80, 0xb4, 0x00, 0xc0, 0x4f, 0xd4, 0x30, 0xc8,
    };
    var uuid: [16]u8 = undefined;
    ct_uuid_v5(
        .{ .ptr = &namespace, .len = namespace.len },
        .{ .ptr = "www.example.com", .len = "www.example.com".len },
        &uuid,
    );
    var text: [36]u8 = undefined;
    try std.testing.expectEqual(@as(usize, 36), ct_uuid_format(0, &uuid, &text));
    try std.testing.expectEqualStrings(
        "2ed6657d-e927-568b-95e1-2665a8aea6a2",
        &text,
    );
}

test "UUID v5 UTF-16 hashing replaces unpaired surrogates" {
    const namespace = [_]u8{
        0x6b, 0xa7, 0xb8, 0x10, 0x9d, 0xad, 0x11, 0xd1,
        0x80, 0xb4, 0x00, 0xc0, 0x4f, 0xd4, 0x30, 0xc8,
    };
    const name = [_]u16{ 0xd800 };
    var uuid: [16]u8 = undefined;
    ct_uuid_v5_utf16(
        .{ .ptr = &namespace, .len = namespace.len },
        .{ .ptr = &name, .len = name.len },
        &uuid,
    );
    var text: [36]u8 = undefined;
    _ = ct_uuid_format(0, &uuid, &text);
    try std.testing.expectEqualStrings(
        "67d0a96b-f0b9-5bb4-b673-a604fae2abbb",
        &text,
    );
}

test "UUID v7 maps all 74 sequence bits around version and variant" {
    var uuid: [16]u8 = undefined;
    writeV7(1_625_097_600_000, uuid_v7_sequence_mask, &uuid);

    try std.testing.expectEqualSlices(
        u8,
        &.{ 0x01, 0x7a, 0x5f, 0x5d, 0x7c, 0x00 },
        uuid[0..6],
    );
    try std.testing.expectEqualSlices(
        u8,
        &.{ 0x7f, 0xff, 0xbf, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff },
        uuid[6..16],
    );
}

test "UUID v7 sequence increments across fixed-field boundaries" {
    var before: [16]u8 = undefined;
    var after: [16]u8 = undefined;

    writeV7(42, (@as(u128, 1) << 56) - 1, &before);
    writeV7(42, @as(u128, 1) << 56, &after);
    try std.testing.expect(std.mem.order(u8, &before, &after) == .lt);
    try std.testing.expectEqual(@as(u8, 0x80), before[8]);
    try std.testing.expectEqual(@as(u8, 0x81), after[8]);

    writeV7(42, (@as(u128, 1) << 62) - 1, &before);
    writeV7(42, @as(u128, 1) << 62, &after);
    try std.testing.expect(std.mem.order(u8, &before, &after) == .lt);
    try std.testing.expectEqual(@as(u8, 0x00), before[7]);
    try std.testing.expectEqual(@as(u8, 0x01), after[7]);
}

test "UUID v7 sequence is seeded, reseeded by timestamp, and wraps at 74 bits" {
    const first_entropy = [_]u8{ 0xff, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0x01, 0x23 };
    const second_entropy = [_]u8{ 0x00, 0x02, 0x04, 0x06, 0x08, 0x0a, 0x0c, 0x0e, 0x10, 0x12 };
    var state: V7SequenceState = .{};

    const seeded = state.next(10, &first_entropy);
    try std.testing.expectEqual(sequenceFromEntropy(&first_entropy), seeded);
    try std.testing.expectEqual((seeded + 1) & uuid_v7_sequence_mask, state.next(10, null));
    try std.testing.expectEqual(sequenceFromEntropy(&second_entropy), state.next(11, &second_entropy));

    state.sequence = uuid_v7_sequence_mask - 1;
    try std.testing.expectEqual(uuid_v7_sequence_mask, state.next(11, null));
    try std.testing.expectEqual(@as(u128, 0), state.next(11, null));
}
