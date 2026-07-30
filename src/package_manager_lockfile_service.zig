const std = @import("std");
const Lockfile = @import("package_manager_bun_lockfile.zig");

const max_lockfile_bytes = 512 * 1024 * 1024;

pub fn run(
    init: std.process.Init,
    args: []const [:0]const u8,
    stdout: *std.Io.Writer,
    stderr: *std.Io.Writer,
) !u8 {
    if (args.len < 2) {
        try stderr.writeAll("cottontail: lockfile service requires an operation and input path\n");
        return 1;
    }

    const allocator = init.arena.allocator();
    const operation: []const u8 = args[0];
    const input_path: []const u8 = args[1];
    const input = try std.Io.Dir.cwd().readFileAlloc(
        init.io,
        input_path,
        allocator,
        .limited(max_lockfile_bytes),
    );

    if (std.mem.eql(u8, operation, "text-to-binary")) {
        const root_dir: ?[]const u8 = if (args.len > 2) args[2] else null;
        const output = try Lockfile.textToBinaryAtRoot(
            allocator,
            input,
            if (root_dir == null) null else init.io,
            root_dir,
        );
        try stdout.writeAll(output);
        return 0;
    }
    if (std.mem.eql(u8, operation, "npm-to-binary")) {
        if (args.len < 3) return usageError(stderr, "npm-to-binary requires a registry URL");
        const source_path: []const u8 = if (args.len > 3) args[3] else input_path;
        const output = try Lockfile.migrateNpmToBinary(
            allocator,
            input,
            source_path,
            args[2],
        );
        try stdout.writeAll(output);
        return 0;
    }
    if (std.mem.eql(u8, operation, "text-meta-hash")) {
        try Lockfile.writeTextMetaHash(allocator, input, stdout);
        return 0;
    }
    if (std.mem.eql(u8, operation, "text-meta-hash-string")) {
        try Lockfile.writeTextMetaHashString(allocator, input, stdout);
        return 0;
    }
    if (std.mem.eql(u8, operation, "binary-meta-hash")) {
        try Lockfile.writeBinaryMetaHash(allocator, input, stdout);
        return 0;
    }
    if (std.mem.eql(u8, operation, "binary-meta-hash-string")) {
        try Lockfile.writeBinaryMetaHashString(allocator, input, stdout);
        return 0;
    }
    if (std.mem.eql(u8, operation, "binary-to-text")) {
        const output = try Lockfile.binaryToText(allocator, input);
        try stdout.writeAll(output);
        return 0;
    }
    if (std.mem.eql(u8, operation, "binary-to-text-metadata")) {
        var converted = try Lockfile.binaryToTextWithMetadata(allocator, input);
        defer converted.deinit(allocator);
        const metadata = .{
            .migrated_from_v2 = converted.migrated_from_v2,
            .trusted_dependency_hashes = converted.trusted_dependency_hashes,
            .lifecycle_scripts = converted.lifecycle_scripts,
        };
        const metadata_json = try std.json.Stringify.valueAlloc(allocator, metadata, .{});
        var length: [8]u8 = undefined;
        std.mem.writeInt(u64, &length, metadata_json.len, .little);
        try stdout.writeAll(&length);
        try stdout.writeAll(metadata_json);
        try stdout.writeAll(converted.text);
        return 0;
    }
    if (std.mem.eql(u8, operation, "upgrade-binary")) {
        const output = try Lockfile.upgradeBinaryFormat(allocator, input);
        try stdout.writeAll(output);
        return 0;
    }
    if (std.mem.eql(u8, operation, "update-trusted")) {
        const names = try allocator.alloc([]const u8, args.len - 2);
        for (args[2..], 0..) |name, index| names[index] = name;
        const output = try Lockfile.updateBinaryTrustedDependencies(
            allocator,
            input,
            names,
        );
        try stdout.writeAll(output);
        return 0;
    }
    if (std.mem.eql(u8, operation, "yarn-from-binary")) {
        try Lockfile.writeYarnFromBinary(allocator, input, stdout);
        return 0;
    }
    if (std.mem.eql(u8, operation, "yarn-from-text")) {
        try Lockfile.writeYarnFromText(allocator, input, stdout);
        return 0;
    }
    if (std.mem.eql(u8, operation, "package-url")) {
        if (args.len < 3) return usageError(stderr, "package-url requires a package name");
        if (try Lockfile.packageResolutionURLFromBinary(allocator, input, args[2])) |url| {
            try stdout.writeAll(url);
        }
        return 0;
    }

    try stderr.print("cottontail: unknown lockfile service operation: {s}\n", .{operation});
    return 1;
}

fn usageError(stderr: *std.Io.Writer, message: []const u8) !u8 {
    try stderr.print("cottontail: {s}\n", .{message});
    return 1;
}
