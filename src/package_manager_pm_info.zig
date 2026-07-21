const std = @import("std");
const compiler = @import("cottontail_compiler");

const Semver = compiler.Semver;
const Value = std.json.Value;

pub fn render(
    allocator: std.mem.Allocator,
    source: []const u8,
    package_name: []const u8,
    requested_version: []const u8,
    property_path: ?[]const u8,
    json_output: bool,
    stdout: *std.Io.Writer,
    stderr: *std.Io.Writer,
) !u8 {
    var manifest = std.json.parseFromSliceLeaky(Value, allocator, source, .{}) catch {
        try stderr.writeAll("error: failed to parse package manifest\n");
        try stderr.flush();
        return 1;
    };
    if (manifest != .object) {
        try stderr.writeAll("error: failed to parse package manifest\n");
        try stderr.flush();
        return 1;
    }

    const versions_value = manifest.object.getPtr("versions") orelse {
        try stderr.writeAll("error: package manifest has no versions\n");
        try stderr.flush();
        return 1;
    };
    if (versions_value.* != .object) {
        try stderr.writeAll("error: package manifest has invalid versions\n");
        try stderr.flush();
        return 1;
    }

    const selected_version = selectVersion(allocator, &manifest, requested_version) orelse {
        if (json_output) {
            try stdout.print("{{\"error\":\"No matching version found\",\"version\":", .{});
            try std.json.Stringify.value(requested_version, .{}, stdout);
            try stdout.writeAll("}\n");
            try stdout.flush();
        } else {
            try stderr.print("error: No version of \"{s}\" satisfying \"{s}\" found\n", .{ package_name, requested_version });
            try writeRecentVersions(allocator, &manifest, stderr);
            try stderr.flush();
        }
        return 1;
    };
    const selected = versions_value.object.getPtr(selected_version) orelse return error.InvalidRegistryManifest;
    if (selected.* != .object) return error.InvalidRegistryManifest;

    var versions_array = try versionArray(allocator, versions_value);
    if (property_path) |path| {
        const value = if (std.mem.eql(u8, path, "versions") or std.mem.startsWith(u8, path, "versions["))
            getPath(&versions_array, path["versions".len..])
        else
            getPath(selected, path) orelse getPath(&manifest, path);
        if (value) |found| {
            try writeProperty(found.*, json_output, stdout);
            try stdout.flush();
            return 0;
        }
        if (json_output) {
            try stdout.writeAll("{\"error\":\"Property not found\",\"version\":");
            try std.json.Stringify.value(selected_version, .{}, stdout);
            try stdout.writeAll(",\"property\":");
            try std.json.Stringify.value(path, .{}, stdout);
            try stdout.writeAll("}\n");
            try stdout.flush();
        } else {
            try stderr.print("error: Property {s} not found\n", .{path});
            try stderr.flush();
        }
        return 1;
    }

    if (json_output) {
        try std.json.Stringify.value(selected.*, .{ .whitespace = .indent_2 }, stdout);
        try stdout.writeByte('\n');
        try stdout.flush();
        return 0;
    }

    try writeHumanSummary(&manifest, selected, selected_version, versions_value.object.count(), stdout);
    try stdout.flush();
    return 0;
}

fn selectVersion(allocator: std.mem.Allocator, manifest: *const Value, requested: []const u8) ?[]const u8 {
    const versions = manifest.object.get("versions") orelse return null;
    if (versions != .object) return null;
    if (manifest.object.get("dist-tags")) |tags| {
        if (tags == .object) {
            if (tags.object.get(requested)) |tag| {
                if (tag == .string and versions.object.get(tag.string) != null) return tag.string;
            }
        }
    }
    if (versions.object.get(requested) != null) return requested;
    return bestMatchingVersion(allocator, &versions.object, requested);
}

fn bestMatchingVersion(
    allocator: std.mem.Allocator,
    versions: *const std.json.ObjectMap,
    range: []const u8,
) ?[]const u8 {
    var best: ?[]const u8 = null;
    var best_parsed: ?Semver.Version = null;
    for (versions.keys()) |version_value| {
        if (!semverSatisfies(allocator, range, version_value)) continue;
        const parsed = Semver.Version.parseUTF8(version_value);
        if (!parsed.valid) continue;
        const concrete = parsed.version.min();
        if (best_parsed == null or concrete.order(best_parsed.?, version_value, best.?) == .gt) {
            best = version_value;
            best_parsed = concrete;
        }
    }
    return best;
}

fn semverSatisfies(allocator: std.mem.Allocator, range: []const u8, version_value: []const u8) bool {
    if (std.mem.eql(u8, range, "") or std.mem.eql(u8, range, "*") or std.mem.eql(u8, range, "latest")) return true;
    const parsed_version = Semver.Version.parseUTF8(version_value);
    if (!parsed_version.valid) return false;
    const sliced = Semver.SlicedString.init(range, range);
    var query = Semver.Query.parse(allocator, range, sliced) catch return false;
    defer query.deinit();
    return query.satisfies(parsed_version.version.min(), range, version_value);
}

fn versionArray(allocator: std.mem.Allocator, versions: *const Value) !Value {
    var array = std.json.Array.init(allocator);
    for (versions.object.keys()) |version_value| {
        try array.append(.{ .string = version_value });
    }
    return .{ .array = array };
}

fn writeRecentVersions(allocator: std.mem.Allocator, manifest: *const Value, writer: *std.Io.Writer) !void {
    const versions = manifest.object.get("versions") orelse return;
    if (versions != .object) return;
    var recent = std.array_list.Managed([]const u8).init(allocator);
    for (versions.object.keys()) |version_value| try recent.append(version_value);
    if (manifest.object.get("dist-tags")) |tags| {
        if (tags == .object) {
            if (tags.object.get("latest")) |latest| {
                if (latest == .string) try recent.append(latest.string);
            }
        }
    }
    const display_count = @min(recent.items.len, 5);
    const start = recent.items.len - display_count;
    if (display_count == 0) return;
    try writer.writeAll("\nRecent versions:\n");
    for (recent.items[start..]) |version_value| try writer.print("- {s}\n", .{version_value});
    if (start > 0) try writer.print("  ... and {d} more\n", .{start});
}

fn getPath(root: *const Value, path: []const u8) ?*const Value {
    var current = root;
    var index: usize = 0;
    while (index < path.len) {
        if (path[index] == '.') {
            index += 1;
            continue;
        }
        if (path[index] == '[') {
            const close = std.mem.indexOfScalarPos(u8, path, index + 1, ']') orelse return null;
            const item_index = std.fmt.parseInt(usize, path[index + 1 .. close], 10) catch return null;
            if (current.* != .array or item_index >= current.array.items.len) return null;
            current = &current.array.items[item_index];
            index = close + 1;
            continue;
        }
        var end = index;
        while (end < path.len and path[end] != '.' and path[end] != '[') end += 1;
        if (end == index or current.* != .object) return null;
        current = current.object.getPtr(path[index..end]) orelse return null;
        index = end;
    }
    return current;
}

fn writeProperty(value: Value, json_output: bool, writer: *std.Io.Writer) !void {
    if (!json_output and value == .string) {
        try writer.print("{s}\n", .{value.string});
        return;
    }
    const options: std.json.Stringify.Options = if (value == .object or value == .array)
        .{ .whitespace = .indent_2 }
    else
        .{};
    try std.json.Stringify.value(value, options, writer);
    try writer.writeByte('\n');
}

fn writeHumanSummary(
    manifest: *const Value,
    selected: *const Value,
    selected_version: []const u8,
    versions_len: usize,
    writer: *std.Io.Writer,
) !void {
    const package_name = jsonString(selected, "name") orelse jsonString(manifest, "name") orelse "";
    const package_version = jsonString(selected, "version") orelse selected_version;
    const license = jsonString(selected, "license") orelse "";
    const dependency_count = if (selected.object.get("dependencies")) |dependencies|
        if (dependencies == .object) dependencies.object.count() else 0
    else
        0;
    try writer.print("{s}@{s} | {s} | deps: {d} | versions: {d}\n", .{
        package_name,
        package_version,
        license,
        dependency_count,
        versions_len,
    });
    if (jsonString(manifest, "description")) |description| try writer.print("{s}\n", .{description});
    if (jsonString(manifest, "homepage")) |homepage| try writer.print("{s}\n", .{homepage});
    if (manifest.object.get("keywords")) |keywords| {
        if (keywords == .array and keywords.array.items.len > 0) {
            try writer.writeAll("keywords: ");
            var wrote_keyword = false;
            for (keywords.array.items) |keyword| {
                if (keyword != .string) continue;
                if (wrote_keyword) try writer.writeAll(", ");
                try writer.writeAll(keyword.string);
                wrote_keyword = true;
            }
            if (wrote_keyword) try writer.writeByte('\n');
        }
    }

    if (selected.object.get("dependencies")) |dependencies| {
        if (dependencies == .object and dependencies.object.count() > 0) {
            try writer.print("\ndependencies ({d}):\n", .{dependencies.object.count()});
            for (dependencies.object.keys(), dependencies.object.values()) |name, value| {
                if (value == .string) try writer.print("- {s}: {s}\n", .{ name, value.string });
            }
        }
    }

    if (selected.object.get("dist")) |dist| {
        if (dist == .object) {
            try writer.writeAll("\ndist\n");
            if (jsonString(&dist, "tarball")) |tarball| try writer.print(" .tarball: {s}\n", .{tarball});
            if (jsonString(&dist, "shasum")) |shasum| try writer.print(" .shasum: {s}\n", .{shasum});
            if (jsonString(&dist, "integrity")) |integrity| try writer.print(" .integrity: {s}\n", .{integrity});
            if (jsonNumber(&dist, "unpackedSize")) |unpacked_size| {
                try writer.writeAll(" .unpackedSize: ");
                try writeSize(writer, unpacked_size);
                try writer.writeByte('\n');
            }
        }
    }

    if (manifest.object.get("dist-tags")) |tags| {
        if (tags == .object and tags.object.count() > 0) {
            try writer.writeAll("\ndist-tags:\n");
            for (tags.object.keys(), tags.object.values()) |name, value| {
                if (value == .string) try writer.print("{s}: {s}\n", .{ name, value.string });
            }
        }
    }

    if (manifest.object.get("maintainers")) |maintainers| {
        if (maintainers == .array and maintainers.array.items.len > 0) {
            try writer.writeAll("\nmaintainers:\n");
            for (maintainers.array.items) |maintainer| {
                if (maintainer != .object) continue;
                const name = jsonString(&maintainer, "name") orelse "";
                const email = jsonString(&maintainer, "email") orelse "";
                if (email.len > 0) {
                    try writer.print("- {s} <{s}>\n", .{ name, email });
                } else if (name.len > 0) {
                    try writer.print("- {s}\n", .{name});
                }
            }
        }
    }

    if (manifest.object.get("time")) |time| {
        if (time == .object) {
            const published = if (time.object.get(package_version)) |value|
                if (value == .string) value.string else null
            else if (time.object.get("modified")) |value|
                if (value == .string) value.string else null
            else
                null;
            if (published) |timestamp| try writer.print("\nPublished: {s}\n", .{timestamp});
        }
    }
}

fn writeSize(writer: *std.Io.Writer, value: f64) !void {
    if (value >= 1_000_000_000) {
        try writer.print("{d:.2} GB", .{value / 1_000_000_000.0});
    } else if (value >= 1_000_000) {
        try writer.print("{d:.2} MB", .{value / 1_000_000.0});
    } else if (value >= 1_000) {
        try writer.print("{d:.2} KB", .{value / 1_000.0});
    } else {
        try writer.print("{d:.0} B", .{value});
    }
}

fn jsonString(value: *const Value, key: []const u8) ?[]const u8 {
    if (value.* != .object) return null;
    const field = value.object.get(key) orelse return null;
    return if (field == .string) field.string else null;
}

fn jsonNumber(value: *const Value, key: []const u8) ?f64 {
    if (value.* != .object) return null;
    const field = value.object.get(key) orelse return null;
    return switch (field) {
        .integer => |number| @floatFromInt(number),
        .float => |number| number,
        else => null,
    };
}

test "package info resolves tags, exact versions, and ranges" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    const source =
        \\{"dist-tags":{"latest":"2.1.0"},"versions":{"1.0.0":{},"2.0.0":{},"2.1.0":{}}}
    ;
    const manifest = try std.json.parseFromSliceLeaky(Value, allocator, source, .{});
    try std.testing.expectEqualStrings("2.1.0", selectVersion(allocator, &manifest, "latest").?);
    try std.testing.expectEqualStrings("1.0.0", selectVersion(allocator, &manifest, "1.0.0").?);
    try std.testing.expectEqualStrings("2.1.0", selectVersion(allocator, &manifest, "^2.0.0").?);
    try std.testing.expect(selectVersion(allocator, &manifest, "9.0.0") == null);
}

test "package info property paths support objects and array indices" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const value = try std.json.parseFromSliceLeaky(
        Value,
        arena.allocator(),
        \\{"repository":{"url":"https://example.test"},"versions":["1.0.0","2.0.0"]}
        ,
        .{},
    );
    try std.testing.expectEqualStrings("https://example.test", getPath(&value, "repository.url").?.string);
    try std.testing.expectEqualStrings("2.0.0", getPath(&value, "versions[1]").?.string);
    try std.testing.expect(getPath(&value, "versions[9]") == null);
}

test "package info uses Bun's decimal size display" {
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    try writeSize(&output.writer, 9615);
    try std.testing.expectEqualStrings("9.62 KB", output.written());
}
