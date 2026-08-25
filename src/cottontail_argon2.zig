const std = @import("std");
const host = @import("host.zig");

const allocator = std.heap.c_allocator;
const argon2 = std.crypto.pwhash.argon2;

fn setError(error_out: *?[*:0]u8, err: anyerror) void {
    error_out.* = std.fmt.allocPrintSentinel(allocator, "Password operation failed: {s}", .{@errorName(err)}, 0) catch null;
}

fn requiredBytes(ptr: ?[*]const u8, len: usize) ?[]const u8 {
    if (ptr) |bytes| return bytes[0..len];
    return if (len == 0) "" else null;
}

fn optionalBytes(ptr: ?[*]const u8, len: usize) ?[]const u8 {
    if (ptr) |bytes| return bytes[0..len];
    return null;
}

export fn ct_crypto_argon2(
    algorithm: c_int,
    message_ptr: ?[*]const u8,
    message_len: usize,
    nonce_ptr: ?[*]const u8,
    nonce_len: usize,
    parallelism: u32,
    memory: u32,
    passes: u32,
    secret_ptr: ?[*]const u8,
    secret_len: usize,
    associated_data_ptr: ?[*]const u8,
    associated_data_len: usize,
    output_ptr: ?[*]u8,
    output_len: usize,
    error_out: *?[*:0]u8,
) c_int {
    error_out.* = null;
    const message = requiredBytes(message_ptr, message_len) orelse {
        setError(error_out, error.InvalidMessage);
        return -1;
    };
    const nonce = requiredBytes(nonce_ptr, nonce_len) orelse {
        setError(error_out, error.InvalidNonce);
        return -1;
    };
    const output = if (output_ptr) |ptr| ptr[0..output_len] else {
        setError(error_out, error.InvalidOutput);
        return -1;
    };
    const lanes = std.math.cast(u24, parallelism) orelse {
        setError(error_out, error.InvalidParallelism);
        return -1;
    };
    const mode: argon2.Mode = switch (algorithm) {
        0 => .argon2d,
        1 => .argon2i,
        2 => .argon2id,
        else => {
            setError(error_out, error.UnsupportedAlgorithm);
            return -1;
        },
    };
    argon2.kdf(allocator, output, message, nonce, .{
        .t = passes,
        .m = memory,
        .p = lanes,
        .secret = optionalBytes(secret_ptr, secret_len),
        .ad = optionalBytes(associated_data_ptr, associated_data_len),
    }, mode, host.getIo()) catch |err| {
        setError(error_out, err);
        return -1;
    };
    return 0;
}

pub fn forceLink() void {
    _ = &ct_crypto_argon2;
}
