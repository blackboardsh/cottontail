const std = @import("std");

const bun_compat_version = "1.3.10";
const release_path = "/repos/Jarred-Sumner/bun-releases-for-updater/releases/latest";
const max_release_metadata_bytes = 1024 * 1024;

const HttpResponse = struct {
    status: u16,
    body: []const u8,
};

pub fn run(
    init: std.process.Init,
    args: []const [:0]const u8,
    stdout: *std.Io.Writer,
    stderr: *std.Io.Writer,
) !u8 {
    for (args[2..]) |arg| {
        if (!std.mem.startsWith(u8, arg, "--")) {
            try stderr.writeAll("error: This command updates Bun itself, and does not take package names.\n");
            try stderr.writeAll("note: Use `bun update");
            for (args[2..]) |update_arg| try stderr.print(" {s}", .{update_arg});
            try stderr.writeAll("` instead.\n");
            try stderr.flush();
            return 1;
        }
    }

    if (hasFlag(args, "--help") or hasFlag(args, "-h")) {
        try stdout.writeAll(
            \\Usage: bun upgrade [flags]
            \\
            \\  --canary   Upgrade to the latest canary build
            \\  --stable   Upgrade to the latest stable build
            \\  --profile  Upgrade to a profiling build
            \\
        );
        try stdout.flush();
        return 0;
    }

    const tag = fetchLatestTag(init) catch |err| {
        try stderr.print("Bun upgrade failed with error: {s}\n", .{@errorName(err)});
        try stderr.flush();
        return 1;
    } orelse return 0;

    const current_tag = "bun-v" ++ bun_compat_version;
    if (std.mem.eql(u8, tag, current_tag)) {
        try stderr.print(
            "Congrats! You're already on the latest version of Bun (which is v{s})\n",
            .{bun_compat_version},
        );
        try stderr.flush();
        return 0;
    }

    try stderr.print("Bun {s} is available.\n", .{tag});
    try stderr.flush();
    return 0;
}

fn hasFlag(args: []const [:0]const u8, flag: []const u8) bool {
    for (args[2..]) |arg| {
        if (std.mem.eql(u8, arg, flag)) return true;
    }
    return false;
}

fn fetchLatestTag(init: std.process.Init) !?[]const u8 {
    const allocator = init.arena.allocator();
    const domain = init.environ_map.get("GITHUB_API_DOMAIN") orelse "api.github.com";
    const url_text = try std.fmt.allocPrint(
        allocator,
        "https://{s}{s}",
        .{ domain, release_path },
    );
    const uri = try std.Uri.parse(url_text);
    const reject_unauthorized = tlsRejectUnauthorized(init.environ_map);
    const response = if (reject_unauthorized)
        try fetchVerified(init, allocator, url_text)
    else
        try fetchInsecure(init, allocator, uri);

    switch (response.status) {
        200 => {},
        404 => return error.HTTP404,
        403 => return error.HTTPForbidden,
        429 => return error.HTTPTooManyRequests,
        499...599 => return error.GitHubIsDown,
        else => return error.HTTPError,
    }

    const metadata = std.json.parseFromSliceLeaky(
        std.json.Value,
        allocator,
        response.body,
        .{},
    ) catch return error.InvalidReleaseMetadata;
    if (metadata != .object) return error.InvalidReleaseMetadata;
    const tag = metadata.object.get("tag_name") orelse return error.InvalidReleaseMetadata;
    if (tag != .string or tag.string.len == 0) return error.InvalidReleaseMetadata;
    return tag.string;
}

fn tlsRejectUnauthorized(environment: *const std.process.Environ.Map) bool {
    const value = environment.get("NODE_TLS_REJECT_UNAUTHORIZED") orelse return true;
    return !std.mem.eql(u8, value, "0") and !std.mem.eql(u8, value, "false");
}

fn fetchVerified(
    init: std.process.Init,
    allocator: std.mem.Allocator,
    url: []const u8,
) !HttpResponse {
    var client: std.http.Client = .{ .allocator = allocator, .io = init.io };
    defer client.deinit();
    client.initDefaultProxies(allocator, init.environ_map) catch {};

    var headers = std.array_list.Managed(std.http.Header).init(allocator);
    try appendGitHubHeaders(&headers, init.environ_map);

    var output: std.Io.Writer.Allocating = .init(allocator);
    const result = try client.fetch(.{
        .location = .{ .url = url },
        .response_writer = &output.writer,
        .extra_headers = headers.items,
    });
    if (output.written().len > max_release_metadata_bytes) return error.ResponseTooLarge;
    return .{
        .status = @intFromEnum(result.status),
        .body = try output.toOwnedSlice(),
    };
}

fn fetchInsecure(
    init: std.process.Init,
    allocator: std.mem.Allocator,
    uri: std.Uri,
) !HttpResponse {
    var host_buffer: [std.Io.net.HostName.max_len]u8 = undefined;
    const host = try uri.getHost(&host_buffer);
    var stream = try host.connect(init.io, uri.port orelse 443, .{ .mode = .stream });
    defer stream.close(init.io);

    const tls_buffer_len = std.crypto.tls.Client.min_buffer_len;
    var encrypted_read_buffer: [tls_buffer_len]u8 = undefined;
    var encrypted_write_buffer: [tls_buffer_len]u8 = undefined;
    var cleartext_read_buffer: [tls_buffer_len + 8192]u8 = undefined;
    var cleartext_write_buffer: [1024]u8 = undefined;
    var stream_reader = stream.reader(init.io, &encrypted_read_buffer);
    var stream_writer = stream.writer(init.io, &encrypted_write_buffer);
    var entropy: [std.crypto.tls.Client.Options.entropy_len]u8 = undefined;
    init.io.random(&entropy);

    var tls = try std.crypto.tls.Client.init(
        &stream_reader.interface,
        &stream_writer.interface,
        .{
            .host = .no_verification,
            .ca = .no_verification,
            .read_buffer = &cleartext_read_buffer,
            .write_buffer = &cleartext_write_buffer,
            .entropy = &entropy,
            .realtime_now = std.Io.Clock.real.now(init.io),
            .allow_truncation_attacks = true,
        },
    );
    defer {
        tls.end() catch {};
        stream_writer.interface.flush() catch {};
    }

    try tls.writer.writeAll("GET ");
    try uri.writeToStream(&tls.writer, .{ .path = true, .query = true });
    try tls.writer.writeAll(" HTTP/1.1\r\nhost: ");
    try uri.writeToStream(&tls.writer, .{ .authority = true });
    try tls.writer.writeAll(
        "\r\naccept: application/vnd.github.v3+json" ++
            "\r\nuser-agent: Bun/1.3.10" ++
            "\r\nconnection: close\r\n",
    );
    if (init.environ_map.get("GITHUB_TOKEN") orelse init.environ_map.get("GITHUB_ACCESS_TOKEN")) |token| {
        if (token.len > 0) try tls.writer.print("authorization: Bearer {s}\r\n", .{token});
    }
    try tls.writer.writeAll("\r\n");
    try tls.writer.flush();
    try stream_writer.interface.flush();

    var http_reader: std.http.Reader = .{
        .in = &tls.reader,
        .interface = undefined,
        .state = .ready,
        .max_head_len = 8192,
    };
    const head_bytes = try http_reader.receiveHead();
    const head = try std.http.Client.Response.Head.parse(head_bytes);
    const status: u16 = @intFromEnum(head.status);
    var transfer_buffer: [64]u8 = undefined;
    const body_reader = http_reader.bodyReader(&transfer_buffer, head.transfer_encoding, head.content_length);
    var limited = body_reader.limited(.limited(max_release_metadata_bytes + 1), &.{});
    var json_reader = std.json.Reader.init(allocator, &limited.interface);
    defer json_reader.deinit();
    const metadata = try std.json.Value.jsonParse(allocator, &json_reader, .{
        .max_value_len = max_release_metadata_bytes,
    });
    var output: std.Io.Writer.Allocating = .init(allocator);
    try std.json.Stringify.value(metadata, .{}, &output.writer);
    if (output.written().len > max_release_metadata_bytes) return error.ResponseTooLarge;
    return .{ .status = status, .body = try output.toOwnedSlice() };
}

fn appendGitHubHeaders(
    headers: *std.array_list.Managed(std.http.Header),
    environment: *const std.process.Environ.Map,
) !void {
    try headers.append(.{ .name = "accept", .value = "application/vnd.github.v3+json" });
    try headers.append(.{ .name = "user-agent", .value = "Bun/1.3.10" });
    if (environment.get("GITHUB_TOKEN") orelse environment.get("GITHUB_ACCESS_TOKEN")) |token| {
        if (token.len > 0) {
            try headers.append(.{
                .name = "authorization",
                .value = try std.fmt.allocPrint(headers.allocator, "Bearer {s}", .{token}),
            });
        }
    }
}
