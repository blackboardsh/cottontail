const std = @import("std");
const builtin = @import("builtin");

pub const Error = std.mem.Allocator.Error || error{
    InvalidFileURL,
    InvalidFileURLHost,
    InvalidFileURLPath,
    NotFileURL,
};

pub fn isFileURL(specifier: []const u8) bool {
    return specifier.len >= "file:".len and
        std.ascii.eqlIgnoreCase(specifier[0.."file:".len], "file:");
}

/// Convert an absolute WHATWG-style file URL into a native filesystem path.
/// The compiler resolver and Cottontail's dynamic-import bridge both use this
/// function so compiler-resolved and runtime imports agree on URL decoding.
pub fn pathFromURLAlloc(allocator: std.mem.Allocator, specifier: []const u8) Error![]u8 {
    return pathFromURLAllocForPlatform(allocator, specifier, builtin.os.tag == .windows);
}

fn componentText(component: std.Uri.Component) []const u8 {
    return switch (component) {
        .raw, .percent_encoded => |text| text,
    };
}

fn hexValue(byte: u8) ?u8 {
    return switch (byte) {
        '0'...'9' => byte - '0',
        'a'...'f' => byte - 'a' + 10,
        'A'...'F' => byte - 'A' + 10,
        else => null,
    };
}

fn decodePathAlloc(
    allocator: std.mem.Allocator,
    encoded: []const u8,
    comptime is_windows: bool,
) Error![]u8 {
    var decoded_len = encoded.len;
    var index: usize = 0;
    while (index < encoded.len) {
        const byte = encoded[index];
        if (byte == 0) return error.InvalidFileURLPath;
        if (byte != '%') {
            index += 1;
            continue;
        }
        if (index + 2 >= encoded.len) return error.InvalidFileURLPath;
        const high = hexValue(encoded[index + 1]) orelse return error.InvalidFileURLPath;
        const low = hexValue(encoded[index + 2]) orelse return error.InvalidFileURLPath;
        const decoded = (high << 4) | low;
        if (decoded == 0 or decoded == '/' or (is_windows and decoded == '\\')) {
            return error.InvalidFileURLPath;
        }
        decoded_len -= 2;
        index += 3;
    }

    const output = try allocator.alloc(u8, decoded_len);
    errdefer allocator.free(output);
    var input_index: usize = 0;
    var output_index: usize = 0;
    while (input_index < encoded.len) {
        if (encoded[input_index] == '%') {
            const high = hexValue(encoded[input_index + 1]).?;
            const low = hexValue(encoded[input_index + 2]).?;
            output[output_index] = (high << 4) | low;
            input_index += 3;
        } else {
            output[output_index] = encoded[input_index];
            input_index += 1;
        }
        output_index += 1;
    }
    return output;
}

fn pathFromURLAllocForPlatform(
    allocator: std.mem.Allocator,
    specifier: []const u8,
    comptime is_windows: bool,
) Error![]u8 {
    if (!isFileURL(specifier)) return error.NotFileURL;

    const uri = std.Uri.parse(specifier) catch return error.InvalidFileURL;
    if (!std.ascii.eqlIgnoreCase(uri.scheme, "file") or
        uri.user != null or uri.password != null or uri.port != null)
    {
        return error.InvalidFileURL;
    }

    const host = if (uri.host) |component| componentText(component) else "";
    const is_localhost = host.len == 0 or std.ascii.eqlIgnoreCase(host, "localhost");
    if (!is_windows and !is_localhost) return error.InvalidFileURLHost;
    if (std.mem.indexOfAny(u8, host, "%/\\\x00") != null) return error.InvalidFileURLHost;

    const encoded_path = componentText(uri.path);
    const decoded_path = try decodePathAlloc(allocator, encoded_path, is_windows);
    if (decoded_path.len == 0 or decoded_path[0] != '/') {
        allocator.free(decoded_path);
        return error.InvalidFileURLPath;
    }
    if (!is_windows) return decoded_path;
    defer allocator.free(decoded_path);

    const local_path = if (is_localhost and decoded_path.len >= 3 and
        std.ascii.isAlphabetic(decoded_path[1]) and decoded_path[2] == ':')
        decoded_path[1..]
    else
        decoded_path;
    const prefix_len: usize = if (is_localhost) 0 else 2 + host.len;
    const output = try allocator.alloc(u8, prefix_len + local_path.len);
    if (!is_localhost) {
        output[0] = '\\';
        output[1] = '\\';
        @memcpy(output[2 .. 2 + host.len], host);
    }
    for (local_path, prefix_len..) |byte, output_index| {
        output[output_index] = if (byte == '/') '\\' else byte;
    }
    return output;
}

test "file URL to POSIX path" {
    const allocator = std.testing.allocator;

    const plain = try pathFromURLAllocForPlatform(allocator, "file:///tmp/example.ts", false);
    defer allocator.free(plain);
    try std.testing.expectEqualStrings("/tmp/example.ts", plain);

    const escaped = try pathFromURLAllocForPlatform(allocator, "FILE://localhost/tmp/a%20b-%E2%98%83.ts?raw#fragment", false);
    defer allocator.free(escaped);
    try std.testing.expectEqualStrings("/tmp/a b-\xE2\x98\x83.ts", escaped);
}

test "file URL rejects invalid POSIX paths and hosts" {
    const allocator = std.testing.allocator;
    try std.testing.expectError(error.InvalidFileURLHost, pathFromURLAllocForPlatform(allocator, "file://example.com/tmp/a.ts", false));
    try std.testing.expectError(error.InvalidFileURLPath, pathFromURLAllocForPlatform(allocator, "file:///tmp/a%2Fb.ts", false));
    try std.testing.expectError(error.InvalidFileURLPath, pathFromURLAllocForPlatform(allocator, "file:///tmp/a%ZZ.ts", false));
}

test "file URL to Windows path" {
    const allocator = std.testing.allocator;

    const drive = try pathFromURLAllocForPlatform(allocator, "file:///C:/Program%20Files/app.ts", true);
    defer allocator.free(drive);
    try std.testing.expectEqualStrings("C:\\Program Files\\app.ts", drive);

    const unc = try pathFromURLAllocForPlatform(allocator, "file://server/share/app.ts", true);
    defer allocator.free(unc);
    try std.testing.expectEqualStrings("\\\\server\\share\\app.ts", unc);
}
