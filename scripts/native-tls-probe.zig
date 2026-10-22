const std = @import("std");

// A transport probe compiled with the same standard library as the ICU downloader. Both HTTPS and the low-level TLS handshake are exercised by Node.
pub fn main(init: std.process.Init) !void {
    const a = init.arena.allocator();
    const args = try init.minimal.args.toSlice(a);
    if (args.len != 6) return error.Usage;
    const io = init.io;
    const port = try std.fmt.parseInt(u16, args[2], 10);
    const now = std.Io.Clock.real.now(io);
    var client: std.http.Client = .{ .allocator = a, .io = io, .now = now };
    defer client.deinit();
    try client.ca_bundle.addCertsFromFilePathAbsolute(a, io, now, args[3]);
    const result: anyerror!void = if (std.mem.eql(u8, args[1], "windows-chain")) windowsChain(&client) else if (std.mem.eql(u8, args[1], "http")) blk: {
        const url = try std.fmt.allocPrint(a, "https://{s}:{d}/", .{ args[5], port });
        var buffer: [64]u8 = undefined;
        var writer = std.Io.Writer.fixed(&buffer);
        const response = client.fetch(.{
            .location = .{ .url = url },
            .response_writer = &writer,
            .keep_alive = false,
        }) catch |err| break :blk err;
        if (response.status != .ok or !std.mem.eql(u8, writer.buffered(), "verified"))
            break :blk error.InvalidControlResponse;
        break :blk {};
    } else handshake(&client, port, args[5], std.mem.eql(u8, args[1], "insecure"));
    if (result) |_| {
        if (!std.mem.eql(u8, args[4], "accept")) return error.CompromisedCertificateAccepted;
    } else |err| {
        if (!std.mem.eql(u8, args[4], @errorName(err))) {
            std.debug.print("expected {s}, received {s}\n", .{ args[4], @errorName(err) });
            return error.UnexpectedCertificateResult;
        }
    }
}

fn windowsChain(client: *std.http.Client) !void {
    if (comptime @import("builtin").os.tag != .windows) return error.WindowsOnly;
    var chain: std.crypto.Certificate.Chain = .empty;
    defer chain.deinit();
    // This path deliberately bypasses the peer TLS parser: Crypt32 builds the
    // chain, then our policy must inspect the returned OS certificate contexts.
    try chain.addCert(client.ca_bundle.bytes.items);
    try chain.verify(client.now.?);
}

fn handshake(client: *std.http.Client, port: u16, hostname: []const u8, insecure: bool) !void {
    const io = client.io;
    const address: std.Io.net.IpAddress = .{ .ip4 = .loopback(port) };
    const stream = try address.connect(io, .{ .mode = .stream });
    defer stream.close(io);
    var socket_read: [std.crypto.tls.Client.min_buffer_len]u8 = undefined;
    var socket_write: [4096]u8 = undefined;
    var tls_read: [std.crypto.tls.Client.min_buffer_len]u8 = undefined;
    var tls_write: [std.crypto.tls.Client.min_buffer_len]u8 = undefined;
    var reader = stream.reader(io, &socket_read);
    var writer = stream.writer(io, &socket_write);
    var entropy: [std.crypto.tls.Client.Options.entropy_len]u8 = undefined;
    io.random(&entropy);
    _ = try std.crypto.tls.Client.init(&reader.interface, &writer.interface, .{
        .host = .{ .explicit = hostname },
        .ca = if (insecure) .no_verification else .{ .bundle = .{
            .gpa = client.allocator,
            .io = io,
            .lock = &client.ca_bundle_lock,
            .bundle = &client.ca_bundle,
        } },
        .read_buffer = &tls_read,
        .write_buffer = &tls_write,
        .entropy = &entropy,
        .realtime_now = client.now.?,
    });
}
