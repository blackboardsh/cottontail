const std = @import("std");
const builtin = @import("builtin");
const Pack = @import("package_manager_pack.zig");
const Scripts = @import("package_manager_scripts.zig");

const Value = std.json.Value;
const max_package_json_bytes = 16 * 1024 * 1024;
const max_tarball_bytes = 512 * 1024 * 1024;
const max_response_bytes = 64 * 1024 * 1024;

pub const Access = enum {
    public,
    restricted,

    pub fn parse(value: []const u8) ?Access {
        if (std.mem.eql(u8, value, "public")) return .public;
        if (std.mem.eql(u8, value, "restricted")) return .restricted;
        return null;
    }
};

pub const AuthType = enum {
    legacy,
    web,

    pub fn parse(value: []const u8) ?AuthType {
        if (std.mem.eql(u8, value, "legacy")) return .legacy;
        if (std.mem.eql(u8, value, "web")) return .web;
        return null;
    }
};

pub const Options = struct {
    access: ?Access = null,
    tag: []const u8 = "",
    otp: []const u8 = "",
    auth_type: ?AuthType = null,
    tolerate_republish: bool = false,
    dry_run: bool = false,
    ignore_scripts: bool = false,
    quiet: bool = false,
    gzip_level: ?[]const u8 = null,
};

pub const Registry = struct {
    url: []const u8,
    authorization: ?[]const u8 = null,
};

pub const RegistryRequestOptions = struct {
    auth_type: ?AuthType = null,
    npm_command: []const u8 = "publish",
    uses_workspaces: bool = false,
};

pub const RegistryResponse = struct {
    status: u16,
    body: []const u8,
    www_authenticate: ?[]const u8 = null,
    npm_notice: ?[]const u8 = null,
    retry_after: ?[]const u8 = null,
    x_local_cache: bool = false,
};

pub const AuthenticatedResponse = struct {
    response: RegistryResponse,
    otp_retry: bool = false,
};

pub const Readme = struct {
    filename: []const u8,
    contents: []const u8,
};

pub const PreparedPackage = struct {
    package_name: []const u8,
    package_version: []const u8,
    manifest: Value,
    tarball: []const u8,
    archive_paths: []const []const u8,
    readme: ?Readme,
    total_files: usize,
    unpacked_size: usize,
    bundled_count: usize = 0,
    uses_workspaces: bool = false,
    package_dir: ?[]const u8 = null,
    from_workspace: bool = false,
};

pub fn prepareWorkspace(
    init: std.process.Init,
    project_root: []const u8,
    package_dir: []const u8,
    options: *Options,
    stdout: *std.Io.Writer,
    stderr: *std.Io.Writer,
) !PreparedPackage {
    const allocator = init.arena.allocator();
    const package_json_path = try std.fs.path.join(allocator, &.{ package_dir, "package.json" });
    const initial = try readManifest(init.io, allocator, package_json_path);
    try applyPublishConfig(options, &initial);
    if (options.tag.len > 0) try validateDistTag(options.tag);
    _ = try validateManifest(&initial, options.access);

    if (!options.ignore_scripts) {
        try Scripts.runPackStage(init, package_dir, &initial, "prepublishOnly", options.quiet, stderr);
        try Scripts.runPackStage(init, package_dir, &initial, "prepack", options.quiet, stderr);
        try Scripts.runPackStage(init, package_dir, &initial, "prepare", options.quiet, stderr);
    }

    const built = try Pack.build(
        init,
        project_root,
        package_dir,
        .{ .gzip_level = options.gzip_level, .create_tarball = !options.dry_run },
        stderr,
    );
    try applyPublishConfig(options, &built.manifest.value);
    if (options.tag.len > 0) try validateDistTag(options.tag);
    const identity = try validateManifest(&built.manifest.value, options.access);

    if (!options.quiet) {
        try Pack.printEntries(stdout, built.entries);
        try stdout.writeByte('\n');
        try Pack.printSummary(stdout, built, allocator);
        try stdout.flush();
    }

    if (!options.ignore_scripts) {
        if (!options.quiet and hasScript(&built.manifest.value, "postpack")) {
            try stdout.writeByte('\n');
            try stdout.flush();
        }
        try Scripts.runPackStage(init, package_dir, &built.manifest.value, "postpack", options.quiet, stderr);
    }

    const paths = try allocator.alloc([]const u8, built.entries.len);
    var readme: ?Readme = null;
    for (built.entries, 0..) |entry, index| {
        paths[index] = entry.path;
        if (readme == null and isRootReadme(entry.path)) {
            readme = .{ .filename = entry.path, .contents = entry.contents };
        }
    }

    return .{
        .package_name = identity.name,
        .package_version = identity.version,
        .manifest = built.manifest.value,
        .tarball = built.tarball orelse "",
        .archive_paths = paths,
        .readme = readme,
        .total_files = built.entries.len,
        .unpacked_size = built.unpacked_size,
        .bundled_count = built.bundled_count,
        .uses_workspaces = built.uses_workspaces,
        .package_dir = package_dir,
        .from_workspace = true,
    };
}

pub fn prepareTarball(
    init: std.process.Init,
    tarball_path: []const u8,
    options: *Options,
    stdout: *std.Io.Writer,
) !PreparedPackage {
    const allocator = init.arena.allocator();
    const absolute_path = if (std.fs.path.isAbsolute(tarball_path))
        try allocator.dupe(u8, tarball_path)
    else
        try std.fs.path.resolve(allocator, &.{tarball_path});
    const tarball = try std.Io.Dir.cwd().readFileAlloc(
        init.io,
        absolute_path,
        allocator,
        .limited(max_tarball_bytes),
    );

    var compressed_reader: std.Io.Reader = .fixed(tarball);
    var decompression_buffer: [std.compress.flate.max_window_len]u8 = undefined;
    var decompressor: std.compress.flate.Decompress = .init(&compressed_reader, .gzip, &decompression_buffer);
    var file_name_buffer: [std.fs.max_path_bytes]u8 = undefined;
    var link_name_buffer: [std.fs.max_path_bytes]u8 = undefined;
    var iterator: std.tar.Iterator = .init(&decompressor.reader, .{
        .file_name_buffer = &file_name_buffer,
        .link_name_buffer = &link_name_buffer,
    });

    var package_json: ?[]const u8 = null;
    var readme: ?Readme = null;
    var paths = std.array_list.Managed([]const u8).init(allocator);
    var total_files: usize = 0;
    var unpacked_size: usize = 0;

    if (!options.quiet) try stdout.writeByte('\n');
    while (try iterator.next()) |entry| {
        const stripped = stripFirstPathComponent(entry.name);
        if (stripped.len == 0) continue;
        const entry_size = std.math.cast(usize, entry.size) orelse return error.TarballTooLarge;
        unpacked_size = std.math.add(usize, unpacked_size, entry_size) catch return error.TarballTooLarge;
        if (unpacked_size > max_tarball_bytes) return error.TarballTooLarge;
        if (!options.quiet) {
            try stdout.writeAll("packed ");
            try Pack.printSize(stdout, entry_size);
            try stdout.print(" {s}\n", .{stripped});
        }
        if (entry.kind != .file) continue;
        total_files += 1;
        try paths.append(try allocator.dupe(u8, stripped));

        if (std.mem.indexOfAny(u8, stripped, "/\\") == null and
            package_json == null and std.ascii.eqlIgnoreCase(stripped, "package.json"))
        {
            if (entry.size > max_package_json_bytes) return error.PackageJSONTooLarge;
            var contents: std.Io.Writer.Allocating = .init(allocator);
            try iterator.streamRemaining(entry, &contents.writer);
            package_json = try contents.toOwnedSlice();
        } else if (readme == null and entry.size <= max_package_json_bytes and isRootReadme(stripped)) {
            var contents: std.Io.Writer.Allocating = .init(allocator);
            try iterator.streamRemaining(entry, &contents.writer);
            readme = .{
                .filename = try allocator.dupe(u8, stripped),
                .contents = try contents.toOwnedSlice(),
            };
        }
    }

    const source = package_json orelse return error.MissingPackageJSON;
    const manifest = std.json.parseFromSliceLeaky(Value, allocator, source, .{}) catch return error.InvalidPackageJSON;
    try applyPublishConfig(options, &manifest);
    if (options.tag.len > 0) try validateDistTag(options.tag);
    const identity = try validateManifest(&manifest, options.access);

    if (!options.quiet) {
        try stdout.writeByte('\n');
        try printTarballSummary(stdout, allocator, total_files, unpacked_size, tarball);
        try stdout.flush();
    }

    return .{
        .package_name = identity.name,
        .package_version = identity.version,
        .manifest = manifest,
        .tarball = tarball,
        .archive_paths = try paths.toOwnedSlice(),
        .readme = readme,
        .total_files = total_files,
        .unpacked_size = unpacked_size,
    };
}

pub fn publish(
    init: std.process.Init,
    client: *std.http.Client,
    prepared: *PreparedPackage,
    registry: Registry,
    options: Options,
    stdout: *std.Io.Writer,
    stderr: *std.Io.Writer,
) !u8 {
    const allocator = init.arena.allocator();
    if (registry.authorization == null) {
        try stderr.writeAll("error: missing authentication (run `bunx npm login`)\n");
        try stderr.flush();
        return 1;
    }

    const version = versionWithoutBuild(prepared.package_version);
    const package_url = try packageURL(allocator, registry.url, prepared.package_name);
    const request_options: RegistryRequestOptions = .{
        .auth_type = options.auth_type,
        .uses_workspaces = prepared.uses_workspaces,
    };
    if (options.tolerate_republish and try packageVersionExists(
        allocator,
        client,
        package_url,
        registry,
        version,
        request_options,
    )) {
        try stderr.print("warn: Registry already knows about version {s}; skipping.\n", .{version});
        try stderr.flush();
        return 0;
    }

    try stdout.print(
        "Tag: {s}\nAccess: {s}\nRegistry: {s}\n",
        .{
            if (options.tag.len > 0) options.tag else "latest",
            if (options.access) |access| @tagName(access) else "default",
            registry.url,
        },
    );
    try stdout.flush();
    if (options.dry_run) return 0;

    const body = try constructPublishBody(allocator, prepared, registry, options);
    const authenticated = requestWithOtp(
        init,
        client,
        .PUT,
        package_url,
        registry,
        request_options,
        if (options.otp.len > 0) options.otp else null,
        body,
        stdout,
        stderr,
    ) catch |err| {
        if (err == error.RegistryAuthenticationReported) return 1;
        try stderr.print("error: failed to publish package: {s}\n", .{@errorName(err)});
        try stderr.flush();
        return 1;
    };
    const response = authenticated.response;
    if (response.status >= 400) {
        try printRegistryError(stderr, "PUT", package_url, response, authenticated.otp_retry);
        return 1;
    }
    try printNotice(stderr, response);
    return 0;
}

pub fn runPostPublishScripts(
    init: std.process.Init,
    prepared: *const PreparedPackage,
    options: Options,
    stderr: *std.Io.Writer,
) !void {
    if (!prepared.from_workspace or options.ignore_scripts) return;
    const package_dir = prepared.package_dir orelse return;
    try Scripts.runPublishStage(init, package_dir, &prepared.manifest, "publish", options.quiet, stderr);
    try Scripts.runPublishStage(init, package_dir, &prepared.manifest, "postpublish", options.quiet, stderr);
}

const Identity = struct {
    name: []const u8,
    version: []const u8,
};

fn readManifest(io: std.Io, allocator: std.mem.Allocator, path: []const u8) !Value {
    const source = try std.Io.Dir.cwd().readFileAlloc(io, path, allocator, .limited(max_package_json_bytes));
    return std.json.parseFromSliceLeaky(Value, allocator, source, .{}) catch return error.InvalidPackageJSON;
}

fn applyPublishConfig(options: *Options, manifest: *const Value) !void {
    if (manifest.* != .object) return;
    const config = manifest.object.get("publishConfig") orelse return;
    if (config != .object) return;
    if (options.tag.len == 0) {
        if (config.object.get("tag")) |tag| {
            if (tag == .string) options.tag = tag.string;
        }
    }
    if (options.access == null) {
        if (config.object.get("access")) |access| {
            if (access == .string) {
                options.access = Access.parse(access.string) orelse return error.InvalidPublishAccess;
            }
        }
    }
}

fn validateManifest(manifest: *const Value, access: ?Access) !Identity {
    if (manifest.* != .object) return error.InvalidPackageJSON;
    if (manifest.object.get("private")) |private| {
        if (private == .bool and private.bool) return error.PrivatePackage;
    }
    const name_value = manifest.object.get("name") orelse return error.MissingPackageName;
    if (name_value != .string or name_value.string.len == 0) return error.InvalidPackageName;
    const scoped = try isScopedPackageName(name_value.string);
    if (access) |value| {
        if (value == .restricted and !scoped) return error.RestrictedUnscopedPackage;
    }
    const version_value = manifest.object.get("version") orelse return error.MissingPackageVersion;
    if (version_value != .string or version_value.string.len == 0) return error.InvalidPackageVersion;
    return .{ .name = name_value.string, .version = version_value.string };
}

fn isScopedPackageName(name: []const u8) !bool {
    if (name.len == 0) return error.InvalidPackageName;
    if (name[0] != '@') return false;
    const slash = std.mem.indexOfScalar(u8, name, '/') orelse return error.InvalidPackageName;
    if (slash == 1 or slash == name.len - 1) return error.InvalidPackageName;
    return true;
}

fn hasScript(manifest: *const Value, name: []const u8) bool {
    if (manifest.* != .object) return false;
    const scripts = manifest.object.get("scripts") orelse return false;
    if (scripts != .object) return false;
    const script = scripts.object.get(name) orelse return false;
    return script == .string and script.string.len > 0;
}

fn stripFirstPathComponent(path: []const u8) []const u8 {
    const separator = std.mem.indexOfAny(u8, path, "/\\") orelse return path;
    if (separator + 1 >= path.len) return "";
    return path[separator + 1 ..];
}

fn isRootReadme(path: []const u8) bool {
    if (std.mem.indexOfAny(u8, path, "/\\") != null or path.len < "README".len) return false;
    if (!std.ascii.eqlIgnoreCase(path[0.."README".len], "README")) return false;
    return path.len == "README".len or path["README".len] == '.';
}

fn printTarballSummary(
    writer: *std.Io.Writer,
    allocator: std.mem.Allocator,
    total_files: usize,
    unpacked_size: usize,
    tarball: []const u8,
) !void {
    try writer.print("Total files: {d}\n", .{total_files});
    var shasum: [20]u8 = undefined;
    std.crypto.hash.Sha1.hash(tarball, &shasum, .{});
    var integrity_digest: [64]u8 = undefined;
    std.crypto.hash.sha2.Sha512.hash(tarball, &integrity_digest, .{});
    const integrity_len = std.base64.standard.Encoder.calcSize(integrity_digest.len);
    const integrity = try allocator.alloc(u8, integrity_len);
    _ = std.base64.standard.Encoder.encode(integrity, &integrity_digest);
    try writer.print("Shasum: {s}\nIntegrity: sha512-{s}\n", .{ std.fmt.bytesToHex(shasum, .lower), integrity });
    try writer.writeAll("Unpacked size: ");
    try Pack.printSize(writer, unpacked_size);
    try writer.writeAll("\nPacked size: ");
    try Pack.printSize(writer, tarball.len);
    try writer.writeByte('\n');
}

fn constructPublishBody(
    allocator: std.mem.Allocator,
    prepared: *PreparedPackage,
    registry: Registry,
    options: Options,
) ![]u8 {
    var manifest_json: std.Io.Writer.Allocating = .init(allocator);
    try std.json.Stringify.value(prepared.manifest, .{}, &manifest_json.writer);
    const normalized_source = try manifest_json.toOwnedSlice();
    var normalized = try std.json.parseFromSliceLeaky(Value, allocator, normalized_source, .{});
    const version = versionWithoutBuild(prepared.package_version);
    var shasum: [20]u8 = undefined;
    std.crypto.hash.Sha1.hash(prepared.tarball, &shasum, .{});
    const shasum_text = try std.fmt.allocPrint(allocator, "{s}", .{std.fmt.bytesToHex(shasum, .lower)});
    var integrity_digest: [64]u8 = undefined;
    std.crypto.hash.sha2.Sha512.hash(prepared.tarball, &integrity_digest, .{});
    const encoded_integrity = try allocator.alloc(u8, std.base64.standard.Encoder.calcSize(integrity_digest.len));
    _ = std.base64.standard.Encoder.encode(encoded_integrity, &integrity_digest);
    const integrity = try std.fmt.allocPrint(allocator, "sha512-{s}", .{encoded_integrity});

    try normalized.object.put(allocator, "_id", .{ .string = try std.fmt.allocPrint(allocator, "{s}@{s}", .{ prepared.package_name, version }) });
    try normalized.object.put(allocator, "_integrity", .{ .string = integrity });
    try normalized.object.put(allocator, "_nodeVersion", .{ .string = "24.0.0" });
    try normalized.object.put(allocator, "_npmVersion", .{ .string = "10.8.3" });
    try normalized.object.put(allocator, "integrity", .{ .string = integrity });
    try normalized.object.put(allocator, "shasum", .{ .string = shasum_text });
    if (prepared.readme) |readme| {
        if (normalized.object.get("readme") == null) {
            try normalized.object.put(allocator, "readme", .{ .string = readme.contents });
            try normalized.object.put(allocator, "readmeFilename", .{ .string = readme.filename });
        }
    }
    try normalizeBin(allocator, &normalized, prepared.package_name, prepared.archive_paths);

    const raw_tarball_name = try std.fmt.allocPrint(allocator, "{s}-{s}.tgz", .{ prepared.package_name, prepared.package_version });
    var dist: std.json.ObjectMap = .empty;
    try dist.put(allocator, "integrity", .{ .string = integrity });
    try dist.put(allocator, "shasum", .{ .string = shasum_text });
    try dist.put(allocator, "tarball", .{ .string = try tarballURL(allocator, registry.url, prepared.package_name, raw_tarball_name) });
    try normalized.object.put(allocator, "dist", .{ .object = dist });

    var dist_tags: std.json.ObjectMap = .empty;
    try dist_tags.put(allocator, if (options.tag.len > 0) options.tag else "latest", .{ .string = version });
    var versions: std.json.ObjectMap = .empty;
    try versions.put(allocator, version, normalized);
    const attachment_data = try allocator.alloc(u8, std.base64.standard.Encoder.calcSize(prepared.tarball.len));
    _ = std.base64.standard.Encoder.encode(attachment_data, prepared.tarball);
    var attachment: std.json.ObjectMap = .empty;
    try attachment.put(allocator, "content_type", .{ .string = "application/octet-stream" });
    try attachment.put(allocator, "data", .{ .string = attachment_data });
    try attachment.put(allocator, "length", .{ .integer = @intCast(prepared.tarball.len) });
    var attachments: std.json.ObjectMap = .empty;
    try attachments.put(allocator, raw_tarball_name, .{ .object = attachment });

    var document: std.json.ObjectMap = .empty;
    try document.put(allocator, "_id", .{ .string = prepared.package_name });
    try document.put(allocator, "name", .{ .string = prepared.package_name });
    try document.put(allocator, "dist-tags", .{ .object = dist_tags });
    try document.put(allocator, "versions", .{ .object = versions });
    if (options.access) |access| {
        try document.put(allocator, "access", .{ .string = @tagName(access) });
    } else {
        try document.put(allocator, "access", .null);
    }
    try document.put(allocator, "_attachments", .{ .object = attachments });

    var output: std.Io.Writer.Allocating = .init(allocator);
    try std.json.Stringify.value(Value{ .object = document }, .{}, &output.writer);
    return output.toOwnedSlice();
}

fn normalizeBin(
    allocator: std.mem.Allocator,
    manifest: *Value,
    package_name: []const u8,
    archive_paths: []const []const u8,
) !void {
    const bin = manifest.object.getPtr("bin");
    if (bin) |value| switch (value.*) {
        .string => |path| {
            if (path.len == 0) return;
            var normalized: std.json.ObjectMap = .empty;
            try normalized.put(allocator, package_name, .{ .string = try normalizeBinPath(allocator, path) });
            value.* = .{ .object = normalized };
        },
        .object => |object| {
            var normalized: std.json.ObjectMap = .empty;
            for (object.keys(), object.values()) |key, path| {
                if (key.len == 0 or path != .string or path.string.len == 0) continue;
                try normalized.put(allocator, try normalizeBinPath(allocator, key), .{
                    .string = try normalizeBinPath(allocator, path.string),
                });
            }
            value.* = .{ .object = normalized };
        },
        else => {},
    } else if (manifest.object.get("directories")) |directories| {
        if (directories != .object) return;
        const directory = directories.object.get("bin") orelse return;
        if (directory != .string or directory.string.len == 0) return;
        const prefix = try normalizeBinPath(allocator, directory.string);
        var normalized: std.json.ObjectMap = .empty;
        for (archive_paths) |path| {
            if (!std.mem.startsWith(u8, path, prefix) or path.len <= prefix.len or path[prefix.len] != '/') continue;
            try normalized.put(allocator, std.fs.path.basename(path), .{ .string = path });
        }
        try manifest.object.put(allocator, "bin", .{ .object = normalized });
    }
}

fn normalizeBinPath(allocator: std.mem.Allocator, path: []const u8) ![]const u8 {
    var normalized = try allocator.dupe(u8, path);
    std.mem.replaceScalar(u8, normalized, '\\', '/');
    while (std.mem.startsWith(u8, normalized, "./")) normalized = normalized[2..];
    return std.mem.trimEnd(u8, normalized, "/");
}

pub fn versionWithoutBuild(version: []const u8) []const u8 {
    const plus = std.mem.indexOfScalar(u8, version, '+') orelse return version;
    return version[0..plus];
}

pub fn validateDistTag(tag: []const u8) !void {
    if (tag.len == 0 or !std.mem.eql(u8, tag, std.mem.trim(u8, tag, " \t\r\n"))) {
        return error.InvalidDistTag;
    }
    if (looksLikeSemverRange(tag)) return error.SemverDistTag;
    for (tag) |byte| {
        if (!isEncodeURIComponentSafe(byte)) return error.InvalidDistTag;
    }
}

fn isEncodeURIComponentSafe(byte: u8) bool {
    return std.ascii.isAlphanumeric(byte) or switch (byte) {
        '-', '_', '.', '!', '~', '*', '\'', '(', ')' => true,
        else => false,
    };
}

fn looksLikeSemverRange(input: []const u8) bool {
    if (std.SemanticVersion.parse(input)) |_| return true else |_| {}

    var value = std.mem.trim(u8, input, " \t\r\n");
    if (value.len == 0) return false;
    while (value.len > 0 and switch (value[0]) {
        '<', '>', '=', '~', '^' => true,
        else => false,
    }) value = std.mem.trimStart(u8, value[1..], " \t\r\n");
    if (value.len > 1 and value[0] == 'v' and std.ascii.isDigit(value[1])) value = value[1..];
    if (value.len == 1 and (value[0] == '*' or value[0] == 'x' or value[0] == 'X')) return true;
    if (value.len == 0 or !std.ascii.isDigit(value[0])) return false;

    var index: usize = 0;
    var components: usize = 0;
    while (components < 3) : (components += 1) {
        const start = index;
        while (index < value.len and std.ascii.isDigit(value[index])) index += 1;
        if (start == index) {
            if (index < value.len and (value[index] == 'x' or value[index] == 'X' or value[index] == '*')) {
                index += 1;
            } else return false;
        } else if (index - start > 1 and value[start] == '0') {
            return false;
        }
        if (index == value.len) return true;
        if (value[index] == '.') {
            index += 1;
            continue;
        }
        break;
    }

    if (index < value.len and std.ascii.isWhitespace(value[index])) {
        const remainder = std.mem.trimStart(u8, value[index..], " \t\r\n");
        if (remainder.len == 0) return true;
        if (std.mem.startsWith(u8, remainder, "||")) return looksLikeSemverRange(remainder[2..]);
        if (remainder[0] == '-') return looksLikeSemverRange(remainder[1..]);
        return looksLikeSemverRange(remainder);
    }
    if (index + 1 < value.len and value[index] == '|' and value[index + 1] == '|') {
        return looksLikeSemverRange(value[index + 2 ..]);
    }
    return false;
}

fn packageURL(allocator: std.mem.Allocator, registry_url: []const u8, package_name: []const u8) ![]const u8 {
    const encoded_name = if (package_name.len > 0 and package_name[0] == '@') blk: {
        const slash = std.mem.indexOfScalar(u8, package_name, '/') orelse break :blk package_name;
        break :blk try std.fmt.allocPrint(allocator, "{s}%2f{s}", .{ package_name[0..slash], package_name[slash + 1 ..] });
    } else package_name;
    return std.fmt.allocPrint(allocator, "{s}/{s}", .{ std.mem.trimEnd(u8, registry_url, "/"), encoded_name });
}

fn tarballURL(
    allocator: std.mem.Allocator,
    registry_url: []const u8,
    package_name: []const u8,
    tarball_name: []const u8,
) ![]const u8 {
    const base = std.mem.trimEnd(u8, registry_url, "/");
    if (std.mem.startsWith(u8, base, "https://")) {
        return std.fmt.allocPrint(allocator, "http://{s}/{s}/-/{s}", .{ base["https://".len..], package_name, tarball_name });
    }
    return std.fmt.allocPrint(allocator, "{s}/{s}/-/{s}", .{ base, package_name, tarball_name });
}

fn packageVersionExists(
    allocator: std.mem.Allocator,
    client: *std.http.Client,
    package_url: []const u8,
    registry: Registry,
    version: []const u8,
    options: RegistryRequestOptions,
) !bool {
    const response = registryRequest(
        allocator,
        client,
        .GET,
        package_url,
        registry,
        options,
        null,
        null,
        null,
    ) catch return false;
    if (response.status != 200) return false;
    const manifest = std.json.parseFromSliceLeaky(Value, allocator, response.body, .{}) catch return false;
    if (manifest != .object) return false;
    const versions = manifest.object.get("versions") orelse return false;
    return versions == .object and versions.object.get(version) != null;
}

pub fn registryRequest(
    allocator: std.mem.Allocator,
    client: *std.http.Client,
    method: std.http.Method,
    url: []const u8,
    registry: Registry,
    options: RegistryRequestOptions,
    otp: ?[]const u8,
    body: ?[]u8,
    maybe_environment: ?*const std.process.Environ.Map,
) !RegistryResponse {
    var headers = std.array_list.Managed(std.http.Header).init(allocator);
    try headers.append(.{ .name = "accept", .value = "*/*" });
    try headers.append(.{ .name = "accept-encoding", .value = "gzip,deflate" });
    if (registry.authorization) |authorization| {
        try headers.append(.{ .name = "authorization", .value = authorization });
    }
    if (body != null) try headers.append(.{ .name = "content-type", .value = "application/json" });
    try headers.append(.{
        .name = "npm-auth-type",
        .value = if (otp != null) "legacy" else if (options.auth_type) |auth_type| @tagName(auth_type) else "web",
    });
    if (otp) |value| try headers.append(.{ .name = "npm-otp", .value = value });
    try headers.append(.{ .name = "npm-command", .value = options.npm_command });
    const user_agent = try registryUserAgent(allocator, maybe_environment, options.uses_workspaces);
    try headers.append(.{ .name = "user-agent", .value = user_agent });

    var req = try client.request(method, try std.Uri.parse(url), .{
        .headers = .{
            .authorization = .omit,
            .user_agent = .omit,
            .accept_encoding = .omit,
            .content_type = .omit,
        },
        .extra_headers = headers.items,
    });
    defer req.deinit();
    if (body) |payload| {
        try req.sendBodyComplete(payload);
    } else {
        try req.sendBodiless();
    }

    var redirect_buffer: [8192]u8 = undefined;
    var response = try req.receiveHead(&redirect_buffer);
    if (response.head.content_length) |length| {
        if (length > max_response_bytes) return error.ResponseTooLarge;
    }
    var result: RegistryResponse = .{ .status = @intFromEnum(response.head.status), .body = "" };
    var header_iterator = response.head.iterateHeaders();
    while (header_iterator.next()) |header| {
        if (std.ascii.eqlIgnoreCase(header.name, "www-authenticate")) {
            result.www_authenticate = try allocator.dupe(u8, header.value);
        } else if (std.ascii.eqlIgnoreCase(header.name, "npm-notice")) {
            result.npm_notice = try allocator.dupe(u8, header.value);
        } else if (std.ascii.eqlIgnoreCase(header.name, "retry-after")) {
            result.retry_after = try allocator.dupe(u8, header.value);
        } else if (std.ascii.eqlIgnoreCase(header.name, "x-local-cache")) {
            result.x_local_cache = true;
        }
    }

    const content_encoding = response.head.content_encoding;
    var output: std.Io.Writer.Allocating = .init(allocator);
    var transfer_buffer: [64]u8 = undefined;
    if (content_encoding == .identity) {
        const reader = response.reader(&transfer_buffer);
        var limited = reader.limited(.limited(max_response_bytes + 1), &.{});
        _ = try limited.interface.streamRemaining(&output.writer);
    } else {
        const buffer_len: usize = switch (content_encoding) {
            .gzip, .deflate => std.compress.flate.max_window_len,
            .zstd => std.compress.zstd.default_window_len,
            .compress => return error.UnsupportedCompressionMethod,
            .identity => unreachable,
        };
        const decompression_buffer = try allocator.alloc(u8, buffer_len);
        var decompressor: std.http.Decompress = undefined;
        const reader = response.readerDecompressing(&transfer_buffer, &decompressor, decompression_buffer);
        var limited = reader.limited(.limited(max_response_bytes + 1), &.{});
        _ = try limited.interface.streamRemaining(&output.writer);
    }
    if (output.written().len > max_response_bytes) return error.ResponseTooLarge;
    result.body = try output.toOwnedSlice();
    return result;
}

fn registryUserAgent(
    allocator: std.mem.Allocator,
    maybe_environment: ?*const std.process.Environ.Map,
    uses_workspaces: bool,
) ![]const u8 {
    const os_name = switch (builtin.os.tag) {
        .macos => "darwin",
        .windows => "win32",
        else => @tagName(builtin.os.tag),
    };
    const arch_name = switch (builtin.cpu.arch) {
        .x86_64 => "x64",
        .aarch64 => "arm64",
        else => @tagName(builtin.cpu.arch),
    };
    const ci_name = if (maybe_environment) |environment| detectCIName(environment) else null;
    return std.fmt.allocPrint(
        allocator,
        "bun/1.3.10 npm/? node/v24.0.0 {s} {s} workspaces/{}{s}{s}",
        .{ os_name, arch_name, uses_workspaces, if (ci_name != null) " ci/" else "", ci_name orelse "" },
    );
}

fn detectCIName(environment: *const std.process.Environ.Map) ?[]const u8 {
    if (environment.get("EAS_BUILD") != null) return "expo-application-services";
    if (environment.get("CM_BUILD_ID") != null) return "codemagic";
    if (environment.get("NOW_BUILDER") != null or environment.get("VERCEL") != null) return "vercel";
    if (environment.get("GITHUB_ACTIONS") != null) return "github-actions";
    if (environment.get("BUILDKITE") != null) return "buildkite";
    return null;
}

const AuthenticationChallenge = union(enum) {
    none,
    otp,
    ip_address,
    unsupported: []const u8,
};

fn authenticationChallenge(response: RegistryResponse) AuthenticationChallenge {
    if (response.status != 401) return .none;
    if (response.www_authenticate) |value| {
        var parts = std.mem.splitScalar(u8, value, ',');
        while (parts.next()) |raw| {
            const part = std.mem.trim(u8, raw, " \t");
            if (std.ascii.eqlIgnoreCase(part, "ipaddress")) return .ip_address;
            if (std.ascii.eqlIgnoreCase(part, "otp")) return .otp;
        }
        return .{ .unsupported = value };
    }
    return if (std.mem.indexOf(u8, response.body, "one-time pass") != null) .otp else .none;
}

pub fn requestWithOtp(
    init: std.process.Init,
    client: *std.http.Client,
    method: std.http.Method,
    url: []const u8,
    registry: Registry,
    options: RegistryRequestOptions,
    supplied_otp: ?[]const u8,
    body: ?[]u8,
    stdout: *std.Io.Writer,
    stderr: *std.Io.Writer,
) !AuthenticatedResponse {
    const allocator = init.arena.allocator();
    var response = try registryRequest(
        allocator,
        client,
        method,
        url,
        registry,
        options,
        supplied_otp,
        body,
        init.environ_map,
    );
    if (response.status < 400) return .{ .response = response };

    switch (authenticationChallenge(response)) {
        .none => return .{ .response = response },
        .ip_address => {
            try stderr.writeAll("error: login is not allowed from your IP address\n");
            try stderr.flush();
            return error.RegistryAuthenticationReported;
        },
        .unsupported => |required| {
            try stderr.print("error: unable to authenticate, need: {s}\n", .{required});
            try stderr.flush();
            return error.RegistryAuthenticationReported;
        },
        .otp => {},
    }

    try printNotice(stderr, response);
    const otp = getOtp(init, client, registry, options, response, stdout, stderr) catch |err| {
        try stderr.print("error: failed to obtain one-time password: {s}\n", .{@errorName(err)});
        try stderr.flush();
        return error.RegistryAuthenticationReported;
    };
    response = try registryRequest(
        allocator,
        client,
        method,
        url,
        registry,
        options,
        otp,
        body,
        init.environ_map,
    );
    return .{ .response = response, .otp_retry = true };
}

fn getOtp(
    init: std.process.Init,
    client: *std.http.Client,
    registry: Registry,
    options: RegistryRequestOptions,
    response: RegistryResponse,
    stdout: *std.Io.Writer,
    stderr: *std.Io.Writer,
) ![]const u8 {
    const allocator = init.arena.allocator();
    const parsed = std.json.parseFromSliceLeaky(Value, allocator, response.body, .{}) catch null;
    if (parsed) |value| if (value == .object) {
        const auth_url = value.object.get("authUrl");
        const done_url = value.object.get("doneUrl");
        if (auth_url != null and done_url != null and auth_url.? == .string and done_url.? == .string) {
            try stdout.print("\nAuthenticate your account at:\n\n{s}\n", .{auth_url.?.string});
            try stdout.flush();
            while (true) {
                const done_response = try registryRequest(
                    allocator,
                    client,
                    .GET,
                    done_url.?.string,
                    registry,
                    options,
                    null,
                    null,
                    init.environ_map,
                );
                if (done_response.status == 202) {
                    const milliseconds: i64 = if (done_response.retry_after) |retry| blk: {
                        const seconds = std.fmt.parseInt(u32, std.mem.trim(u8, retry, " \t"), 10) catch break :blk 500;
                        break :blk @as(i64, seconds) * std.time.ms_per_s;
                    } else 500;
                    std.Io.sleep(init.io, .fromMilliseconds(milliseconds), .awake) catch {};
                    continue;
                }
                if (done_response.status != 200) {
                    try printRegistryError(stderr, "GET", done_url.?.string, done_response, false);
                    return error.WebLoginFailed;
                }
                const done = std.json.parseFromSliceLeaky(Value, allocator, done_response.body, .{}) catch return error.InvalidWebLoginResponse;
                if (done != .object) return error.InvalidWebLoginResponse;
                const token = done.object.get("token") orelse return error.InvalidWebLoginResponse;
                if (token != .string or token.string.len == 0) return error.InvalidWebLoginResponse;
                try printNotice(stderr, done_response);
                return token.string;
            }
        }
    };

    try stderr.writeAll("\nThis operation requires a one-time password.\nEnter OTP: ");
    try stderr.flush();
    var input_buffer: [4096]u8 = undefined;
    var stdin_reader = std.Io.File.stdin().readerStreaming(init.io, &input_buffer);
    const line = (try stdin_reader.interface.takeDelimiter('\n')) orelse return error.MissingOTP;
    const otp = std.mem.trim(u8, line, " \t\r");
    if (otp.len == 0) return error.MissingOTP;
    return try allocator.dupe(u8, otp);
}

pub fn printNotice(stderr: *std.Io.Writer, response: RegistryResponse) !void {
    if (response.x_local_cache) return;
    if (response.npm_notice) |notice| {
        try stderr.print("\nnote: {s}\n", .{notice});
        try stderr.flush();
    }
}

pub fn printRegistryError(
    stderr: *std.Io.Writer,
    method: []const u8,
    url: []const u8,
    response: RegistryResponse,
    otp_response: bool,
) !void {
    var message: []const u8 = response.body;
    var arena = std.heap.ArenaAllocator.init(std.heap.smp_allocator);
    defer arena.deinit();
    const parsed = std.json.parseFromSliceLeaky(Value, arena.allocator(), response.body, .{}) catch null;
    if (parsed) |value| if (value == .object) {
        if (value.object.get("error")) |field| if (field == .string) {
            message = field.string;
        };
        if (value.object.get("reason")) |field| if (field == .string) {
            message = field.string;
        };
    };
    try stderr.print("error: {s} {s} - {d}", .{ method, url, response.status });
    if (message.len > 0) try stderr.print(" {s}", .{message});
    if (otp_response) try stderr.writeAll(" - Received invalid OTP");
    try stderr.writeByte('\n');
    try stderr.flush();
}

test "scoped publish URLs encode the package separator" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    try std.testing.expectEqualStrings(
        "https://registry.example/@scope%2fpkg",
        try packageURL(arena.allocator(), "https://registry.example/", "@scope/pkg"),
    );
}

test "publish strips semver build metadata from registry version keys" {
    try std.testing.expectEqualStrings("1.2.3", versionWithoutBuild("1.2.3+build.4"));
    try std.testing.expectEqualStrings("1.2.3", versionWithoutBuild("1.2.3"));
}
