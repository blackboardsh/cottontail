const std = @import("std");
const BunLockfile = @import("package_manager_bun_lockfile.zig");
const Lockfile = @import("package_manager_lockfile.zig");
const Manifest = @import("package_manager_manifest.zig");
const Scripts = @import("package_manager_scripts.zig");

const Value = std.json.Value;
const max_lockfile_bytes = 256 * 1024 * 1024;
const max_package_json_bytes = 16 * 1024 * 1024;

const LockfileFormat = enum {
    text,
    binary,
};

const Project = struct {
    root_dir: []const u8,
    package_json_path: []const u8,
    package_json_source: []const u8,
    package_json: Value,
    lock_path: []const u8,
    lock_source: []const u8,
    lock_format: LockfileFormat,
    graph: Lockfile.Graph,

    fn deinit(project: *Project) void {
        project.graph.deinit();
    }
};

const InstalledPackage = struct {
    alias: []const u8,
    name: []const u8,
    version: []const u8,
    directory: []const u8,
    display_directory: []const u8,
    depth: usize,
    kind: Scripts.PackageKind,
    scripts: Scripts.LifecycleScripts,
};

const ModulesDirectory = struct {
    path: []const u8,
    depth: usize,
};

pub fn runDefaultTrusted(stdout: *std.Io.Writer) !u8 {
    var count: usize = 0;
    var counter = defaultTrustedIterator();
    while (counter.next()) |_| count += 1;

    try stdout.print("Default trusted dependencies ({d}):\n", .{count});
    var names = defaultTrustedIterator();
    while (names.next()) |name| try stdout.print(" - {s}\n", .{name});
    try stdout.flush();
    return 0;
}

pub fn runUntrusted(
    init: std.process.Init,
    cwd: []const u8,
    stdout: *std.Io.Writer,
    stderr: *std.Io.Writer,
) !u8 {
    try stderr.writeAll("bun pm untrusted v1.3.10\n\n");
    try stderr.flush();

    var project = loadProject(init.io, init.arena.allocator(), cwd) catch |err| {
        try printProjectError(stderr, err);
        return 1;
    };
    defer project.deinit();

    var policy = Manifest.Policy.init(init.arena.allocator(), &project.package_json) catch |err| {
        try stderr.print("error: unable to read trustedDependencies: {s}\n", .{@errorName(err)});
        try stderr.flush();
        return 1;
    };
    defer policy.deinit();

    var packages = try collectUntrustedPackages(init, &project, &policy);
    defer packages.deinit();
    sortPackages(packages.items);
    if (packages.items.len == 0) {
        try printZeroUntrusted(stdout);
        return 0;
    }

    for (packages.items) |package| {
        try printPackageScripts(stdout, package, .untrusted);
        try stdout.writeByte('\n');
    }
    try stdout.writeAll(
        "These dependencies had their lifecycle scripts blocked during install.\n\n" ++
            "If you trust them and wish to run their scripts, use `bun pm trust`.\n",
    );
    try stdout.flush();
    return 0;
}

pub fn runTrust(
    init: std.process.Init,
    cwd: []const u8,
    requested_names: []const []const u8,
    trust_all: bool,
    stdout: *std.Io.Writer,
    stderr: *std.Io.Writer,
) !u8 {
    try stderr.writeAll("bun pm trust v1.3.10\n");
    try stderr.flush();

    if (!trust_all and requested_names.len == 0) {
        try stderr.writeAll("error: expected package names(s) or --all\n");
        try stderr.flush();
        return 1;
    }

    var project = loadProject(init.io, init.arena.allocator(), cwd) catch |err| {
        try printProjectError(stderr, err);
        return 1;
    };
    defer project.deinit();

    var policy = Manifest.Policy.init(init.arena.allocator(), &project.package_json) catch |err| {
        try stderr.print("error: unable to read trustedDependencies: {s}\n", .{@errorName(err)});
        try stderr.flush();
        return 1;
    };
    defer policy.deinit();

    var packages = try collectUntrustedPackages(init, &project, &policy);
    defer packages.deinit();
    sortPackages(packages.items);

    var selected = std.array_list.Managed(InstalledPackage).init(init.arena.allocator());
    defer selected.deinit();
    for (packages.items) |package| {
        if (trust_all or containsString(requested_names, package.alias)) try selected.append(package);
    }
    if (selected.items.len == 0) {
        try printNoScriptsError(stderr, trust_all, requested_names);
        return 1;
    }

    const started_ns = std.Io.Clock.awake.now(init.io).nanoseconds;
    var scripts_ran: usize = 0;
    var offset: usize = 0;
    while (offset < selected.items.len) {
        const depth = selected.items[offset].depth;
        var end = offset;
        var queue = Scripts.Queue.init(init.arena.allocator());
        errdefer queue.deinit();
        while (end < selected.items.len and selected.items[end].depth == depth) : (end += 1) {
            const package = selected.items[end];
            scripts_ran += package.scripts.total;
            try queue.add(.{
                .name = package.name,
                .version = package.version,
                .cwd = package.directory,
                .kind = package.kind,
                .optional = false,
            });
        }
        queue.run(init, project.root_dir, stderr) catch {
            queue.deinit();
            try stderr.flush();
            return 1;
        };
        queue.deinit();
        offset = end;
    }

    const trusted_names = addTrustedDependencies(
        init.arena.allocator(),
        &project.package_json,
        selected.items,
    ) catch |err| {
        try stderr.print("error: unable to update trustedDependencies: {s}\n", .{@errorName(err)});
        try stderr.flush();
        return 1;
    };
    const package_json = try stringifyDocument(
        init.arena.allocator(),
        project.package_json,
        endsWithNewline(project.package_json_source),
    );
    const lockfile = switch (project.lock_format) {
        .text => text: {
            try setTrustedDependencies(init.arena.allocator(), &project.graph.document, trusted_names);
            break :text try stringifyDocument(init.arena.allocator(), project.graph.document, true);
        },
        .binary => BunLockfile.updateBinaryTrustedDependencies(
            init.arena.allocator(),
            project.lock_source,
            trusted_names,
        ) catch |err| {
            try stderr.print("error: unable to update binary lockfile: {s}\n", .{@errorName(err)});
            try stderr.flush();
            return 1;
        },
    };
    std.Io.Dir.cwd().writeFile(init.io, .{
        .sub_path = project.package_json_path,
        .data = package_json,
    }) catch |err| {
        try stderr.print("error: unable to save package.json: {s}\n", .{@errorName(err)});
        try stderr.flush();
        return 1;
    };
    std.Io.Dir.cwd().writeFile(init.io, .{
        .sub_path = project.lock_path,
        .data = lockfile,
    }) catch |err| {
        try stderr.print("error: unable to save lockfile: {s}\n", .{@errorName(err)});
        try stderr.flush();
        return 1;
    };
    try stderr.writeAll("Saved lockfile\n");

    try stdout.writeByte('\n');
    for (packages.items) |package| {
        try printPackageScripts(
            stdout,
            package,
            if (isSelected(selected.items, package)) .completed else .untrusted,
        );
        try stdout.writeByte('\n');
    }

    const finished_ns = std.Io.Clock.awake.now(init.io).nanoseconds;
    const elapsed_ms = @as(f64, @floatFromInt(finished_ns - started_ns)) / std.time.ns_per_ms;
    try stdout.print(" {d} script{s} ran across {d} package{s} [{d:.2}ms]\n", .{
        scripts_ran,
        if (scripts_ran == 1) "" else "s",
        selected.items.len,
        if (selected.items.len == 1) "" else "s",
        elapsed_ms,
    });
    const skipped = packages.items.len - selected.items.len;
    if (skipped > 0) {
        try stdout.print("\n {d} package{s} with blocked scripts\n", .{
            skipped,
            if (skipped == 1) "" else "s",
        });
    }
    try stdout.flush();
    try stderr.flush();
    return 0;
}

fn defaultTrustedIterator() std.mem.TokenIterator(u8, .any) {
    return std.mem.tokenizeAny(u8, Manifest.default_trusted_dependencies_source, " \r\n\t");
}

fn loadProject(io: std.Io, allocator: std.mem.Allocator, cwd: []const u8) !Project {
    const root_dir = try findLockfileRoot(io, allocator, cwd) orelse return error.LockfileNotFound;
    const package_json_path = try std.fs.path.join(allocator, &.{ root_dir, "package.json" });
    const package_json_source = std.Io.Dir.cwd().readFileAlloc(
        io,
        package_json_path,
        allocator,
        .limited(max_package_json_bytes),
    ) catch |err| switch (err) {
        error.FileNotFound => return error.PackageJSONNotFound,
        else => return err,
    };
    const normalized = Lockfile.normalizeJsonc(allocator, package_json_source) catch return error.InvalidPackageJSON;
    const package_json = std.json.parseFromSliceLeaky(Value, allocator, normalized, .{
        .duplicate_field_behavior = .use_last,
    }) catch return error.InvalidPackageJSON;
    if (package_json != .object) return error.InvalidPackageJSON;

    const text_path = try std.fs.path.join(allocator, &.{ root_dir, "bun.lock" });
    if (try readOptionalFile(io, allocator, text_path, max_lockfile_bytes)) |source| {
        return .{
            .root_dir = root_dir,
            .package_json_path = package_json_path,
            .package_json_source = package_json_source,
            .package_json = package_json,
            .lock_path = text_path,
            .lock_source = source,
            .lock_format = .text,
            .graph = Lockfile.parseText(allocator, source) catch return error.InvalidLockfile,
        };
    }

    const binary_path = try std.fs.path.join(allocator, &.{ root_dir, "bun.lockb" });
    const binary = std.Io.Dir.cwd().readFileAlloc(
        io,
        binary_path,
        allocator,
        .limited(max_lockfile_bytes),
    ) catch |err| switch (err) {
        error.FileNotFound => return error.LockfileNotFound,
        else => return err,
    };
    const converted = BunLockfile.binaryToText(allocator, binary) catch return error.InvalidLockfile;
    return .{
        .root_dir = root_dir,
        .package_json_path = package_json_path,
        .package_json_source = package_json_source,
        .package_json = package_json,
        .lock_path = binary_path,
        .lock_source = binary,
        .lock_format = .binary,
        .graph = Lockfile.parseText(allocator, converted) catch return error.InvalidLockfile,
    };
}

fn findLockfileRoot(io: std.Io, allocator: std.mem.Allocator, cwd: []const u8) !?[]const u8 {
    var current = cwd;
    while (true) {
        const text_path = try std.fs.path.join(allocator, &.{ current, "bun.lock" });
        if (fileExists(io, text_path)) return current;
        const binary_path = try std.fs.path.join(allocator, &.{ current, "bun.lockb" });
        if (fileExists(io, binary_path)) return current;
        const parent = std.fs.path.dirname(current) orelse return null;
        if (std.mem.eql(u8, parent, current)) return null;
        current = parent;
    }
}

fn fileExists(io: std.Io, path: []const u8) bool {
    std.Io.Dir.cwd().access(io, path, .{}) catch return false;
    return true;
}

fn readOptionalFile(
    io: std.Io,
    allocator: std.mem.Allocator,
    path: []const u8,
    limit: usize,
) !?[]const u8 {
    return std.Io.Dir.cwd().readFileAlloc(io, path, allocator, .limited(limit)) catch |err| switch (err) {
        error.FileNotFound => null,
        else => return err,
    };
}

fn collectUntrustedPackages(
    init: std.process.Init,
    project: *const Project,
    policy: *const Manifest.Policy,
) !std.array_list.Managed(InstalledPackage) {
    const allocator = init.arena.allocator();
    var packages = std.array_list.Managed(InstalledPackage).init(allocator);
    var modules_queue = std.array_list.Managed(ModulesDirectory).init(allocator);
    var visited_modules = std.StringHashMap(void).init(allocator);
    defer modules_queue.deinit();
    defer visited_modules.deinit();

    try modules_queue.append(.{
        .path = try std.fs.path.join(allocator, &.{ project.root_dir, "node_modules" }),
        .depth = 0,
    });
    var workspaces = project.graph.workspaces.iterator();
    while (workspaces.next()) |entry| {
        if (entry.key_ptr.*.len == 0) continue;
        try modules_queue.append(.{
            .path = try std.fs.path.join(allocator, &.{ project.root_dir, entry.key_ptr.*, "node_modules" }),
            .depth = 0,
        });
    }

    var queue_index: usize = 0;
    while (queue_index < modules_queue.items.len) : (queue_index += 1) {
        const modules = modules_queue.items[queue_index];
        const identity = std.Io.Dir.cwd().realPathFileAlloc(init.io, modules.path, allocator) catch continue;
        if (visited_modules.contains(identity)) continue;
        try visited_modules.put(identity, {});

        var directory = std.Io.Dir.cwd().openDir(init.io, modules.path, .{ .iterate = true }) catch continue;
        defer directory.close(init.io);
        var iterator = directory.iterate();
        while (try iterator.next(init.io)) |entry| {
            if (entry.name.len == 0 or entry.name[0] == '.') continue;
            const entry_path = try std.fs.path.join(allocator, &.{ modules.path, entry.name });
            if (entry.name[0] == '@') {
                var scope = std.Io.Dir.cwd().openDir(init.io, entry_path, .{ .iterate = true }) catch continue;
                defer scope.close(init.io);
                var scope_iterator = scope.iterate();
                while (try scope_iterator.next(init.io)) |package_entry| {
                    if (package_entry.name.len == 0 or package_entry.name[0] == '.') continue;
                    const alias = try std.fmt.allocPrint(allocator, "{s}/{s}", .{ entry.name, package_entry.name });
                    const package_dir = try std.fs.path.join(allocator, &.{ entry_path, package_entry.name });
                    try inspectInstalledPackage(
                        init,
                        project,
                        policy,
                        alias,
                        package_dir,
                        modules.depth,
                        &packages,
                        &modules_queue,
                    );
                }
            } else {
                try inspectInstalledPackage(
                    init,
                    project,
                    policy,
                    entry.name,
                    entry_path,
                    modules.depth,
                    &packages,
                    &modules_queue,
                );
            }
        }
    }
    return packages;
}

fn inspectInstalledPackage(
    init: std.process.Init,
    project: *const Project,
    policy: *const Manifest.Policy,
    alias: []const u8,
    package_dir: []const u8,
    depth: usize,
    packages: *std.array_list.Managed(InstalledPackage),
    modules_queue: *std.array_list.Managed(ModulesDirectory),
) !void {
    const allocator = init.arena.allocator();
    const package_json_path = try std.fs.path.join(allocator, &.{ package_dir, "package.json" });
    const source = std.Io.Dir.cwd().readFileAlloc(
        init.io,
        package_json_path,
        allocator,
        .limited(max_package_json_bytes),
    ) catch return;
    const normalized = Lockfile.normalizeJsonc(allocator, source) catch return;
    const manifest = std.json.parseFromSliceLeaky(Value, allocator, normalized, .{}) catch return;
    if (manifest != .object) return;
    try modules_queue.append(.{
        .path = try std.fs.path.join(allocator, &.{ package_dir, "node_modules" }),
        .depth = depth + 1,
    });
    const name = jsonString(&manifest, "name") orelse alias;
    const version = jsonString(&manifest, "version") orelse "0.0.0";
    const lock_kind = lockKindForInstalled(allocator, &project.graph, alias, name, version) orelse return;
    const kind = scriptKind(lock_kind) orelse return;

    if (policy.isTrusted(alias, lock_kind == .npm)) return;

    const scripts = try Scripts.inspectLifecycleScripts(init.io, allocator, package_dir, &manifest, kind);
    if (scripts.total == 0) return;
    try packages.append(.{
        .alias = try allocator.dupe(u8, alias),
        .name = try allocator.dupe(u8, name),
        .version = try allocator.dupe(u8, version),
        .directory = try allocator.dupe(u8, package_dir),
        .display_directory = try displayDirectory(allocator, project.root_dir, package_dir),
        .depth = depth,
        .kind = kind,
        .scripts = scripts,
    });
}

fn lockKindForInstalled(
    allocator: std.mem.Allocator,
    graph: *const Lockfile.Graph,
    alias: []const u8,
    name: []const u8,
    version: []const u8,
) ?Lockfile.Kind {
    var packages = graph.packages.iterator();
    while (packages.next()) |entry| {
        const package = entry.value_ptr;
        if (package.kind == .root or package.kind == .workspace) continue;
        const locked_alias = lockAliasFromKey(allocator, package.key) catch continue;
        if (!std.mem.eql(u8, locked_alias, alias)) continue;
        if (package.name.len > 0 and !std.mem.eql(u8, package.name, name)) continue;
        if (package.version.len > 0 and version.len > 0 and !std.mem.eql(u8, package.version, version)) continue;
        return package.kind;
    }
    return null;
}

fn lockAliasFromKey(allocator: std.mem.Allocator, key: []const u8) ![]const u8 {
    var alias: []const u8 = key;
    var components = std.mem.splitScalar(u8, key, '/');
    while (components.next()) |component| {
        if (component.len == 0) return error.InvalidPackageKey;
        if (component[0] == '@') {
            const package = components.next() orelse return error.InvalidPackageKey;
            alias = try std.fmt.allocPrint(allocator, "{s}/{s}", .{ component, package });
        } else {
            alias = component;
        }
    }
    return alias;
}

fn scriptKind(kind: Lockfile.Kind) ?Scripts.PackageKind {
    return switch (kind) {
        .npm => .npm,
        .folder, .symlink, .local_tarball, .remote_tarball => .local,
        .git, .github => .git,
        .workspace, .root => null,
    };
}

fn displayDirectory(allocator: std.mem.Allocator, root_dir: []const u8, directory: []const u8) ![]const u8 {
    if (std.mem.startsWith(u8, directory, root_dir) and
        directory.len > root_dir.len and
        std.fs.path.isSep(directory[root_dir.len]))
    {
        return std.fmt.allocPrint(allocator, ".{s}", .{directory[root_dir.len..]});
    }
    return allocator.dupe(u8, directory);
}

const ScriptPrintKind = enum { completed, untrusted };

fn printPackageScripts(writer: *std.Io.Writer, package: InstalledPackage, kind: ScriptPrintKind) !void {
    try writer.print("{s} @{s}\n", .{ package.display_directory, package.version });
    for (Scripts.lifecycle_stage_names, package.scripts.commands) |stage, maybe_command| {
        const command = maybe_command orelse continue;
        try writer.print(" {s} [{s}]: {s}\n", .{
            if (kind == .completed) "\u{2713}" else "\u{00bb}",
            stage,
            command,
        });
    }
}

fn sortPackages(packages: []InstalledPackage) void {
    std.mem.sort(InstalledPackage, packages, {}, struct {
        fn lessThan(_: void, left: InstalledPackage, right: InstalledPackage) bool {
            if (left.depth != right.depth) return left.depth > right.depth;
            return std.mem.order(u8, left.display_directory, right.display_directory) == .lt;
        }
    }.lessThan);
}

fn addTrustedDependencies(
    allocator: std.mem.Allocator,
    package_json: *Value,
    selected: []const InstalledPackage,
) ![][]const u8 {
    const additions = try allocator.alloc([]const u8, selected.len);
    for (selected, additions) |package, *name| name.* = package.alias;
    return Manifest.mergeTrustedDependencies(allocator, package_json, additions);
}

fn setTrustedDependencies(allocator: std.mem.Allocator, document: *Value, names: []const []const u8) !void {
    if (document.* != .object) return error.InvalidDocument;
    var array = std.json.Array.init(allocator);
    for (names) |name| try array.append(.{ .string = name });
    try document.object.put(allocator, "trustedDependencies", .{ .array = array });
}

fn stringifyDocument(
    allocator: std.mem.Allocator,
    document: Value,
    trailing_newline: bool,
) ![]const u8 {
    var output: std.Io.Writer.Allocating = .init(allocator);
    errdefer output.deinit();
    try std.json.Stringify.value(document, .{ .whitespace = .indent_2 }, &output.writer);
    if (trailing_newline) try output.writer.writeByte('\n');
    return output.toOwnedSlice();
}

fn printProjectError(stderr: *std.Io.Writer, err: anyerror) !void {
    switch (err) {
        error.LockfileNotFound => try stderr.writeAll("error: Lockfile not found\n"),
        error.PackageJSONNotFound => try stderr.writeAll("error: package.json not found\n"),
        error.InvalidPackageJSON => try stderr.writeAll("error: Failed to parse package.json\n"),
        error.InvalidLockfile => try stderr.writeAll("error: Failed to parse lockfile\n"),
        else => try stderr.print("error: unable to load package project: {s}\n", .{@errorName(err)}),
    }
    try stderr.flush();
}

fn printZeroUntrusted(stdout: *std.Io.Writer) !void {
    try stdout.writeAll(
        "Found 0 untrusted dependencies with scripts.\n\n" ++
            "This means all packages with scripts are in \"trustedDependencies\" or none of your dependencies have scripts.\n\n" ++
            "For more information, visit https://bun.com/docs/install/lifecycle#trusteddependencies\n",
    );
    try stdout.flush();
}

fn printNoScriptsError(
    stderr: *std.Io.Writer,
    trust_all: bool,
    requested_names: []const []const u8,
) !void {
    try stderr.writeByte('\n');
    if (trust_all) {
        try stderr.writeAll("error: 0 scripts ran. This means all dependencies are already trusted or none have scripts.\n");
    } else {
        try stderr.writeAll("error: 0 scripts ran. The following packages are already trusted, don't have scripts to run, or don't exist:\n\n");
        for (requested_names) |name| try stderr.print(" - {s}\n", .{name});
    }
    try stderr.flush();
}

fn containsString(values: []const []const u8, needle: []const u8) bool {
    for (values) |value| if (std.mem.eql(u8, value, needle)) return true;
    return false;
}

fn isSelected(selected: []const InstalledPackage, package: InstalledPackage) bool {
    for (selected) |candidate| {
        if (std.mem.eql(u8, candidate.directory, package.directory)) return true;
    }
    return false;
}

fn endsWithNewline(source: []const u8) bool {
    return source.len > 0 and source[source.len - 1] == '\n';
}

fn jsonString(value: *const Value, key: []const u8) ?[]const u8 {
    if (value.* != .object) return null;
    const field = value.object.get(key) orelse return null;
    return if (field == .string) field.string else null;
}

test "trusted dependency updates preserve entries and sort aliases" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    var package_json = try std.json.parseFromSliceLeaky(
        Value,
        allocator,
        "{\"trustedDependencies\":[\"z-package\"]}",
        .{},
    );
    const packages = [_]InstalledPackage{
        .{
            .alias = "a-package",
            .name = "actual-package",
            .version = "1.0.0",
            .directory = "/tmp/a",
            .display_directory = "./node_modules/a-package",
            .depth = 0,
            .kind = .npm,
            .scripts = .{},
        },
    };
    const names = try addTrustedDependencies(allocator, &package_json, &packages);
    try std.testing.expectEqual(@as(usize, 2), names.len);
    try std.testing.expectEqualStrings("a-package", names[0]);
    try std.testing.expectEqualStrings("z-package", names[1]);
}

test "lockfile aliases retain scoped package names" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    try std.testing.expectEqualStrings(
        "@scope/pkg",
        try lockAliasFromKey(arena.allocator(), "parent/@scope/pkg"),
    );
    try std.testing.expectEqualStrings(
        "child",
        try lockAliasFromKey(arena.allocator(), "parent/child"),
    );
}
