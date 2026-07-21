const std = @import("std");

const Value = std.json.Value;

pub const Entry = struct {
    name: []const u8,
    path: []const u8,
    relative_path: []const u8,
    version: []const u8,
    has_version: bool,
    package_json: *Value,
};

pub const Diagnostic = union(enum) {
    missing_workspace: []const u8,
    missing_name: []const u8,
    invalid_package_json: []const u8,
    duplicate_name: struct {
        name: []const u8,
        first_path: []const u8,
        duplicate_path: []const u8,
    },
};

pub const Discovery = struct {
    entries: []const Entry,
    diagnostics: []const Diagnostic,
};

pub const Request = struct {
    explicit: bool,
    target_name: []const u8,
    range: ?[]const u8,
    path: ?[]const u8,
};

const Pattern = struct {
    text: []const u8,
    negated: bool,
    has_glob: bool,
};

pub fn discover(
    io: std.Io,
    allocator: std.mem.Allocator,
    root_dir: []const u8,
    root: *const Value,
) !Discovery {
    const patterns = try parsePatterns(allocator, root);
    if (patterns.len == 0) return .{ .entries = &.{}, .diagnostics = &.{} };

    var candidates = std.StringHashMap(bool).init(allocator);
    defer candidates.deinit();
    var scanned_bases = std.StringHashMap(void).init(allocator);
    defer scanned_bases.deinit();
    var diagnostics = std.array_list.Managed(Diagnostic).init(allocator);

    for (patterns) |pattern| {
        if (pattern.negated or isSelfPattern(pattern.text)) continue;
        if (!pattern.has_glob) {
            const relative = try normalizeRelativePath(allocator, pattern.text);
            if (relative.len == 0) continue;
            const package_json_path = try std.fs.path.join(allocator, &.{ root_dir, relative, "package.json" });
            std.Io.Dir.cwd().access(io, package_json_path, .{}) catch {
                try diagnostics.append(.{ .missing_workspace = pattern.text });
                continue;
            };
            const entry = try candidates.getOrPut(relative);
            if (!entry.found_existing) entry.value_ptr.* = true else entry.value_ptr.* = true;
            continue;
        }

        const base = literalGlobBase(pattern.text);
        const normalized_base = try normalizeRelativePath(allocator, base);
        const scan_entry = try scanned_bases.getOrPut(normalized_base);
        if (scan_entry.found_existing) continue;
        const absolute_base = if (normalized_base.len == 0)
            root_dir
        else
            try std.fs.path.join(allocator, &.{ root_dir, normalized_base });
        try scanDirectories(io, allocator, root_dir, absolute_base, patterns, &candidates);
    }

    const candidate_paths = try allocator.alloc([]const u8, candidates.count());
    var candidate_index: usize = 0;
    var candidate_iterator = candidates.keyIterator();
    while (candidate_iterator.next()) |path| : (candidate_index += 1) candidate_paths[candidate_index] = path.*;
    std.mem.sort([]const u8, candidate_paths, {}, lessThanString);

    var entries = std.array_list.Managed(Entry).init(allocator);
    var names = std.StringHashMap(usize).init(allocator);
    defer names.deinit();

    for (candidate_paths) |relative_path| {
        if (!matchesPatterns(patterns, relative_path)) continue;
        const package_json_path = try std.fs.path.join(allocator, &.{ root_dir, relative_path, "package.json" });
        const source = std.Io.Dir.cwd().readFileAlloc(
            io,
            package_json_path,
            allocator,
            .limited(64 * 1024 * 1024),
        ) catch |err| {
            if (candidates.get(relative_path) orelse false) {
                try diagnostics.append(.{ .missing_workspace = relative_path });
            } else if (err != error.FileNotFound) {
                try diagnostics.append(.{ .invalid_package_json = relative_path });
            }
            continue;
        };
        const package_json = try allocator.create(Value);
        package_json.* = std.json.parseFromSliceLeaky(Value, allocator, source, .{}) catch {
            try diagnostics.append(.{ .invalid_package_json = relative_path });
            continue;
        };
        if (package_json.* != .object) {
            try diagnostics.append(.{ .invalid_package_json = relative_path });
            continue;
        }
        const name_value = package_json.object.get("name") orelse {
            try diagnostics.append(.{ .missing_name = relative_path });
            continue;
        };
        if (name_value != .string or name_value.string.len == 0) {
            try diagnostics.append(.{ .missing_name = relative_path });
            continue;
        }

        if (names.get(name_value.string)) |first_index| {
            try diagnostics.append(.{ .duplicate_name = .{
                .name = name_value.string,
                .first_path = entries.items[first_index].relative_path,
                .duplicate_path = relative_path,
            } });
            continue;
        }

        const version_value = package_json.object.get("version");
        const has_version = version_value != null and version_value.? == .string;
        const version = if (has_version) version_value.?.string else "0.0.0";
        const absolute_path = try std.fs.path.join(allocator, &.{ root_dir, relative_path });
        try names.put(name_value.string, entries.items.len);
        try entries.append(.{
            .name = name_value.string,
            .path = absolute_path,
            .relative_path = relative_path,
            .version = version,
            .has_version = has_version,
            .package_json = package_json,
        });
    }

    std.mem.sort(Entry, entries.items, {}, struct {
        fn lessThan(_: void, left: Entry, right: Entry) bool {
            const name_order = std.mem.order(u8, left.name, right.name);
            if (name_order != .eq) return name_order == .lt;
            return std.mem.order(u8, left.relative_path, right.relative_path) == .lt;
        }
    }.lessThan);
    return .{
        .entries = try entries.toOwnedSlice(),
        .diagnostics = try diagnostics.toOwnedSlice(),
    };
}

pub fn matchesManifestPath(
    allocator: std.mem.Allocator,
    manifest: *const Value,
    relative_path: []const u8,
) !bool {
    const patterns = try parsePatterns(allocator, manifest);
    if (patterns.len == 0) return false;
    const normalized = try normalizeRelativePath(allocator, relative_path);
    return normalized.len > 0 and matchesPatterns(patterns, normalized);
}

pub fn parseRequest(alias: []const u8, spec: []const u8) Request {
    if (!std.mem.startsWith(u8, spec, "workspace:")) {
        return .{ .explicit = false, .target_name = alias, .range = spec, .path = null };
    }

    const input = std.mem.trim(u8, spec["workspace:".len..], " \t\r\n");
    if (input.len == 1 and (input[0] == '*' or input[0] == '^' or input[0] == '~')) {
        return .{ .explicit = true, .target_name = alias, .range = null, .path = null };
    }

    const at = std.mem.lastIndexOfScalar(u8, input, '@') orelse 0;
    if (at > 0) {
        return .{
            .explicit = true,
            .target_name = std.mem.trim(u8, input[0..at], " \t\r\n"),
            .range = std.mem.trim(u8, input[at + 1 ..], " \t\r\n"),
            .path = null,
        };
    }

    const path = if (looksLikeWorkspacePath(input)) input else null;
    return .{
        .explicit = true,
        .target_name = alias,
        .range = if (path == null) input else null,
        .path = path,
    };
}

fn parsePatterns(allocator: std.mem.Allocator, root: *const Value) ![]const Pattern {
    if (root.* != .object) return &.{};
    const workspaces = root.object.get("workspaces") orelse return &.{};
    const values = switch (workspaces) {
        .array => |array| array.items,
        .object => |object| blk: {
            const packages = object.get("packages") orelse return &.{};
            if (packages != .array) return error.InvalidWorkspaces;
            break :blk packages.array.items;
        },
        else => return error.InvalidWorkspaces,
    };

    var patterns = std.array_list.Managed(Pattern).init(allocator);
    for (values) |value| {
        if (value != .string) return error.InvalidWorkspaces;
        var text = std.mem.trim(u8, value.string, " \t\r\n");
        var negated = false;
        while (text.len > 0 and text[0] == '!') {
            negated = !negated;
            text = text[1..];
        }
        const normalized = try normalizePattern(allocator, text);
        if (normalized.len == 0) continue;
        try appendExpandedPattern(allocator, &patterns, normalized, negated, 0);
    }
    return patterns.toOwnedSlice();
}

fn scanDirectories(
    io: std.Io,
    allocator: std.mem.Allocator,
    root_dir: []const u8,
    directory_path: []const u8,
    patterns: []const Pattern,
    candidates: *std.StringHashMap(bool),
) !void {
    var directory = std.Io.Dir.cwd().openDir(io, directory_path, .{ .iterate = true }) catch return;
    defer directory.close(io);

    if (!std.mem.eql(u8, root_dir, directory_path)) {
        const relative = try normalizedRelativeFrom(allocator, root_dir, directory_path);
        if (matchesPatterns(patterns, relative)) {
            const package_json_path = try std.fs.path.join(allocator, &.{ directory_path, "package.json" });
            if (std.Io.Dir.cwd().access(io, package_json_path, .{})) |_| {
                const entry = try candidates.getOrPut(relative);
                if (!entry.found_existing) entry.value_ptr.* = false;
            } else |_| {}
        }
    }

    var iterator = directory.iterate();
    while (try iterator.next(io)) |entry| {
        if (entry.kind != .directory or isIgnoredDirectory(entry.name)) continue;
        const child = try std.fs.path.join(allocator, &.{ directory_path, entry.name });
        try scanDirectories(io, allocator, root_dir, child, patterns, candidates);
    }
}

fn matchesPatterns(patterns: []const Pattern, relative_path: []const u8) bool {
    var included = false;
    for (patterns) |pattern| {
        if (globMatch(pattern.text, relative_path)) included = !pattern.negated;
    }
    return included;
}

pub fn globMatch(pattern: []const u8, path: []const u8) bool {
    return globMatchAt(pattern, 0, path, 0);
}

fn globMatchAt(pattern: []const u8, pattern_index: usize, path: []const u8, path_index: usize) bool {
    var p = pattern_index;
    var s = path_index;
    while (p < pattern.len) {
        if (pattern[p] == '*') {
            var star_end = p + 1;
            while (star_end < pattern.len and pattern[star_end] == '*') star_end += 1;
            if (star_end - p >= 2) {
                if (star_end < pattern.len and isSeparator(pattern[star_end])) {
                    const suffix = star_end + 1;
                    if (globMatchAt(pattern, suffix, path, s)) return true;
                    var index = s;
                    while (index < path.len) : (index += 1) {
                        if (isSeparator(path[index]) and globMatchAt(pattern, suffix, path, index + 1)) return true;
                    }
                    return false;
                }
                var index = s;
                while (true) : (index += 1) {
                    if (globMatchAt(pattern, star_end, path, index)) return true;
                    if (index == path.len) return false;
                }
            }

            var index = s;
            while (true) : (index += 1) {
                if (globMatchAt(pattern, star_end, path, index)) return true;
                if (index == path.len or isSeparator(path[index])) return false;
            }
        }
        if (s >= path.len) return false;
        if (pattern[p] == '?') {
            if (isSeparator(path[s])) return false;
            p += 1;
            s += 1;
            continue;
        }
        if (pattern[p] == '[') {
            const class = matchCharacterClass(pattern, p, path[s]) orelse return false;
            if (!class.matched) return false;
            p = class.next_index;
            s += 1;
            continue;
        }
        if (isSeparator(pattern[p])) {
            if (!isSeparator(path[s])) return false;
        } else if (pattern[p] != path[s]) {
            return false;
        }
        p += 1;
        s += 1;
    }
    return s == path.len;
}

const CharacterClassResult = struct {
    matched: bool,
    next_index: usize,
};

fn matchCharacterClass(pattern: []const u8, start: usize, value: u8) ?CharacterClassResult {
    if (isSeparator(value)) return null;
    var index = start + 1;
    var negated = false;
    if (index < pattern.len and (pattern[index] == '!' or pattern[index] == '^')) {
        negated = true;
        index += 1;
    }
    var matched = false;
    var had_value = false;
    while (index < pattern.len and pattern[index] != ']') {
        had_value = true;
        if (index + 2 < pattern.len and pattern[index + 1] == '-' and pattern[index + 2] != ']') {
            matched = matched or (value >= pattern[index] and value <= pattern[index + 2]);
            index += 3;
        } else {
            matched = matched or value == pattern[index];
            index += 1;
        }
    }
    if (!had_value or index >= pattern.len) return null;
    return .{ .matched = if (negated) !matched else matched, .next_index = index + 1 };
}

fn literalGlobBase(pattern: []const u8) []const u8 {
    const glob_index = std.mem.indexOfAny(u8, pattern, "*?[{") orelse return pattern;
    const slash = std.mem.lastIndexOfScalar(u8, pattern[0..glob_index], '/') orelse return "";
    return pattern[0..slash];
}

fn normalizePattern(allocator: std.mem.Allocator, input: []const u8) ![]const u8 {
    var normalized = try allocator.dupe(u8, input);
    std.mem.replaceScalar(u8, normalized, '\\', '/');
    while (std.mem.startsWith(u8, normalized, "./")) normalized = normalized[2..];
    while (normalized.len > 0 and normalized[normalized.len - 1] == '/') normalized = normalized[0 .. normalized.len - 1];
    return normalized;
}

fn normalizeRelativePath(allocator: std.mem.Allocator, input: []const u8) ![]const u8 {
    const normalized = try normalizePattern(allocator, input);
    if (normalized.len == 0) return normalized;
    const resolved = try std.fs.path.resolve(allocator, &.{normalized});
    std.mem.replaceScalar(u8, resolved, '\\', '/');
    return resolved;
}

fn normalizedRelativeFrom(allocator: std.mem.Allocator, root: []const u8, path: []const u8) ![]const u8 {
    const relative = try std.fs.path.relative(allocator, root, null, root, path);
    const normalized = try allocator.dupe(u8, relative);
    std.mem.replaceScalar(u8, normalized, '\\', '/');
    return normalized;
}

fn hasGlobSyntax(pattern: []const u8) bool {
    return std.mem.indexOfAny(u8, pattern, "*?[{") != null;
}

fn appendExpandedPattern(
    allocator: std.mem.Allocator,
    patterns: *std.array_list.Managed(Pattern),
    text: []const u8,
    negated: bool,
    depth: u8,
) !void {
    if (depth >= 10) return error.InvalidWorkspaceGlob;
    const open = std.mem.indexOfScalar(u8, text, '{') orelse {
        try patterns.append(.{ .text = text, .negated = negated, .has_glob = hasGlobSyntax(text) });
        return;
    };
    var level: usize = 0;
    var close: ?usize = null;
    var index = open + 1;
    while (index < text.len) : (index += 1) {
        switch (text[index]) {
            '{' => level += 1,
            '}' => if (level == 0) {
                close = index;
                break;
            } else {
                level -= 1;
            },
            else => {},
        }
    }
    const close_index = close orelse return error.InvalidWorkspaceGlob;
    var branch_start = open + 1;
    level = 0;
    index = branch_start;
    while (index <= close_index) : (index += 1) {
        const at_end = index == close_index;
        if (!at_end) {
            switch (text[index]) {
                '{' => level += 1,
                '}' => level -= 1,
                ',' => if (level != 0) continue,
                else => continue,
            }
        }
        const expanded = try std.fmt.allocPrint(allocator, "{s}{s}{s}", .{
            text[0..open],
            text[branch_start..index],
            text[close_index + 1 ..],
        });
        try appendExpandedPattern(allocator, patterns, expanded, negated, depth + 1);
        branch_start = index + 1;
    }
}

fn isSelfPattern(pattern: []const u8) bool {
    return pattern.len == 0 or std.mem.eql(u8, pattern, ".");
}

fn isIgnoredDirectory(name: []const u8) bool {
    return std.mem.eql(u8, name, "node_modules") or
        std.mem.eql(u8, name, ".git") or
        std.mem.eql(u8, name, "CMakeFiles");
}

fn looksLikeWorkspacePath(value: []const u8) bool {
    return std.mem.eql(u8, value, ".") or
        std.mem.eql(u8, value, "..") or
        std.mem.startsWith(u8, value, "./") or
        std.mem.startsWith(u8, value, "../") or
        (!std.mem.startsWith(u8, value, "@") and std.mem.indexOfScalar(u8, value, '/') != null);
}

fn isSeparator(byte: u8) bool {
    return byte == '/' or byte == '\\';
}

fn lessThanString(_: void, left: []const u8, right: []const u8) bool {
    return std.mem.order(u8, left, right) == .lt;
}

test "workspace globs preserve ordered exclusions and globstar semantics" {
    const patterns = [_]Pattern{
        .{ .text = "packages/**", .negated = false, .has_glob = true },
        .{ .text = "packages/private/*", .negated = true, .has_glob = true },
        .{ .text = "packages/private/public", .negated = false, .has_glob = false },
    };
    try std.testing.expect(matchesPatterns(&patterns, "packages/a"));
    try std.testing.expect(matchesPatterns(&patterns, "packages/nested/a"));
    try std.testing.expect(!matchesPatterns(&patterns, "packages/private/secret"));
    try std.testing.expect(matchesPatterns(&patterns, "packages/private/public"));
    try std.testing.expect(!globMatch("packages/*", "packages/nested/a"));
    try std.testing.expect(globMatch("packages/**/*", "packages/a"));
    try std.testing.expect(globMatch("packages/**/*", "packages/nested/a"));

    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    var expanded = std.array_list.Managed(Pattern).init(arena.allocator());
    defer expanded.deinit();
    try appendExpandedPattern(arena.allocator(), &expanded, "{packages,apps}/*", false, 0);
    try std.testing.expectEqual(@as(usize, 2), expanded.items.len);
    try std.testing.expect(matchesPatterns(expanded.items, "apps/site"));
}

test "workspace protocol parses aliases ranges and paths like Bun" {
    try std.testing.expectEqualDeep(Request{
        .explicit = true,
        .target_name = "@scope/pkg",
        .range = "^1.0.0",
        .path = null,
    }, parseRequest("alias", "workspace:@scope/pkg@^1.0.0"));
    try std.testing.expectEqualDeep(Request{
        .explicit = true,
        .target_name = "alias",
        .range = null,
        .path = null,
    }, parseRequest("alias", "workspace:*"));
    try std.testing.expectEqualDeep(Request{
        .explicit = true,
        .target_name = "alias",
        .range = null,
        .path = "packages/pkg",
    }, parseRequest("alias", "workspace:packages/pkg"));
}

test "workspace discovery handles recursive globs exclusions braces and diagnostics" {
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.createDirPath(io, "packages/core");
    try tmp.dir.createDirPath(io, "packages/nested/types");
    try tmp.dir.createDirPath(io, "packages/private/secret");
    try tmp.dir.createDirPath(io, "apps/site");
    try tmp.dir.writeFile(io, .{ .sub_path = "packages/core/package.json", .data = "{\"name\":\"core\",\"version\":\"1.2.3\"}" });
    try tmp.dir.writeFile(io, .{ .sub_path = "packages/nested/types/package.json", .data = "{\"name\":\"types\"}" });
    try tmp.dir.writeFile(io, .{ .sub_path = "packages/private/secret/package.json", .data = "{\"name\":\"secret\"}" });
    try tmp.dir.writeFile(io, .{ .sub_path = "apps/site/package.json", .data = "{\"name\":\"site\",\"version\":\"2.0.0\"}" });

    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    const relative_root = try std.fs.path.join(allocator, &.{ ".zig-cache", "tmp", &tmp.sub_path });
    const absolute_root = try std.Io.Dir.cwd().realPathFileAlloc(io, relative_root, allocator);
    var root = try std.json.parseFromSliceLeaky(Value, allocator,
        \\{"workspaces":["{packages,apps}/**/*","!packages/private/*","missing"]}
    , .{});
    const result = try discover(io, allocator, absolute_root, &root);

    try std.testing.expectEqual(@as(usize, 3), result.entries.len);
    try std.testing.expectEqualStrings("core", result.entries[0].name);
    try std.testing.expectEqualStrings("site", result.entries[1].name);
    try std.testing.expectEqualStrings("types", result.entries[2].name);
    try std.testing.expect(result.entries[0].has_version);
    try std.testing.expect(!result.entries[2].has_version);
    try std.testing.expectEqual(@as(usize, 1), result.diagnostics.len);
    try std.testing.expectEqualStrings("missing", result.diagnostics[0].missing_workspace);
}

test "workspace discovery rejects duplicate package names deterministically" {
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.createDirPath(io, "packages/a");
    try tmp.dir.createDirPath(io, "packages/b");
    try tmp.dir.writeFile(io, .{ .sub_path = "packages/a/package.json", .data = "{\"name\":\"duplicate\",\"version\":\"1.0.0\"}" });
    try tmp.dir.writeFile(io, .{ .sub_path = "packages/b/package.json", .data = "{\"name\":\"duplicate\",\"version\":\"2.0.0\"}" });

    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    const relative_root = try std.fs.path.join(allocator, &.{ ".zig-cache", "tmp", &tmp.sub_path });
    const absolute_root = try std.Io.Dir.cwd().realPathFileAlloc(io, relative_root, allocator);
    var root = try std.json.parseFromSliceLeaky(Value, allocator, "{\"workspaces\":[\"packages/*\"]}", .{});
    const result = try discover(io, allocator, absolute_root, &root);

    try std.testing.expectEqual(@as(usize, 1), result.entries.len);
    try std.testing.expectEqual(@as(usize, 1), result.diagnostics.len);
    const duplicate = result.diagnostics[0].duplicate_name;
    try std.testing.expectEqualStrings("duplicate", duplicate.name);
    try std.testing.expectEqualStrings("packages/a", duplicate.first_path);
    try std.testing.expectEqualStrings("packages/b", duplicate.duplicate_path);
}
