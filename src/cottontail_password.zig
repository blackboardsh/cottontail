const std = @import("std");
const host = @import("host.zig");

const allocator = std.heap.c_allocator;
const argon2 = std.crypto.pwhash.argon2;
const bcrypt = std.crypto.pwhash.bcrypt;

fn setError(error_out: *?[*:0]u8, err: anyerror) void {
    error_out.* = std.fmt.allocPrintSentinel(allocator, "Password operation failed: {s}", .{@errorName(err)}, 0) catch null;
}

fn bcryptPassword(password: []const u8, digest: *[std.crypto.hash.sha2.Sha512.digest_length]u8) []const u8 {
    if (password.len <= 72) return password;
    std.crypto.hash.sha2.Sha512.hash(password, digest, .{});
    return digest;
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

export fn ct_password_hash(
    algorithm: c_int,
    password_ptr: ?[*]const u8,
    password_len: usize,
    time_cost: u32,
    memory_cost: u32,
    bcrypt_cost: u8,
    out_len: *usize,
    error_out: *?[*:0]u8,
) ?[*]u8 {
    out_len.* = 0;
    error_out.* = null;
    const password = if (password_ptr) |ptr| ptr[0..password_len] else "";
    var out_buffer: [4096]u8 = undefined;
    var digest: [std.crypto.hash.sha2.Sha512.digest_length]u8 = undefined;

    const encoded = switch (algorithm) {
        0, 1, 2 => argon2.strHash(password, .{
            .allocator = allocator,
            .params = .{ .t = time_cost, .m = memory_cost, .p = 1 },
            .mode = switch (algorithm) {
                0 => .argon2id,
                1 => .argon2i,
                2 => .argon2d,
                else => unreachable,
            },
            .encoding = .phc,
        }, &out_buffer, host.getIo()),
        3 => bcrypt.strHash(bcryptPassword(password, &digest), .{
            .params = .{ .rounds_log = @intCast(bcrypt_cost), .silently_truncate_password = true },
            .allocator = allocator,
            .encoding = .crypt,
        }, &out_buffer, host.getIo()),
        else => {
            setError(error_out, error.UnsupportedAlgorithm);
            return null;
        },
    } catch |err| {
        setError(error_out, err);
        return null;
    };

    const result = allocator.dupe(u8, encoded) catch |err| {
        setError(error_out, err);
        return null;
    };
    out_len.* = result.len;
    return result.ptr;
}

export fn ct_password_verify(
    algorithm: c_int,
    password_ptr: ?[*]const u8,
    password_len: usize,
    hash_ptr: ?[*]const u8,
    hash_len: usize,
    error_out: *?[*:0]u8,
) c_int {
    error_out.* = null;
    const password = if (password_ptr) |ptr| ptr[0..password_len] else "";
    const encoded = if (hash_ptr) |ptr| ptr[0..hash_len] else "";
    var digest: [std.crypto.hash.sha2.Sha512.digest_length]u8 = undefined;

    const result = switch (algorithm) {
        0, 1, 2 => argon2.strVerify(encoded, password, .{ .allocator = allocator }, host.getIo()),
        3 => bcrypt.strVerify(encoded, bcryptPassword(password, &digest), .{
            .allocator = allocator,
            .silently_truncate_password = true,
        }),
        else => error.UnsupportedAlgorithm,
    };
    result catch |err| switch (err) {
        error.PasswordVerificationFailed => return 0,
        else => {
            setError(error_out, err);
            return -1;
        },
    };
    return 1;
}

pub fn forceLink() void {
    _ = &ct_crypto_argon2;
    _ = &ct_password_hash;
    _ = &ct_password_verify;
}
