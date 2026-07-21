const std = @import("std");
const Lockfile = @import("package_manager_lockfile.zig");
const BunLockfile = @import("package_manager_bun_lockfile.zig");

const Value = std.json.Value;
const default_registry = "https://registry.npmjs.org";
const max_lockfile_bytes = 256 * 1024 * 1024;
const max_response_bytes = 64 * 1024 * 1024;

const Severity = enum(u8) {
    low,
    moderate,
    high,
    critical,

    fn parse(value: []const u8) ?Severity {
        inline for (std.meta.tags(Severity)) |tag| {
            if (std.mem.eql(u8, value, @tagName(tag))) return tag;
        }
        return null;
    }

    fn includes(minimum: Severity, value: []const u8) bool {
        const actual = parse(value) orelse .moderate;
        return @intFromEnum(actual) >= @intFromEnum(minimum);
    }
};

const Options = struct {
    json: bool = false,
    production: bool = false,
    audit_level: ?Severity = null,
    ignores: std.array_list.Managed([]const u8),

    fn init(allocator: std.mem.Allocator) Options {
        return .{ .ignores = .init(allocator) };
    }
};

const PackageVersions = struct {
    name: []const u8,
    versions: std.array_list.Managed([]const u8),
};

const AuditPackages = struct {
    body: []const u8,
    skipped: std.array_list.Managed([]const u8),
};

const Vulnerability = struct {
    package_name: []const u8,
    severity: []const u8,
    title: []const u8,
    url: []const u8,
    vulnerable_versions: []const u8,
    id: []const u8,
};

const PackageReport = struct {
    name: []const u8,
    vulnerable_versions: []const u8,
    vulnerabilities: std.array_list.Managed(Vulnerability),
};

const Counts = struct {
    low: usize = 0,
    moderate: usize = 0,
    high: usize = 0,
    critical: usize = 0,

    fn add(counts: *Counts, severity: []const u8) void {
        switch (Severity.parse(severity) orelse .moderate) {
            .low => counts.low += 1,
            .moderate => counts.moderate += 1,
            .high => counts.high += 1,
            .critical => counts.critical += 1,
        }
    }

    fn total(counts: Counts) usize {
        return counts.low + counts.moderate + counts.high + counts.critical;
    }
};

pub fn run(
    init: std.process.Init,
    args: []const [:0]const u8,
    stdout: *std.Io.Writer,
    stderr: *std.Io.Writer,
) !u8 {
    const allocator = init.arena.allocator();
    const options = parseOptions(allocator, args, stderr) catch |err| {
        if (err != error.AuditErrorReported) try stderr.print("error: {s}\n", .{@errorName(err)});
        try stderr.flush();
        return 1;
    };

    const cwd = try std.Io.Dir.cwd().realPathFileAlloc(init.io, ".", allocator);
    const root_dir = try findPackageDir(init.io, allocator, cwd) orelse {
        try stderr.print("error: No package.json was found for directory \"{s}\"\n", .{cwd});
        try stderr.writeAll("note: Run \"bun init\" to initialize a project\n");
        try stderr.flush();
        return 1;
    };

    var graph = loadLockfile(init.io, allocator, root_dir) catch |err| {
        switch (err) {
            error.FileNotFound => try stderr.writeAll("error: Lockfile not found\n"),
            else => try stderr.print("error: Unable to load lockfile: {s}\n", .{@errorName(err)}),
        }
        try stderr.flush();
        return 1;
    };
    defer graph.deinit();

    const registry = try registryFromEnvironment(allocator, init.environ_map);
    const scoped_registries = try readScopedRegistries(init.io, allocator, root_dir);
    const packages = try collectPackages(allocator, &graph, options.production, scoped_registries);

    const response = sendRequest(init, allocator, registry, packages.body) catch |err| {
        if (err != error.AuditErrorReported) try stderr.print("error: audit request failed: {s}\n", .{@errorName(err)});
        try stderr.flush();
        return 1;
    };
    const parsed = std.json.parseFromSliceLeaky(Value, allocator, response, .{}) catch {
        try stderr.writeAll("error: audit request failed to parse json. Is the registry down?\n");
        try stderr.flush();
        return 1;
    };

    if (options.json) {
        try stdout.writeAll(response);
        try stdout.writeByte('\n');
        try stdout.flush();
        return if (parsed == .object and parsed.object.count() == 0) 0 else 1;
    }

    const result = try printReport(allocator, &graph, &parsed, options, stdout);
    try printSkipped(packages.skipped.items, stdout);
    try stdout.flush();
    return result;
}

fn parseOptions(
    allocator: std.mem.Allocator,
    args: []const [:0]const u8,
    stderr: *std.Io.Writer,
) !Options {
    var options = Options.init(allocator);
    var index: usize = 2;
    while (index < args.len) : (index += 1) {
        const arg = args[index];
        if (std.mem.eql(u8, arg, "--json")) {
            options.json = true;
        } else if (std.mem.eql(u8, arg, "--prod") or std.mem.eql(u8, arg, "--production")) {
            options.production = true;
        } else if (std.mem.eql(u8, arg, "--audit-level")) {
            index += 1;
            if (index >= args.len) return reportInvalidAuditLevel(stderr, "");
            options.audit_level = Severity.parse(args[index]) orelse return reportInvalidAuditLevel(stderr, args[index]);
        } else if (std.mem.startsWith(u8, arg, "--audit-level=")) {
            const value = arg["--audit-level=".len..];
            options.audit_level = Severity.parse(value) orelse return reportInvalidAuditLevel(stderr, value);
        } else if (std.mem.eql(u8, arg, "--ignore")) {
            index += 1;
            if (index >= args.len) return error.MissingAuditIgnore;
            try options.ignores.append(args[index]);
        } else if (std.mem.startsWith(u8, arg, "--ignore=")) {
            try options.ignores.append(arg["--ignore=".len..]);
        } else if (std.mem.eql(u8, arg, "--help") or std.mem.eql(u8, arg, "-h")) {
            // The root CLI owns help output. Accepting it here preserves Bun's
            // package-command option grammar without treating it as a package.
        } else {
            try stderr.print("error: unknown option '{s}'\n", .{arg});
            return error.AuditErrorReported;
        }
    }
    return options;
}

fn reportInvalidAuditLevel(stderr: *std.Io.Writer, value: []const u8) error{AuditErrorReported} {
    stderr.print("error: invalid `--audit-level` value: '{s}'\n", .{value}) catch {};
    stderr.writeAll("Valid values are: low, moderate, high, critical\n") catch {};
    return error.AuditErrorReported;
}

fn findPackageDir(io: std.Io, allocator: std.mem.Allocator, cwd: []const u8) !?[]const u8 {
    var current = cwd;
    while (true) {
        const path = try std.fs.path.join(allocator, &.{ current, "package.json" });
        if (std.Io.Dir.cwd().access(io, path, .{})) |_| return current else |_| {}
        const parent = std.fs.path.dirname(current) orelse return null;
        if (std.mem.eql(u8, parent, current)) return null;
        current = parent;
    }
}

fn loadLockfile(io: std.Io, allocator: std.mem.Allocator, root_dir: []const u8) !Lockfile.Graph {
    const text_path = try std.fs.path.join(allocator, &.{ root_dir, "bun.lock" });
    if (try readOptionalFile(io, allocator, text_path, max_lockfile_bytes)) |source| {
        return Lockfile.parseText(allocator, source);
    }

    const binary_path = try std.fs.path.join(allocator, &.{ root_dir, "bun.lockb" });
    const binary = try std.Io.Dir.cwd().readFileAlloc(io, binary_path, allocator, .limited(max_lockfile_bytes));
    return Lockfile.parseText(allocator, try BunLockfile.binaryToText(allocator, binary));
}

fn readOptionalFile(io: std.Io, allocator: std.mem.Allocator, path: []const u8, limit: usize) !?[]const u8 {
    return std.Io.Dir.cwd().readFileAlloc(io, path, allocator, .limited(limit)) catch |err| switch (err) {
        error.FileNotFound => null,
        else => return err,
    };
}

fn registryFromEnvironment(allocator: std.mem.Allocator, environment: *const std.process.Environ.Map) ![]const u8 {
    const raw = environment.get("NPM_CONFIG_REGISTRY") orelse
        environment.get("npm_config_registry") orelse
        environment.get("BUN_CONFIG_REGISTRY") orelse
        default_registry;
    return allocator.dupe(u8, std.mem.trimEnd(u8, raw, "/"));
}

fn readScopedRegistries(
    io: std.Io,
    allocator: std.mem.Allocator,
    root_dir: []const u8,
) !std.StringHashMap([]const u8) {
    var result = std.StringHashMap([]const u8).init(allocator);
    const path = try std.fs.path.join(allocator, &.{ root_dir, ".npmrc" });
    const source = (try readOptionalFile(io, allocator, path, 1024 * 1024)) orelse return result;
    var lines = std.mem.splitScalar(u8, source, '\n');
    while (lines.next()) |raw_line| {
        const line = std.mem.trim(u8, raw_line, " \t\r");
        if (line.len < 12 or line[0] != '@') continue;
        const separator = std.mem.indexOf(u8, line, ":registry=") orelse continue;
        const scope = line[0..separator];
        const registry = std.mem.trim(u8, line[separator + ":registry=".len ..], " \t\r/");
        try result.put(try allocator.dupe(u8, scope), try allocator.dupe(u8, registry));
    }
    return result;
}

fn collectPackages(
    allocator: std.mem.Allocator,
    graph: *const Lockfile.Graph,
    production: bool,
    scoped_registries: std.StringHashMap([]const u8),
) !AuditPackages {
    var package_versions = std.array_list.Managed(PackageVersions).init(allocator);
    var skipped = std.array_list.Managed([]const u8).init(allocator);
    var production_names = std.StringHashMap(void).init(allocator);
    if (production) try collectProductionNames(allocator, graph, &production_names);

    const package_entries = graph.document.object.get("packages") orelse return error.InvalidPackagesObject;
    if (package_entries != .object) return error.InvalidPackagesObject;
    for (package_entries.object.keys()) |key| {
        const package = graph.get(key) orelse continue;
        if (package.kind != .npm or package.name.len == 0 or package.version.len == 0) continue;
        if (production and !production_names.contains(package.name)) continue;
        if (packageScope(package.name)) |scope| {
            if (scoped_registries.contains(scope)) {
                if (!containsString(skipped.items, package.name)) try skipped.append(package.name);
                continue;
            }
        }

        var found: ?*PackageVersions = null;
        for (package_versions.items) |*item| {
            if (std.mem.eql(u8, item.name, package.name)) {
                found = item;
                break;
            }
        }
        if (found == null) {
            try package_versions.append(.{ .name = package.name, .versions = .init(allocator) });
            found = &package_versions.items[package_versions.items.len - 1];
        }
        if (!containsString(found.?.versions.items, package.version)) try found.?.versions.append(package.version);
    }

    std.mem.sort(PackageVersions, package_versions.items, {}, struct {
        fn lessThan(_: void, left: PackageVersions, right: PackageVersions) bool {
            return std.mem.order(u8, left.name, right.name) == .lt;
        }
    }.lessThan);
    std.mem.sort([]const u8, skipped.items, {}, lessString);

    var body: std.Io.Writer.Allocating = .init(allocator);
    try body.writer.writeByte('{');
    for (package_versions.items, 0..) |item, package_index| {
        if (package_index != 0) try body.writer.writeByte(',');
        try std.json.Stringify.value(item.name, .{}, &body.writer);
        try body.writer.writeAll(":[");
        for (item.versions.items, 0..) |package_version, version_index| {
            if (version_index != 0) try body.writer.writeByte(',');
            try std.json.Stringify.value(package_version, .{}, &body.writer);
        }
        try body.writer.writeByte(']');
    }
    try body.writer.writeByte('}');
    return .{ .body = try body.toOwnedSlice(), .skipped = skipped };
}

fn collectProductionNames(
    allocator: std.mem.Allocator,
    graph: *const Lockfile.Graph,
    names: *std.StringHashMap(void),
) !void {
    var queue = std.array_list.Managed([]const u8).init(allocator);
    try appendDependencyNames(graph.root_workspace, "dependencies", &queue);
    try appendDependencyNames(graph.root_workspace, "optionalDependencies", &queue);
    var index: usize = 0;
    while (index < queue.items.len) : (index += 1) {
        const name = queue.items[index];
        if (names.contains(name)) continue;
        try names.put(name, {});
        if (findPackageByName(graph, name)) |package| {
            if (package.info) |metadata| {
                try appendDependencyNames(metadata, "dependencies", &queue);
                try appendDependencyNames(metadata, "optionalDependencies", &queue);
            }
        }
    }
}

fn appendDependencyNames(value: *const Value, section: []const u8, queue: *std.array_list.Managed([]const u8)) !void {
    if (value.* != .object) return;
    const dependencies = value.object.get(section) orelse return;
    if (dependencies != .object) return;
    for (dependencies.object.keys()) |name| try queue.append(name);
}

fn packageScope(name: []const u8) ?[]const u8 {
    if (name.len < 3 or name[0] != '@') return null;
    const slash = std.mem.indexOfScalar(u8, name, '/') orelse return null;
    return name[0..slash];
}

fn containsString(values: []const []const u8, needle: []const u8) bool {
    for (values) |value| if (std.mem.eql(u8, value, needle)) return true;
    return false;
}

fn lessString(_: void, left: []const u8, right: []const u8) bool {
    return std.mem.order(u8, left, right) == .lt;
}

fn gzip(allocator: std.mem.Allocator, source: []const u8) ![]const u8 {
    var output = try std.Io.Writer.Allocating.initCapacity(allocator, @max(@as(usize, 64), source.len / 2));
    const history = try allocator.alloc(u8, std.compress.flate.max_window_len * 2);
    var compressor = try std.compress.flate.Compress.init(&output.writer, history, .gzip, .default);
    try compressor.writer.writeAll(source);
    try compressor.finish();
    return output.toOwnedSlice();
}

fn sendRequest(
    init: std.process.Init,
    allocator: std.mem.Allocator,
    registry: []const u8,
    body: []const u8,
) ![]const u8 {
    const compressed = try gzip(allocator, body);
    const url = try std.fmt.allocPrint(allocator, "{s}/-/npm/v1/security/advisories/bulk", .{registry});
    var client: std.http.Client = .{ .allocator = std.heap.smp_allocator, .io = init.io };
    defer client.deinit();
    client.initDefaultProxies(allocator, init.environ_map) catch {};

    var headers: [4]std.http.Header = undefined;
    var count: usize = 0;
    headers[count] = .{ .name = "accept", .value = "application/json" };
    count += 1;
    headers[count] = .{ .name = "content-type", .value = "application/json" };
    count += 1;
    headers[count] = .{ .name = "content-encoding", .value = "gzip" };
    count += 1;
    if (init.environ_map.get("BUN_CONFIG_TOKEN") orelse init.environ_map.get("NPM_CONFIG_TOKEN")) |token| {
        headers[count] = .{ .name = "authorization", .value = try std.fmt.allocPrint(allocator, "Bearer {s}", .{token}) };
        count += 1;
    }

    var response: std.Io.Writer.Allocating = .init(allocator);
    const result = client.fetch(.{
        .location = .{ .url = url },
        .method = .POST,
        .payload = compressed,
        .response_writer = &response.writer,
        .extra_headers = headers[0..count],
    }) catch return error.AuditRequestFailed;
    const status: u16 = @intFromEnum(result.status);
    if (status < 200 or status >= 300) return error.AuditRequestFailed;
    if (response.written().len > max_response_bytes) return error.ResponseTooLarge;
    return response.toOwnedSlice();
}

fn printReport(
    allocator: std.mem.Allocator,
    graph: *const Lockfile.Graph,
    response: *const Value,
    options: Options,
    stdout: *std.Io.Writer,
) !u8 {
    if (response.* != .object) {
        try std.json.Stringify.value(response.*, .{}, stdout);
        try stdout.writeByte('\n');
        return 1;
    }
    if (response.object.count() == 0) {
        try stdout.writeAll("No vulnerabilities found\n");
        return 0;
    }

    var reports = std.StringHashMap(PackageReport).init(allocator);
    var counts: Counts = .{};
    for (response.object.keys(), response.object.values()) |package_name, advisories| {
        if (advisories != .array) continue;
        var report = PackageReport{
            .name = package_name,
            .vulnerable_versions = "",
            .vulnerabilities = .init(allocator),
        };
        for (advisories.array.items) |advisory| {
            if (advisory != .object) continue;
            const vulnerability = parseVulnerability(package_name, &advisory);
            if (options.audit_level) |minimum| {
                if (!minimum.includes(vulnerability.severity)) continue;
            }
            if (isIgnored(vulnerability, options.ignores.items)) continue;
            if (report.vulnerable_versions.len == 0) report.vulnerable_versions = vulnerability.vulnerable_versions;
            try report.vulnerabilities.append(vulnerability);
            counts.add(vulnerability.severity);
        }
        if (report.vulnerabilities.items.len > 0) try reports.put(package_name, report);
    }

    if (counts.total() == 0) {
        try stdout.writeAll("No vulnerabilities found\n");
        return 0;
    }

    var report_iterator = reports.iterator();
    while (report_iterator.next()) |entry| {
        const report = entry.value_ptr;
        if (report.vulnerable_versions.len > 0) {
            try stdout.print("{s}  {s}\n", .{ report.name, report.vulnerable_versions });
        } else {
            try stdout.print("{s}\n", .{report.name});
        }
        try printDependencyPath(allocator, graph, report.name, stdout);
        for (report.vulnerabilities.items) |vulnerability| {
            try stdout.print("  {s}: {s} - {s}\n", .{ vulnerability.severity, vulnerability.title, vulnerability.url });
        }
        try stdout.writeByte('\n');
    }

    try stdout.print("{d} vulnerabilities (", .{counts.total()});
    var needs_separator = false;
    for ([_]struct { count: usize, name: []const u8 }{
        .{ .count = counts.critical, .name = "critical" },
        .{ .count = counts.high, .name = "high" },
        .{ .count = counts.moderate, .name = "moderate" },
        .{ .count = counts.low, .name = "low" },
    }) |entry| {
        if (entry.count == 0) continue;
        if (needs_separator) try stdout.writeAll(", ");
        try stdout.print("{d} {s}", .{ entry.count, entry.name });
        needs_separator = true;
    }
    try stdout.writeAll(")\n\n");
    try stdout.writeAll("To update all dependencies to the latest compatible versions:\n  bun update\n\n");
    try stdout.writeAll("To update all dependencies to the latest versions (including breaking changes):\n  bun update --latest\n\n");
    return 1;
}

fn printSkipped(skipped: []const []const u8, stdout: *std.Io.Writer) !void {
    if (skipped.len == 0) return;
    try stdout.writeAll("Skipped ");
    for (skipped, 0..) |name, index| {
        if (index != 0) try stdout.writeAll(", ");
        try stdout.writeAll(name);
    }
    try stdout.writeAll(if (skipped.len == 1)
        " because it does not come from the default registry\n\n"
    else
        " because they do not come from the default registry\n\n");
}

fn parseVulnerability(package_name: []const u8, advisory: *const Value) Vulnerability {
    return .{
        .package_name = package_name,
        .severity = jsonString(advisory, "severity") orelse "moderate",
        .title = jsonString(advisory, "title") orelse "Vulnerability found",
        .url = jsonString(advisory, "url") orelse "",
        .vulnerable_versions = jsonString(advisory, "vulnerable_versions") orelse "",
        .id = jsonId(advisory),
    };
}

fn jsonString(value: *const Value, key: []const u8) ?[]const u8 {
    if (value.* != .object) return null;
    const field = value.object.get(key) orelse return null;
    return if (field == .string) field.string else null;
}

fn jsonId(value: *const Value) []const u8 {
    if (value.* != .object) return "";
    const field = value.object.get("id") orelse return "";
    return if (field == .string) field.string else "";
}

fn isIgnored(vulnerability: Vulnerability, ignores: []const []const u8) bool {
    for (ignores) |ignored| {
        if (std.mem.eql(u8, vulnerability.id, ignored) or std.mem.indexOf(u8, vulnerability.url, ignored) != null) return true;
    }
    return false;
}

fn printDependencyPath(
    allocator: std.mem.Allocator,
    graph: *const Lockfile.Graph,
    target: []const u8,
    stdout: *std.Io.Writer,
) !void {
    if (dependencySectionContains(graph.root_workspace, target)) {
        try stdout.writeAll("  (direct dependency)\n");
        return;
    }
    var workspaces = graph.workspaces.iterator();
    while (workspaces.next()) |entry| {
        if (entry.key_ptr.len == 0) continue;
        if (dependencySectionContains(entry.value_ptr.*, target)) {
            const workspace_name = jsonString(entry.value_ptr.*, "name") orelse entry.key_ptr.*;
            try stdout.print("  workspace:{s} \u{203a} {s}\n", .{ workspace_name, target });
            return;
        }
    }

    var reverse_dependencies = std.StringHashMap(std.array_list.Managed([]const u8)).init(allocator);
    const package_entries = graph.document.object.get("packages") orelse return;
    if (package_entries != .object) return;
    for (package_entries.object.keys()) |key| {
        const package = graph.get(key) orelse continue;
        if (package.kind != .npm) continue;
        const metadata = package.info orelse continue;
        try appendReverseDependencies(allocator, &reverse_dependencies, package.name, metadata);
    }

    var queue = std.array_list.Managed([]const u8).init(allocator);
    var parent = std.StringHashMap([]const u8).init(allocator);
    if (reverse_dependencies.get(target)) |dependents| {
        for (dependents.items) |dependent| {
            try queue.append(dependent);
            try parent.put(dependent, target);
        }
    }
    var visited = std.StringHashMap(void).init(allocator);
    var index: usize = 0;
    while (index < queue.items.len) : (index += 1) {
        const current = queue.items[index];
        if (visited.contains(current)) continue;
        try visited.put(current, {});
        if (dependencySectionContains(graph.root_workspace, current)) {
            var chain = std.array_list.Managed([]const u8).init(allocator);
            var trace = current;
            var trace_seen = std.StringHashMap(void).init(allocator);
            while (!trace_seen.contains(trace)) {
                try trace_seen.put(trace, {});
                try chain.append(trace);
                trace = parent.get(trace) orelse break;
            }
            try stdout.writeAll("  ");
            for (chain.items, 0..) |name, path_index| {
                if (path_index != 0) try stdout.writeAll(" \u{203a} ");
                try stdout.writeAll(name);
            }
            try stdout.writeByte('\n');
            return;
        }
        if (reverse_dependencies.get(current)) |dependents| {
            for (dependents.items) |dependent| {
                if (visited.contains(dependent)) continue;
                try queue.append(dependent);
                try parent.put(dependent, current);
            }
        }
    }
}

fn appendReverseDependencies(
    allocator: std.mem.Allocator,
    reverse_dependencies: *std.StringHashMap(std.array_list.Managed([]const u8)),
    parent: []const u8,
    metadata: *const Value,
) !void {
    if (metadata.* != .object) return;
    for ([_][]const u8{ "dependencies", "optionalDependencies", "devDependencies" }) |section| {
        const dependencies = metadata.object.get(section) orelse continue;
        if (dependencies != .object) continue;
        for (dependencies.object.keys()) |child| {
            const result = try reverse_dependencies.getOrPut(child);
            if (!result.found_existing) result.value_ptr.* = .init(allocator);
            try result.value_ptr.append(parent);
        }
    }
}

fn dependencySectionContains(value: *const Value, name: []const u8) bool {
    for ([_][]const u8{ "dependencies", "optionalDependencies", "devDependencies" }) |section| {
        if (value.* != .object) continue;
        if (value.object.get(section)) |dependencies| {
            if (dependencies == .object and dependencies.object.get(name) != null) return true;
        }
    }
    return false;
}

fn findPackageByName(graph: *const Lockfile.Graph, name: []const u8) ?*const Lockfile.Package {
    if (graph.get(name)) |package| return package;
    var packages = graph.packages.iterator();
    while (packages.next()) |entry| {
        if (std.mem.eql(u8, entry.value_ptr.name, name)) return entry.value_ptr;
    }
    return null;
}

test "audit severity threshold includes equal and greater severities" {
    try std.testing.expect(Severity.moderate.includes("moderate"));
    try std.testing.expect(Severity.moderate.includes("critical"));
    try std.testing.expect(!Severity.moderate.includes("low"));
}

test "audit dependency path recognizes direct dependencies" {
    const source =
        \\{"lockfileVersion":1,"workspaces":{"":{"dependencies":{"foo":"1"}}},"packages":{"foo":["foo@1.0.0","",{}]}}
    ;
    var graph = try Lockfile.parseText(std.testing.allocator, source);
    defer graph.deinit();
    try std.testing.expect(dependencySectionContains(graph.root_workspace, "foo"));
}
