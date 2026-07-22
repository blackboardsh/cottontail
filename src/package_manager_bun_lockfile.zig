const std = @import("std");
const compiler = @import("cottontail_compiler");

const BunLockfile = compiler.install.Lockfile;
const StandaloneOptions = struct {
    config_version: ?compiler.ConfigVersion,
    log_level: LogLevel = .silent,

    const LogLevel = enum {
        silent,

        pub fn isVerbose(_: LogLevel) bool {
            return false;
        }
    };
};
const binary_header = "#!/usr/bin/env bun\nbun-lockfile-format-v0\n";

pub fn isBinaryLockfile(bytes: []const u8) bool {
    return std.mem.startsWith(u8, bytes, binary_header);
}

pub fn textToBinary(allocator: std.mem.Allocator, text: []const u8) ![]u8 {
    return textToBinaryAtRoot(allocator, text, null, null);
}

pub fn migrateNpmToBinary(
    allocator: std.mem.Allocator,
    source_text: []const u8,
    source_path: []const u8,
    registry_url: []const u8,
) ![]u8 {
    const lockfile_allocator = compiler.z_allocator;
    var log = compiler.logger.Log.init(lockfile_allocator);
    defer deinitLog(&log, lockfile_allocator);

    var lockfile: BunLockfile = undefined;
    const result = try compiler.install.Migration.migrateNPMLockfileStandalone(
        &lockfile,
        lockfile_allocator,
        &log,
        source_text,
        source_path,
        registry_url,
    );
    switch (result) {
        .ok => {},
        .err => |failure| return failure.value,
        .not_found => return error.InvalidNPMLockfile,
    }
    defer lockfile.deinit();

    const options: StandaloneOptions = .{ .config_version = lockfile.saved_config_version };
    var bytes = std.Io.Writer.Allocating.init(allocator);
    errdefer bytes.deinit();
    var total_size: usize = 0;
    var end_pos: usize = 0;
    try BunLockfile.Serializer.save(&lockfile, &options, &bytes, &total_size, &end_pos);
    if (bytes.written().len < end_pos + @sizeOf(usize)) return error.InvalidBinaryLockfileBuffer;
    bytes.written()[end_pos..][0..@sizeOf(usize)].* = @bitCast(total_size);
    return bytes.toOwnedSlice();
}

pub fn writeTextMetaHash(
    allocator: std.mem.Allocator,
    text: []const u8,
    writer: *std.Io.Writer,
) !void {
    var arena: std.heap.ArenaAllocator = .init(allocator);
    defer arena.deinit();
    const lockfile_allocator = arena.allocator();
    var log = compiler.logger.Log.init(lockfile_allocator);
    defer deinitLog(&log, lockfile_allocator);

    const source = compiler.logger.Source.initPathString("bun.lock", text);
    compiler.install.initializeStore();
    const json = try compiler.json.parsePackageJSONUTF8(&source, &log, lockfile_allocator);
    var lockfile: BunLockfile = undefined;
    try compiler.install.TextLockfile.parseIntoBinaryLockfile(
        &lockfile,
        lockfile_allocator,
        json,
        &source,
        &log,
        null,
    );
    _ = try lockfile.hasMetaHashChanged(false, lockfile.packages.len);
    try writer.print("{f}", .{lockfile.fmtMetaHash()});
}

pub fn writeTextMetaHashString(
    allocator: std.mem.Allocator,
    text: []const u8,
    writer: *std.Io.Writer,
) !void {
    var arena: std.heap.ArenaAllocator = .init(allocator);
    defer arena.deinit();
    const lockfile_allocator = arena.allocator();
    var log = compiler.logger.Log.init(lockfile_allocator);
    defer deinitLog(&log, lockfile_allocator);

    const source = compiler.logger.Source.initPathString("bun.lock", text);
    compiler.install.initializeStore();
    const json = try compiler.json.parsePackageJSONUTF8(&source, &log, lockfile_allocator);
    var lockfile: BunLockfile = undefined;
    try compiler.install.TextLockfile.parseIntoBinaryLockfile(
        &lockfile,
        lockfile_allocator,
        json,
        &source,
        &log,
        null,
    );
    _ = try lockfile.generateMetaHashToWriter(writer, lockfile.packages.len);
}

pub fn writeBinaryMetaHash(
    allocator: std.mem.Allocator,
    binary: []const u8,
    writer: *std.Io.Writer,
) !void {
    var log = compiler.logger.Log.init(allocator);
    defer deinitLog(&log, allocator);

    const mutable = try allocator.dupe(u8, binary);
    var lockfile: BunLockfile = undefined;
    const load_result = lockfile.loadFromBytesStandalone(mutable, allocator, &log);
    switch (load_result) {
        .ok => {},
        .err => |failure| return failure.value,
        .not_found => return error.InvalidBinaryLockfile,
    }
    defer lockfile.deinit();
    _ = try lockfile.hasMetaHashChanged(false, lockfile.packages.len);
    try writer.print("{f}", .{lockfile.fmtMetaHash()});
}

pub fn writeBinaryMetaHashString(
    allocator: std.mem.Allocator,
    binary: []const u8,
    writer: *std.Io.Writer,
) !void {
    var log = compiler.logger.Log.init(allocator);
    defer deinitLog(&log, allocator);

    const mutable = try allocator.dupe(u8, binary);
    var lockfile: BunLockfile = undefined;
    const load_result = lockfile.loadFromBytesStandalone(mutable, allocator, &log);
    switch (load_result) {
        .ok => {},
        .err => |failure| return failure.value,
        .not_found => return error.InvalidBinaryLockfile,
    }
    defer lockfile.deinit();
    _ = try lockfile.generateMetaHashToWriter(writer, lockfile.packages.len);
}

pub fn textToBinaryAtRoot(
    allocator: std.mem.Allocator,
    text: []const u8,
    io: ?std.Io,
    root_dir: ?[]const u8,
) ![]u8 {
    // Serializer.save replaces packages with a zeroed clone allocated by Bun's
    // z_allocator. Keep the entire Lockfile on that allocator while allowing
    // the returned byte buffer to retain the caller's allocator ownership.
    const lockfile_allocator = compiler.z_allocator;
    var log = compiler.logger.Log.init(lockfile_allocator);
    defer deinitLog(&log, lockfile_allocator);

    const source = compiler.logger.Source.initPathString("bun.lock", text);
    compiler.install.initializeStore();
    const json = try compiler.json.parsePackageJSONUTF8(&source, &log, lockfile_allocator);

    var lockfile: BunLockfile = undefined;
    try compiler.install.TextLockfile.parseIntoBinaryLockfile(
        &lockfile,
        lockfile_allocator,
        json,
        &source,
        &log,
        null,
    );
    defer lockfile.deinit();

    if (lockfile.patched_dependencies.entries.len > 0) {
        const patch_io = io orelse return error.PatchRootRequired;
        const patch_root = root_dir orelse return error.PatchRootRequired;
        for (lockfile.patched_dependencies.values()) |*patched| {
            const relative_path = patched.path.slice(lockfile.buffers.string_bytes.items);
            const patch_path = if (std.fs.path.isAbsolute(relative_path))
                relative_path
            else
                try std.fs.path.join(lockfile_allocator, &.{ patch_root, relative_path });
            const contents = try std.Io.Dir.cwd().readFileAlloc(
                patch_io,
                patch_path,
                lockfile_allocator,
                .limited(256 * 1024 * 1024),
            );
            var hasher = compiler.Wyhash11.init(0);
            hasher.update(contents);
            patched.setPatchfileHash(hasher.final());
        }
    }

    const options: StandaloneOptions = .{ .config_version = lockfile.saved_config_version };

    var bytes = std.Io.Writer.Allocating.init(allocator);
    errdefer bytes.deinit();
    var total_size: usize = 0;
    var end_pos: usize = 0;
    try BunLockfile.Serializer.save(&lockfile, &options, &bytes, &total_size, &end_pos);
    if (bytes.written().len < end_pos + @sizeOf(usize)) return error.InvalidBinaryLockfileBuffer;
    bytes.written()[end_pos..][0..@sizeOf(usize)].* = @bitCast(total_size);
    return bytes.toOwnedSlice();
}

pub const BinaryText = struct {
    text: []u8,
    migrated_from_v2: bool,
};

pub fn binaryToText(allocator: std.mem.Allocator, binary: []const u8) ![]u8 {
    return (try binaryToTextWithMetadata(allocator, binary)).text;
}

pub fn binaryToTextWithMetadata(allocator: std.mem.Allocator, binary: []const u8) !BinaryText {
    var arena: std.heap.ArenaAllocator = .init(allocator);
    defer arena.deinit();
    const lockfile_allocator = arena.allocator();

    var log = compiler.logger.Log.init(lockfile_allocator);
    defer deinitLog(&log, lockfile_allocator);

    const mutable = try lockfile_allocator.dupe(u8, binary);
    var lockfile: BunLockfile = undefined;
    lockfile.initEmpty(lockfile_allocator);
    var load_result = lockfile.loadFromBytesStandalone(mutable, lockfile_allocator, &log);
    const migrated_from_v2 = switch (load_result) {
        .ok => |ok| ok.serializer_result.migrated_from_lockb_v2,
        .err => |failure| return failure.value,
        .not_found => return error.InvalidBinaryLockfile,
    };

    const options: StandaloneOptions = .{ .config_version = lockfile.saved_config_version };

    var output: std.Io.Writer.Allocating = .init(allocator);
    errdefer output.deinit();
    try compiler.install.TextLockfile.Stringifier.saveFromBinary(
        lockfile_allocator,
        &lockfile,
        &load_result,
        &options,
        &output.writer,
    );
    try output.writer.flush();
    return .{
        .text = try output.toOwnedSlice(),
        .migrated_from_v2 = migrated_from_v2,
    };
}

pub fn upgradeBinaryFormat(allocator: std.mem.Allocator, binary: []const u8) ![]u8 {
    var log = compiler.logger.Log.init(allocator);
    defer deinitLog(&log, allocator);

    const mutable = try allocator.dupe(u8, binary);
    var lockfile: BunLockfile = undefined;
    const load_result = lockfile.loadFromBytesStandalone(mutable, allocator, &log);
    switch (load_result) {
        .ok => |ok| if (!ok.serializer_result.migrated_from_lockb_v2) return error.BinaryLockfileDoesNotNeedMigration,
        .err => |failure| return failure.value,
        .not_found => return error.InvalidBinaryLockfile,
    }
    defer lockfile.deinit();

    const options: StandaloneOptions = .{ .config_version = lockfile.saved_config_version };
    var bytes = std.Io.Writer.Allocating.init(allocator);
    errdefer bytes.deinit();
    var total_size: usize = 0;
    var end_pos: usize = 0;
    try BunLockfile.Serializer.save(&lockfile, &options, &bytes, &total_size, &end_pos);
    if (bytes.written().len < end_pos + @sizeOf(usize)) return error.InvalidBinaryLockfileBuffer;
    bytes.written()[end_pos..][0..@sizeOf(usize)].* = @bitCast(total_size);
    return bytes.toOwnedSlice();
}

pub fn updateBinaryTrustedDependencies(
    allocator: std.mem.Allocator,
    binary: []const u8,
    trusted_names: []const []const u8,
) ![]u8 {
    const lockfile_allocator = compiler.z_allocator;
    var log = compiler.logger.Log.init(lockfile_allocator);
    defer deinitLog(&log, lockfile_allocator);

    const mutable = try lockfile_allocator.dupe(u8, binary);
    defer lockfile_allocator.free(mutable);
    var lockfile: BunLockfile = undefined;
    const load_result = lockfile.loadFromBytesStandalone(mutable, lockfile_allocator, &log);
    switch (load_result) {
        .ok => {},
        .err => |failure| return failure.value,
        .not_found => return error.InvalidBinaryLockfile,
    }
    defer lockfile.deinit();

    if (lockfile.trusted_dependencies) |*trusted| trusted.deinit(lockfile_allocator);
    lockfile.trusted_dependencies = .{};
    try lockfile.trusted_dependencies.?.ensureTotalCapacity(lockfile_allocator, trusted_names.len);
    for (trusted_names) |name| {
        lockfile.trusted_dependencies.?.putAssumeCapacity(
            @truncate(compiler.Semver.String.Builder.stringHash(name)),
            {},
        );
    }

    const options: StandaloneOptions = .{ .config_version = lockfile.saved_config_version };
    var bytes = std.Io.Writer.Allocating.init(allocator);
    errdefer bytes.deinit();
    var total_size: usize = 0;
    var end_pos: usize = 0;
    try BunLockfile.Serializer.save(&lockfile, &options, &bytes, &total_size, &end_pos);
    if (bytes.written().len < end_pos + @sizeOf(usize)) return error.InvalidBinaryLockfileBuffer;
    bytes.written()[end_pos..][0..@sizeOf(usize)].* = @bitCast(total_size);
    return bytes.toOwnedSlice();
}

pub fn writeYarnFromBinary(allocator: std.mem.Allocator, binary: []const u8, writer: *std.Io.Writer) !void {
    var log = compiler.logger.Log.init(allocator);
    defer deinitLog(&log, allocator);

    const mutable = try allocator.dupe(u8, binary);
    var lockfile: BunLockfile = undefined;
    const load_result = lockfile.loadFromBytesStandalone(mutable, allocator, &log);
    switch (load_result) {
        .ok => {},
        .err => |failure| return failure.value,
        .not_found => return error.InvalidBinaryLockfile,
    }
    defer lockfile.deinit();

    var view = struct { lockfile: *BunLockfile }{ .lockfile = &lockfile };
    try compiler.install.YarnLockfilePrinter.print(&view, *std.Io.Writer, writer);
}

pub fn writeYarnFromText(allocator: std.mem.Allocator, text: []const u8, writer: *std.Io.Writer) !void {
    var arena: std.heap.ArenaAllocator = .init(allocator);
    defer arena.deinit();
    const lockfile_allocator = arena.allocator();
    var log = compiler.logger.Log.init(lockfile_allocator);
    defer deinitLog(&log, lockfile_allocator);

    const source = compiler.logger.Source.initPathString("bun.lock", text);
    compiler.install.initializeStore();
    const json = try compiler.json.parsePackageJSONUTF8(&source, &log, lockfile_allocator);
    var lockfile: BunLockfile = undefined;
    try compiler.install.TextLockfile.parseIntoBinaryLockfile(
        &lockfile,
        lockfile_allocator,
        json,
        &source,
        &log,
        null,
    );
    defer lockfile.deinit();

    var view = struct { lockfile: *BunLockfile }{ .lockfile = &lockfile };
    try compiler.install.YarnLockfilePrinter.print(&view, *std.Io.Writer, writer);
}

fn deinitLog(log: *compiler.logger.Log, allocator: std.mem.Allocator) void {
    _ = allocator;
    log.deinit();
}

test "Bun binary lockfile round trip uses the vendored serializer" {
    const allocator = std.testing.allocator;
    const text =
        \\{
        \\  "lockfileVersion": 1,
        \\  "configVersion": 1,
        \\  "workspaces": {
        \\    "": {
        \\      "name": "round-trip",
        \\      "dependencies": {
        \\        "no-deps": "1.0.0",
        \\      },
        \\    },
        \\  },
        \\  "packages": {
        \\    "no-deps": ["no-deps@1.0.0", "https://registry.example/no-deps.tgz", {}, "sha512-test"],
        \\  }
        \\}
    ;
    const binary = try textToBinary(allocator, text);
    defer allocator.free(binary);
    try std.testing.expect(std.mem.startsWith(u8, binary, "#!/usr/bin/env bun\nbun-lockfile-format-v0\n"));

    const restored = try binaryToText(allocator, binary);
    defer allocator.free(restored);
    try std.testing.expect(std.mem.indexOf(u8, restored, "\"configVersion\": 1") != null);
    try std.testing.expect(std.mem.indexOf(u8, restored, "\"no-deps@1.0.0\"") != null);

    var hash_output: std.Io.Writer.Allocating = .init(allocator);
    defer hash_output.deinit();
    try writeTextMetaHash(allocator, text, &hash_output.writer);
    try std.testing.expectEqualStrings(
        "3F296CFD62CDE82E-c5b05d496e93f30d-0720DF6CAF175FD2-aee4fb8089a37d9a",
        hash_output.written(),
    );
}
