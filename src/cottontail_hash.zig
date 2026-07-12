const std = @import("std");

const RapidHash = struct {
    const secret = [3]u64{ 0x2d358dccaa6c78a5, 0x8bb84b93962eacc9, 0x4b33a62ed433d4a3 };

    fn mum(a: *u64, b: *u64) void {
        const result = @as(u128, a.*) * b.*;
        a.* = @truncate(result);
        b.* = @truncate(result >> 64);
    }

    fn mix(a: u64, b: u64) u64 {
        var left = a;
        var right = b;
        mum(&left, &right);
        return left ^ right;
    }

    fn read64(bytes: []const u8) u64 {
        return std.mem.readInt(u64, bytes[0..8], .little);
    }

    fn read32(bytes: []const u8) u64 {
        return std.mem.readInt(u32, bytes[0..4], .little);
    }

    fn hash(seed: u64, input: []const u8) u64 {
        const len = input.len;
        var a: u64 = 0;
        var b: u64 = 0;
        var remaining_input = input;
        var state = [3]u64{ seed, 0, 0 };
        state[0] ^= mix(seed ^ secret[0], secret[1]) ^ len;

        if (len <= 16) {
            if (len >= 4) {
                const offset = (len & 24) >> @intCast(len >> 3);
                const end = len - 4;
                a = (read32(remaining_input) << 32) | read32(remaining_input[end..]);
                b = (read32(remaining_input[offset..]) << 32) | read32(remaining_input[(end - offset)..]);
            } else if (len > 0) {
                a = (@as(u64, remaining_input[0]) << 56) | (@as(u64, remaining_input[len >> 1]) << 32) | remaining_input[len - 1];
            }
        } else {
            var remaining = len;
            if (len > 48) {
                state[1] = state[0];
                state[2] = state[0];
                while (remaining >= 96) {
                    inline for (0..6) |index| {
                        const first = read64(remaining_input[8 * index * 2 ..]);
                        const second = read64(remaining_input[8 * (index * 2 + 1) ..]);
                        state[index % 3] = mix(first ^ secret[index % 3], second ^ state[index % 3]);
                    }
                    remaining_input = remaining_input[96..];
                    remaining -= 96;
                }
                if (remaining >= 48) {
                    inline for (0..3) |index| {
                        const first = read64(remaining_input[8 * index * 2 ..]);
                        const second = read64(remaining_input[8 * (index * 2 + 1) ..]);
                        state[index] = mix(first ^ secret[index], second ^ state[index]);
                    }
                    remaining_input = remaining_input[48..];
                    remaining -= 48;
                }
                state[0] ^= state[1] ^ state[2];
            }
            if (remaining > 16) {
                state[0] = mix(read64(remaining_input) ^ secret[2], read64(remaining_input[8..]) ^ state[0] ^ secret[1]);
                if (remaining > 32) state[0] = mix(read64(remaining_input[16..]) ^ secret[2], read64(remaining_input[24..]) ^ state[0]);
            }
            a = read64(input[len - 16 ..]);
            b = read64(input[len - 8 ..]);
        }
        a ^= secret[1];
        b ^= state[0];
        mum(&a, &b);
        return mix(a ^ secret[0] ^ len, b ^ secret[1]);
    }
};

export fn ct_hash_value(algorithm: c_int, input_ptr: ?[*]const u8, input_len: usize, seed: u64) u64 {
    const input = if (input_ptr) |ptr| ptr[0..input_len] else "";
    return switch (algorithm) {
        0 => std.hash.Wyhash.hash(seed, input),
        1 => std.hash.Adler32.hash(input),
        2 => std.hash.Crc32.hash(input),
        3 => std.hash.CityHash32.hash(input),
        4 => std.hash.CityHash64.hashWithSeed(input, seed),
        5 => std.hash.XxHash32.hash(@truncate(seed), input),
        6 => std.hash.XxHash64.hash(seed, input),
        7 => std.hash.XxHash3.hash(@truncate(seed), input),
        8 => std.hash.Murmur3_32.hashWithSeed(input, @truncate(seed)),
        9 => std.hash.Murmur2_32.hashWithSeed(input, @truncate(seed)),
        10 => std.hash.Murmur2_64.hashWithSeed(input, seed),
        11 => RapidHash.hash(seed, input),
        else => 0,
    };
}

pub fn forceLink() void {
    _ = &ct_hash_value;
}
