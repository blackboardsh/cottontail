const std = @import("std");
const builtin = @import("builtin");
const compiler = @import("cottontail_compiler");
const Lockfile = @import("package_manager_lockfile.zig");
const Manifest = @import("package_manager_manifest.zig");
const Scripts = @import("package_manager_scripts.zig");
const Git = @import("package_manager_git.zig");
const Patch = @import("package_manager_patch.zig");
const Isolated = @import("package_manager_isolated.zig");

const version = @import("version.zig").version;
const Semver = compiler.Semver;
const Value = std.json.Value;

// Keep this aligned with compat/upstream/targets.json. Package-manager output
// identifies the Bun contract separately from the Cottontail release.
const bun_compat_version = "1.3.10";
const manifest_accept = "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*";
const default_registry = "https://registry.npmjs.org/";
const max_manifest_bytes = 64 * 1024 * 1024;
const max_tarball_bytes = 512 * 1024 * 1024;
const all_dependency_sections = [_][]const u8{ "dependencies", "devDependencies", "optionalDependencies", "peerDependencies" };
const mutable_dependency_sections = [_][]const u8{ "dependencies", "devDependencies", "optionalDependencies" };
const runtime_dependency_sections = [_][]const u8{ "dependencies", "optionalDependencies" };

const Command = enum {
    install,
    add,
    remove,
    update,
    patch,
    patch_commit,
    pm,
};

const DependencySection = enum {
    dependencies,
    devDependencies,
    optionalDependencies,
    peerDependencies,

    fn key(section: DependencySection) []const u8 {
        return @tagName(section);
    }
};

const Options = struct {
    command: Command,
    positionals: []const []const u8,
    cwd: ?[]const u8 = null,
    config_path: ?[]const u8 = null,
    registry: ?[]const u8 = null,
    production: bool = false,
    ignore_scripts: bool = false,
    lockfile_only: bool = false,
    frozen_lockfile: bool = false,
    no_save: bool = false,
    exact: bool = false,
    only_missing: bool = false,
    force: bool = false,
    dry_run: bool = false,
    silent: bool = false,
    no_summary: bool = false,
    verify_integrity: bool = true,
    latest: bool = false,
    save_text_lockfile: bool = false,
    omit_dev: bool = false,
    omit_optional: bool = false,
    omit_peer: bool = false,
    help: bool = false,
    patches_dir: []const u8 = "patches",
    linker: ?Isolated.Linker = null,
    section: DependencySection = .dependencies,
};

const PackageSpec = struct {
    name: ?[]const u8,
    spec: []const u8,
};

const TarballPackage = struct {
    alias: []const u8,
    name: []const u8,
    version: []const u8,
    package_json: *Value,
};

const GitPackage = struct {
    alias: []const u8,
    name: []const u8,
    version: []const u8,
    source: []const u8,
    package_json: *Value,
};

const RegistryPackage = struct {
    name: []const u8,
    version: []const u8,
    tarball: []const u8,
    integrity: ?[]const u8,
    metadata: *const Value,
};

const PackageRecord = struct {
    key: []const u8 = "",
    alias: []const u8,
    name: []const u8,
    version: []const u8,
    tarball: []const u8 = "",
    integrity: []const u8 = "",
    local_path: []const u8 = "",
    resolution: []const u8 = "",
    kind: Lockfile.Kind = .npm,
    metadata: ?*const Value = null,
    peer_hash: u64 = 0,
    install_dir: []const u8 = "",
};

const Workspace = struct {
    name: []const u8,
    path: []const u8,
    version: []const u8,
    package_json: *Value,
};

const LockedSelection = struct {
    package: *const Lockfile.Package,
    destination: []const u8,
    peer_context: Isolated.PeerContext = .{},
};

const PatchSelection = struct {
    package: *const Lockfile.Package,
    destination: []const u8,
    name: []const u8,
    version: []const u8,
};

const PeerProvider = struct {
    record: PackageRecord,
    destination: []const u8,
    resolution: []const u8,
};

const PeerCandidate = struct {
    spec: []const u8,
    parent_dir: []const u8,
    direct: bool,
};

pub fn recognizes(command: []const u8) bool {
    return commandFromString(command) != null;
}

fn commandFromString(command: []const u8) ?Command {
    if (std.mem.eql(u8, command, "install") or std.mem.eql(u8, command, "i") or std.mem.eql(u8, command, "ci")) return .install;
    if (std.mem.eql(u8, command, "add") or std.mem.eql(u8, command, "a")) return .add;
    if (std.mem.eql(u8, command, "remove") or std.mem.eql(u8, command, "rm") or std.mem.eql(u8, command, "uninstall")) return .remove;
    if (std.mem.eql(u8, command, "update") or std.mem.eql(u8, command, "up")) return .update;
    if (std.mem.eql(u8, command, "patch")) return .patch;
    if (std.mem.eql(u8, command, "patch-commit")) return .patch_commit;
    if (std.mem.eql(u8, command, "pm")) return .pm;
    return null;
}

pub fn run(
    init: std.process.Init,
    args: []const [:0]const u8,
    stdout: *std.Io.Writer,
    stderr: *std.Io.Writer,
) !u8 {
    const allocator = init.arena.allocator();
    const options = parseOptions(allocator, args) catch |err| {
        try stderr.print("error: {s}\n", .{@errorName(err)});
        try stderr.flush();
        return 1;
    };

    if (options.help) {
        try printPackageManagerHelp(options.command, stdout);
        try stdout.flush();
        return 0;
    }

    if (options.cwd) |cwd| {
        std.process.setCurrentPath(init.io, cwd) catch |err| {
            try stderr.print("error: unable to use --cwd '{s}': {s}\n", .{ cwd, @errorName(err) });
            try stderr.flush();
            return 1;
        };
    }

    if (options.command == .pm) {
        return try runPm(init, options, stdout, stderr);
    }

    var manager = Manager.init(init, options, stdout, stderr);
    defer manager.deinit();
    return manager.execute() catch |err| {
        if (err == error.FrozenLockfileChanged or err == error.FrozenLockfilePackageMissing) {
            try stderr.writeAll("error: lockfile had changes, but lockfile is frozen\n");
        } else if (err == error.FrozenLockfileNotFound) {
            try stderr.writeAll("error: lockfile not found, but lockfile is frozen\n");
        } else if (err == error.IntegrityCheckFailed) {
            try stderr.writeAll("error: Integrity check failed\n");
        } else if (err != error.PackageManagerErrorReported) {
            try stderr.print("error: {s}\n", .{@errorName(err)});
        }
        try stderr.flush();
        return 1;
    };
}

fn parseOptions(allocator: std.mem.Allocator, args: []const [:0]const u8) !Options {
    if (args.len < 2) return error.MissingPackageManagerCommand;
    var options = Options{
        .command = commandFromString(args[1]) orelse return error.UnknownPackageManagerCommand,
        .positionals = &.{},
        .frozen_lockfile = std.mem.eql(u8, args[1], "ci"),
    };
    var positionals = std.array_list.Managed([]const u8).init(allocator);

    var index: usize = 2;
    while (index < args.len) : (index += 1) {
        const arg = args[index];
        if (std.mem.eql(u8, arg, "--")) {
            for (args[index + 1 ..]) |positional| try positionals.append(positional);
            break;
        }
        if (!std.mem.startsWith(u8, arg, "-")) {
            try positionals.append(arg);
            continue;
        }

        if (std.mem.eql(u8, arg, "--cwd")) {
            index += 1;
            if (index >= args.len) return error.MissingCwd;
            options.cwd = args[index];
        } else if (std.mem.startsWith(u8, arg, "--cwd=")) {
            options.cwd = arg["--cwd=".len..];
        } else if (std.mem.eql(u8, arg, "--config") or std.mem.eql(u8, arg, "-c")) {
            index += 1;
            if (index >= args.len) return error.MissingConfigPath;
            options.config_path = args[index];
        } else if (std.mem.startsWith(u8, arg, "--config=")) {
            options.config_path = arg["--config=".len..];
        } else if (std.mem.eql(u8, arg, "--registry")) {
            index += 1;
            if (index >= args.len) return error.MissingRegistry;
            options.registry = args[index];
        } else if (std.mem.startsWith(u8, arg, "--registry=")) {
            options.registry = arg["--registry=".len..];
        } else if (std.mem.eql(u8, arg, "--production") or std.mem.eql(u8, arg, "--prod") or std.mem.eql(u8, arg, "-p") or std.mem.eql(u8, arg, "-P")) {
            options.production = true;
        } else if (std.mem.eql(u8, arg, "--ignore-scripts")) {
            options.ignore_scripts = true;
        } else if (std.mem.eql(u8, arg, "--lockfile-only")) {
            options.lockfile_only = true;
        } else if (std.mem.eql(u8, arg, "--frozen-lockfile")) {
            options.frozen_lockfile = true;
        } else if (std.mem.eql(u8, arg, "--no-save")) {
            options.no_save = true;
        } else if (std.mem.eql(u8, arg, "--save")) {
            options.no_save = false;
        } else if (std.mem.eql(u8, arg, "--exact") or std.mem.eql(u8, arg, "-E")) {
            options.exact = true;
        } else if (std.mem.eql(u8, arg, "--only-missing")) {
            options.only_missing = true;
        } else if (std.mem.eql(u8, arg, "--force") or std.mem.eql(u8, arg, "-f")) {
            options.force = true;
        } else if (std.mem.eql(u8, arg, "--dry-run")) {
            options.dry_run = true;
        } else if (std.mem.eql(u8, arg, "--silent") or std.mem.eql(u8, arg, "--quiet")) {
            options.silent = true;
        } else if (std.mem.eql(u8, arg, "--no-summary")) {
            options.no_summary = true;
        } else if (std.mem.eql(u8, arg, "--dev") or std.mem.eql(u8, arg, "-d") or std.mem.eql(u8, arg, "-D") or std.mem.eql(u8, arg, "--development")) {
            options.section = .devDependencies;
        } else if (std.mem.eql(u8, arg, "--optional")) {
            options.section = .optionalDependencies;
        } else if (std.mem.eql(u8, arg, "--peer")) {
            options.section = .peerDependencies;
        } else if (std.mem.eql(u8, arg, "--no-verify")) {
            options.verify_integrity = false;
        } else if (std.mem.eql(u8, arg, "--latest")) {
            options.latest = true;
        } else if (std.mem.eql(u8, arg, "--save-text-lockfile")) {
            options.save_text_lockfile = true;
        } else if (std.mem.eql(u8, arg, "--commit")) {
            if (options.command != .patch) return error.InvalidPackageManagerOption;
            options.command = .patch_commit;
        } else if (std.mem.eql(u8, arg, "--patches-dir")) {
            index += 1;
            if (index >= args.len) return error.MissingOptionValue;
            options.patches_dir = args[index];
        } else if (std.mem.startsWith(u8, arg, "--patches-dir=")) {
            options.patches_dir = arg["--patches-dir=".len..];
        } else if (std.mem.eql(u8, arg, "--backend")) {
            index += 1;
            if (index >= args.len) return error.MissingOptionValue;
        } else if (std.mem.startsWith(u8, arg, "--backend=")) {
            if (arg.len == "--backend=".len) return error.MissingOptionValue;
        } else if (std.mem.eql(u8, arg, "--omit")) {
            index += 1;
            if (index >= args.len) return error.MissingOptionValue;
            try applyOmit(&options, args[index]);
        } else if (std.mem.startsWith(u8, arg, "--omit=")) {
            try applyOmit(&options, arg["--omit=".len..]);
        } else if (std.mem.eql(u8, arg, "--linker")) {
            index += 1;
            if (index >= args.len) return error.MissingOptionValue;
            options.linker = Isolated.Linker.parse(args[index]) orelse return error.UnsupportedPackageManagerLinker;
        } else if (std.mem.startsWith(u8, arg, "--linker=")) {
            options.linker = Isolated.Linker.parse(arg["--linker=".len..]) orelse return error.UnsupportedPackageManagerLinker;
        } else if (std.mem.eql(u8, arg, "--no-cache") or std.mem.eql(u8, arg, "--no-progress")) {
            // Cottontail's current installer is uncached and has no progress UI,
            // so these flags already describe its execution mode.
        } else if (std.mem.eql(u8, arg, "--help") or std.mem.eql(u8, arg, "-h")) {
            options.help = true;
        } else {
            return error.UnknownPackageManagerOption;
        }
    }
    options.positionals = try positionals.toOwnedSlice();
    if ((options.command == .patch or options.command == .patch_commit) and options.positionals.len == 0) {
        return error.MissingPatchTarget;
    }
    return options;
}

fn applyOmit(options: *Options, value: []const u8) !void {
    if (std.mem.eql(u8, value, "dev")) {
        options.omit_dev = true;
    } else if (std.mem.eql(u8, value, "optional")) {
        options.omit_optional = true;
    } else if (std.mem.eql(u8, value, "peer")) {
        options.omit_peer = true;
    } else {
        return error.InvalidOmitValue;
    }
}

fn printPackageManagerHelp(command: Command, writer: *std.Io.Writer) !void {
    try writer.print(
        \\Usage: cottontail {s} [packages...] [flags]
        \\
        \\  --cwd <path>             Set the working directory
        \\  --registry <url>         Override the package registry
        \\  -p, --production         Omit devDependencies
        \\  --omit <kind>            Omit dev, optional, or peer dependencies
        \\  --ignore-scripts         Skip project lifecycle scripts
        \\  --lockfile-only          Resolve without writing node_modules
        \\  --linker <strategy>      Use the isolated or hoisted install layout
        \\  --no-save                Do not update package.json or bun.lock
        \\  --no-verify              Skip package integrity verification
        \\  -f, --force              Re-resolve and reinstall dependencies
        \\  --patches-dir <path>     Set the generated patch directory
        \\
    , .{@tagName(command)});
}

fn runPm(
    init: std.process.Init,
    options: Options,
    stdout: *std.Io.Writer,
    stderr: *std.Io.Writer,
) !u8 {
    const subcommand = if (options.positionals.len > 0) options.positionals[0] else "";
    if (std.mem.eql(u8, subcommand, "bin")) {
        const absolute = try absolutePath(init.io, init.arena.allocator(), "node_modules/.bin");
        try stdout.print("{s}\n", .{absolute});
        try stdout.flush();
        return 0;
    }
    if (std.mem.eql(u8, subcommand, "cache")) {
        const cache_path = try packageCachePath(init, init.arena.allocator());
        if (options.positionals.len > 1 and std.mem.eql(u8, options.positionals[1], "rm")) {
            std.Io.Dir.cwd().deleteTree(init.io, cache_path) catch {};
            try stdout.writeAll("Cleared 'bun install' cache\n");
        } else {
            try stdout.print("{s}\n", .{cache_path});
        }
        try stdout.flush();
        return 0;
    }

    try stderr.writeAll("error: unsupported package-manager utility\n");
    try stderr.flush();
    return 1;
}

const Manager = struct {
    init_data: std.process.Init,
    allocator: std.mem.Allocator,
    options: Options,
    stdout: *std.Io.Writer,
    stderr: *std.Io.Writer,
    root_dir: []const u8 = "",
    invocation_dir: []const u8 = "",
    registry: []const u8 = default_registry,
    registry_authorization: ?[]const u8 = null,
    save_text_lockfile: bool = true,
    max_retry_count: u16 = 5,
    client: std.http.Client,
    records: std.array_list.Managed(PackageRecord),
    workspaces: std.StringHashMap(Workspace),
    root_versions: std.StringHashMap([]const u8),
    resolving: std.StringHashMap(void),
    direct_bins: std.array_list.Managed([]const u8),
    report_direct_installs: bool = false,
    started_ns: i128,
    installed_count: usize = 0,
    changed: bool = false,
    root_package_json: ?*const Value = null,
    node_linker: Isolated.Linker = .hoisted,
    public_hoist_pattern: ?Isolated.HoistPattern = null,
    hidden_hoist_pattern: ?Isolated.HoistPattern = null,
    isolated_parent_modules: std.StringHashMap([]const u8),
    isolated_parent_keys: std.StringHashMap([]const u8),
    isolated_package_metadata: std.StringHashMap(*const Value),
    isolated_live_store_keys: std.StringHashMap(void),
    isolated_live_links: std.StringHashMap(void),
    isolated_managed_modules: std.StringHashMap(void),
    isolated_hidden_hoists: std.StringHashMap(void),
    isolated_public_hoists: std.StringHashMap(void),
    lock_graph: ?Lockfile.Graph = null,
    manifest_policy: ?Manifest.Policy = null,
    script_queue: Scripts.Queue,

    fn init(
        init_data: std.process.Init,
        options: Options,
        stdout: *std.Io.Writer,
        stderr: *std.Io.Writer,
    ) Manager {
        const allocator = init_data.arena.allocator();
        return .{
            .init_data = init_data,
            .allocator = allocator,
            .options = options,
            .stdout = stdout,
            .stderr = stderr,
            .client = .{ .allocator = std.heap.smp_allocator, .io = init_data.io },
            .records = std.array_list.Managed(PackageRecord).init(allocator),
            .workspaces = std.StringHashMap(Workspace).init(allocator),
            .root_versions = std.StringHashMap([]const u8).init(allocator),
            .resolving = std.StringHashMap(void).init(allocator),
            .direct_bins = std.array_list.Managed([]const u8).init(allocator),
            .isolated_parent_modules = std.StringHashMap([]const u8).init(allocator),
            .isolated_parent_keys = std.StringHashMap([]const u8).init(allocator),
            .isolated_package_metadata = std.StringHashMap(*const Value).init(allocator),
            .isolated_live_store_keys = std.StringHashMap(void).init(allocator),
            .isolated_live_links = std.StringHashMap(void).init(allocator),
            .isolated_managed_modules = std.StringHashMap(void).init(allocator),
            .isolated_hidden_hoists = std.StringHashMap(void).init(allocator),
            .isolated_public_hoists = std.StringHashMap(void).init(allocator),
            .script_queue = Scripts.Queue.init(allocator),
            .started_ns = std.Io.Clock.awake.now(init_data.io).nanoseconds,
        };
    }

    fn deinit(manager: *Manager) void {
        manager.script_queue.deinit();
        manager.isolated_public_hoists.deinit();
        manager.isolated_hidden_hoists.deinit();
        manager.isolated_managed_modules.deinit();
        manager.isolated_live_links.deinit();
        manager.isolated_live_store_keys.deinit();
        manager.isolated_package_metadata.deinit();
        manager.isolated_parent_modules.deinit();
        manager.isolated_parent_keys.deinit();
        if (manager.manifest_policy) |*policy| policy.deinit();
        if (manager.lock_graph) |*graph| graph.deinit();
        manager.client.deinit();
    }

    fn execute(manager: *Manager) !u8 {
        // Bun treats `install <package>` as `add <package>` before it
        // initializes the package manager.
        if (manager.options.command == .install and manager.options.positionals.len > 0) {
            manager.options.command = .add;
        }
        manager.invocation_dir = try absolutePath(manager.init_data.io, manager.allocator, ".");
        manager.root_dir = if (manager.options.command == .patch or manager.options.command == .patch_commit)
            try findPatchProjectRoot(manager.init_data.io, manager.allocator, manager.invocation_dir)
        else
            manager.invocation_dir;
        if (!std.mem.eql(u8, manager.invocation_dir, manager.root_dir)) {
            try std.process.setCurrentPath(manager.init_data.io, manager.root_dir);
        }
        try manager.loadConfiguration();
        manager.client.initDefaultProxies(manager.allocator, manager.init_data.environ_map) catch {};

        const package_json_path = try std.fs.path.join(manager.allocator, &.{ manager.root_dir, "package.json" });
        const package_source = blk: {
            break :blk std.Io.Dir.cwd().readFileAlloc(
                manager.init_data.io,
                package_json_path,
                manager.allocator,
                .limited(64 * 1024 * 1024),
            ) catch |err| {
                if (manager.options.command == .add) {
                    const initial = "{}";
                    if (!manager.options.dry_run and !manager.options.no_save) {
                        try std.Io.Dir.cwd().writeFile(manager.init_data.io, .{ .sub_path = package_json_path, .data = initial });
                    }
                    break :blk initial;
                }
                return err;
            };
        };
        const had_trailing_newline = package_source.len > 0 and package_source[package_source.len - 1] == '\n';
        var root = try std.json.parseFromSliceLeaky(Value, manager.allocator, package_source, .{});
        if (root != .object) return error.InvalidPackageJSON;
        manager.root_package_json = &root;
        manager.manifest_policy = try Manifest.Policy.init(manager.allocator, &root);

        if (manager.options.frozen_lockfile) {
            if (manager.options.command != .install) return error.FrozenLockfileChanged;
        }
        try manager.loadLockfile(&root);

        try manager.discoverWorkspaces(&root);
        try manager.validateLockfileWorkspaces();
        if (manager.options.command == .patch) return manager.preparePatchCommand();
        if (manager.options.command == .patch_commit) {
            return manager.commitPatchCommand(&root, package_json_path, had_trailing_newline);
        }
        if (!manager.options.silent) {
            try manager.stdout.print("bun {s} v{s} (cottontail v{s})\n\n", .{ @tagName(manager.options.command), bun_compat_version, version });
            try manager.stdout.flush();
        }

        try manager.prepareNodeModules();

        switch (manager.options.command) {
            .install => try manager.installRoot(&root, true),
            .add => try manager.addPackages(&root),
            .remove => try manager.removePackages(&root),
            .update => try manager.updatePackages(&root),
            .patch, .patch_commit => unreachable,
            .pm => unreachable,
        }

        try manager.finalizeIsolatedNodeModules();

        if ((manager.options.command == .add or manager.options.command == .remove or manager.options.command == .update) and
            !manager.options.no_save and !manager.options.dry_run)
        {
            try writePackageJSON(
                manager.init_data.io,
                manager.allocator,
                package_json_path,
                root,
                had_trailing_newline,
            );
        }

        if (!manager.options.dry_run and !manager.options.no_save) {
            if (manager.records.items.len == 0 and !hasAnyDependencies(&root)) {
                manager.deleteLockfiles();
            } else if (manager.changed or !manager.hasExistingLockfile()) {
                try manager.writeTextLockfile(&root);
            }
        }

        if (!manager.options.ignore_scripts and !manager.options.dry_run and !manager.options.lockfile_only) {
            try manager.script_queue.run(manager.init_data, manager.root_dir, manager.stderr);
            if (manager.options.command == .install) {
                try Scripts.runRoot(manager.init_data, manager.root_dir, &root, manager.stderr);
            }
        }

        if (!manager.options.silent and manager.options.lockfile_only and !manager.options.no_save and !manager.options.dry_run) {
            try manager.stdout.writeAll("Saved bun.lock");
        } else if (!manager.options.silent and !manager.options.no_summary and
            !(manager.options.only_missing and manager.installed_count == 0))
        {
            const finished_ns = std.Io.Clock.awake.now(manager.init_data.io).nanoseconds;
            const elapsed_ms = @as(f64, @floatFromInt(finished_ns - manager.started_ns)) / std.time.ns_per_ms;
            if (manager.installed_count == 1) {
                try manager.stdout.print("\n1 package installed [{d:.2}ms]\n", .{elapsed_ms});
            } else {
                try manager.stdout.print("\n{d} packages installed [{d:.2}ms]\n", .{ manager.installed_count, elapsed_ms });
            }
        }
        try manager.stdout.flush();
        try manager.stderr.flush();
        return 0;
    }

    fn preparePatchCommand(manager: *Manager) !u8 {
        const selection = try manager.selectPatchPackage(manager.options.positionals[0]);
        try manager.preparePackageForEditing(selection);

        const display_path = if (std.mem.eql(u8, manager.invocation_dir, manager.root_dir))
            try manager.relativeLockPath(selection.destination)
        else
            try normalizePathForManifest(manager.allocator, selection.destination);
        try manager.stdout.print(
            "\nTo patch {s}, edit the following folder:\n\n  {s}\n\nOnce you're done with your changes, run:\n\n  bun patch --commit '{s}'\n",
            .{ selection.name, display_path, display_path },
        );
        try manager.stdout.flush();
        return 0;
    }

    fn commitPatchCommand(
        manager: *Manager,
        root: *Value,
        package_json_path: []const u8,
        had_trailing_newline: bool,
    ) !u8 {
        const selection = try manager.selectPatchPackage(manager.options.positionals[0]);
        const temp_root = try manager.patchTempPath("commit", selection.package.key);
        defer deletePath(manager.init_data.io, temp_root);
        const pristine_dir = try std.fs.path.join(manager.allocator, &.{ temp_root, "pristine" });
        const changed_dir = try std.fs.path.join(manager.allocator, &.{ temp_root, "changed" });

        try manager.materializePristine(selection.package, pristine_dir);
        try Patch.snapshot(manager.allocator, manager.init_data.io, selection.destination, changed_dir);
        try Patch.stripDiffArtifacts(manager.allocator, manager.init_data.io, pristine_dir);
        try Patch.stripDiffArtifacts(manager.allocator, manager.init_data.io, changed_dir);
        const contents = Patch.diff(
            manager.allocator,
            manager.init_data.io,
            manager.init_data.environ_map,
            pristine_dir,
            changed_dir,
        ) catch |err| {
            try manager.stderr.print("error: failed to make patch diff: {s}\n", .{@errorName(err)});
            return error.PackageManagerErrorReported;
        };
        if (contents.len == 0) {
            try manager.stdout.print("\nNo changes detected, comparing {s} to {s}\n", .{ pristine_dir, selection.destination });
            try manager.stdout.flush();
            return 0;
        }

        const patch_label = try std.fmt.allocPrint(manager.allocator, "{s}@{s}.patch", .{ selection.name, selection.version });
        const patch_filename = try Patch.Spec.escapeFilename(manager.allocator, patch_label);
        const patches_dir = try absolutePathFrom(manager.allocator, manager.root_dir, manager.options.patches_dir);
        try std.Io.Dir.cwd().createDirPath(manager.init_data.io, patches_dir);
        const patch_path = try std.fs.path.join(manager.allocator, &.{ patches_dir, patch_filename });
        try std.Io.Dir.cwd().writeFile(manager.init_data.io, .{ .sub_path = patch_path, .data = contents });

        const stored_patch_path = if (std.fs.path.isAbsolute(manager.options.patches_dir))
            try normalizePathForManifest(manager.allocator, patch_path)
        else
            try normalizePathForManifest(
                manager.allocator,
                try std.fs.path.join(manager.allocator, &.{ manager.options.patches_dir, patch_filename }),
            );
        const patch_key = try std.fmt.allocPrint(manager.allocator, "{s}@{s}", .{ selection.name, selection.version });
        const patched_dependencies = try ensureObjectProperty(manager.allocator, &root.object, "patchedDependencies");
        try patched_dependencies.put(
            manager.allocator,
            try manager.allocator.dupe(u8, patch_key),
            .{ .string = try manager.allocator.dupe(u8, stored_patch_path) },
        );
        try writePackageJSON(manager.init_data.io, manager.allocator, package_json_path, root.*, had_trailing_newline);

        manager.manifest_policy.?.deinit();
        manager.manifest_policy = try Manifest.Policy.init(manager.allocator, root);
        manager.changed = true;
        try manager.prepareNodeModules();
        try manager.installRoot(root, false);
        try manager.finalizeIsolatedNodeModules();
        try manager.writeTextLockfile(root);
        if (!manager.options.ignore_scripts and !manager.options.dry_run and !manager.options.lockfile_only) {
            try manager.script_queue.run(manager.init_data, manager.root_dir, manager.stderr);
        }
        try manager.stdout.flush();
        try manager.stderr.flush();
        return 0;
    }

    fn selectPatchPackage(manager: *Manager, argument: []const u8) !PatchSelection {
        const graph = if (manager.lock_graph) |*value| value else {
            try manager.stderr.writeAll("error: Cannot find lockfile. Install packages with `bun install` before patching them.\n");
            return error.PackageManagerErrorReported;
        };

        if (try manager.patchArgumentPath(argument)) |requested_path| {
            const identity = manager.readInstalledPackageJSON(requested_path) catch {
                try manager.stderr.print("error: package {s} not found\n", .{argument});
                return error.PackageManagerErrorReported;
            };
            const name = jsonString(identity, "name") orelse return error.InvalidPackageName;
            const version_value = jsonString(identity, "version") orelse return error.InvalidPackageVersion;
            var fallback: ?PatchSelection = null;
            var iterator = graph.packages.iterator();
            while (iterator.next()) |entry| {
                const package = entry.value_ptr;
                if (!isPatchableResolution(package.kind) or !std.mem.eql(u8, package.name, name)) continue;
                if (package.kind == .npm and !std.mem.eql(u8, package.version, version_value)) continue;
                const candidate = manager.patchDestinationForKey(package.key) catch continue;
                const selection = PatchSelection{
                    .package = package,
                    .destination = requested_path,
                    .name = name,
                    .version = version_value,
                };
                if (try pathsEquivalent(manager.init_data.io, manager.allocator, candidate, requested_path)) return selection;
                if (fallback == null) fallback = selection;
            }
            if (fallback) |selection| return selection;
            try manager.stderr.print("error: package {s} not found\n", .{argument});
            return error.PackageManagerErrorReported;
        }

        if (packageNameFromNodeModulesPath(argument)) |path_name| {
            var selection = try manager.selectPatchTarget(.{ .name = path_name, .version = null }, argument);
            selection.destination = try absolutePathFrom(manager.allocator, manager.invocation_dir, argument);
            return selection;
        }

        return manager.selectPatchTarget(Patch.Spec.splitTarget(argument), argument);
    }

    fn selectPatchTarget(
        manager: *Manager,
        target: Patch.Spec.Target,
        argument: []const u8,
    ) !PatchSelection {
        const graph = &manager.lock_graph.?;
        var selected: ?PatchSelection = null;
        var iterator = graph.packages.iterator();
        while (iterator.next()) |entry| {
            const package = entry.value_ptr;
            if (!isPatchableResolution(package.kind) or !std.mem.eql(u8, package.name, target.name)) continue;
            const destination = manager.patchDestinationForKey(package.key) catch continue;
            const identity = manager.readInstalledPackageJSON(destination) catch continue;
            const name = jsonString(identity, "name") orelse continue;
            const version_value = jsonString(identity, "version") orelse continue;
            if (!std.mem.eql(u8, name, target.name)) continue;
            if (target.version) |wanted| if (!std.mem.eql(u8, wanted, version_value)) continue;

            const selected_destination = try manager.workspaceAliasDestination(destination);
            const candidate = PatchSelection{
                .package = package,
                .destination = selected_destination,
                .name = name,
                .version = version_value,
            };
            if (selected) |current| {
                if (target.version == null and !std.mem.eql(u8, current.version, version_value)) {
                    try manager.stderr.print("error: package {s} has multiple installed versions; specify an exact version\n", .{target.name});
                    return error.PackageManagerErrorReported;
                }
                if (!std.mem.eql(u8, manager.invocation_dir, manager.root_dir) and
                    pathHasPrefix(destination, manager.invocation_dir)) selected = candidate;
            } else {
                selected = candidate;
            }
        }
        if (selected) |selection| return selection;
        try manager.stderr.print("error: package {s} not found\n", .{argument});
        return error.PackageManagerErrorReported;
    }

    fn patchArgumentPath(manager: *Manager, argument: []const u8) !?[]const u8 {
        const invocation_path = try absolutePathFrom(manager.allocator, manager.invocation_dir, argument);
        const invocation_manifest = try std.fs.path.join(manager.allocator, &.{ invocation_path, "package.json" });
        if (manager.pathExists(invocation_manifest)) return invocation_path;
        if (!std.mem.eql(u8, manager.invocation_dir, manager.root_dir)) {
            const root_path = try absolutePathFrom(manager.allocator, manager.root_dir, argument);
            const root_manifest = try std.fs.path.join(manager.allocator, &.{ root_path, "package.json" });
            if (manager.pathExists(root_manifest)) return root_path;
        }
        return null;
    }

    fn patchDestinationForKey(manager: *Manager, key: []const u8) ![]const u8 {
        if (manager.node_linker == .isolated) {
            const package = manager.lock_graph.?.get(key) orelse return error.PackageNotFound;
            const placement = try manager.packagePlacementFromLock(package, .{});
            try manager.rememberIsolatedParent(placement, package.key);
            if (manager.pathExists(placement.package_dir)) return placement.package_dir;

            // A peer-qualified entry appends +<peer-hash> to the canonical
            // store key. Patch selection is version-oriented, so any matching
            // installed context is a valid pristine source for the patch.
            const store = std.fs.path.dirname(placement.modules_dir) orelse return error.PackageNotFound;
            const store_root = std.fs.path.dirname(store) orelse return error.PackageNotFound;
            var directory = std.Io.Dir.cwd().openDir(manager.init_data.io, store_root, .{ .iterate = true }) catch return error.PackageNotFound;
            defer directory.close(manager.init_data.io);
            const prefix = try std.fmt.allocPrint(manager.allocator, "{s}+", .{placement.store_key});
            var iterator = directory.iterate();
            while (try iterator.next(manager.init_data.io)) |entry| {
                if (!std.mem.startsWith(u8, entry.name, prefix)) continue;
                const candidate = try std.fs.path.join(manager.allocator, &.{ store_root, entry.name, "node_modules", package.name });
                if (manager.pathExists(candidate)) return candidate;
            }
            return error.PackageNotFound;
        }
        var iterator = manager.workspaces.iterator();
        while (iterator.next()) |entry| {
            const workspace = entry.value_ptr.*;
            const relative = try manager.relativeLockPath(workspace.path);
            if (key.len > relative.len and std.mem.startsWith(u8, key, relative) and key[relative.len] == '/') {
                return Patch.Spec.destinationForLockKey(manager.allocator, workspace.path, key[relative.len + 1 ..]);
            }
        }
        return Patch.Spec.destinationForLockKey(manager.allocator, manager.root_dir, key);
    }

    fn workspaceAliasDestination(manager: *Manager, destination: []const u8) ![]const u8 {
        var iterator = manager.workspaces.iterator();
        while (iterator.next()) |entry| {
            const workspace = entry.value_ptr.*;
            if (!pathHasPrefix(destination, workspace.path) or destination.len == workspace.path.len) continue;
            const linked_workspace = try packageDestination(manager.allocator, manager.root_dir, workspace.name);
            return std.fmt.allocPrint(manager.allocator, "{s}{s}", .{ linked_workspace, destination[workspace.path.len..] });
        }
        return destination;
    }

    fn preparePackageForEditing(manager: *Manager, selection: PatchSelection) !void {
        const nested_modules = try std.fs.path.join(manager.allocator, &.{ selection.destination, "node_modules" });
        const holding_root = try manager.patchTempPath("dependencies", selection.package.key);
        const holding_modules = try std.fs.path.join(manager.allocator, &.{ holding_root, "node_modules" });
        deletePath(manager.init_data.io, holding_root);
        var moved_nested = false;
        if (manager.pathExists(nested_modules)) {
            try std.Io.Dir.cwd().createDirPath(manager.init_data.io, holding_root);
            try std.Io.Dir.cwd().rename(nested_modules, std.Io.Dir.cwd(), holding_modules, manager.init_data.io);
            moved_nested = true;
        }
        errdefer if (moved_nested) {
            std.Io.Dir.cwd().createDirPath(manager.init_data.io, selection.destination) catch {};
            std.Io.Dir.cwd().rename(holding_modules, std.Io.Dir.cwd(), nested_modules, manager.init_data.io) catch {};
        };

        try manager.materializePristine(selection.package, selection.destination);
        try manager.applyPackagePatch(selection.name, selection.version, selection.destination, &.{});
        if (moved_nested) {
            try std.Io.Dir.cwd().rename(holding_modules, std.Io.Dir.cwd(), nested_modules, manager.init_data.io);
        }
        deletePath(manager.init_data.io, holding_root);
    }

    fn materializePristine(manager: *Manager, package: *const Lockfile.Package, destination: []const u8) !void {
        deletePath(manager.init_data.io, destination);
        if (std.fs.path.dirname(destination)) |parent| try std.Io.Dir.cwd().createDirPath(manager.init_data.io, parent);
        switch (package.kind) {
            .npm, .local_tarball, .remote_tarball => {
                const archive = switch (package.kind) {
                    .npm => blk: {
                        const url = if (package.source.len > 0)
                            package.source
                        else
                            try manager.defaultTarballURL(package.name, package.version);
                        break :blk try manager.fetchBytes(url, false, max_tarball_bytes);
                    },
                    .remote_tarball => try manager.fetchBytes(package.source, false, max_tarball_bytes),
                    .local_tarball => blk: {
                        const path = try absolutePathFrom(manager.allocator, manager.root_dir, localSpecPath(package.source));
                        break :blk try std.Io.Dir.cwd().readFileAlloc(
                            manager.init_data.io,
                            path,
                            manager.allocator,
                            .limited(max_tarball_bytes),
                        );
                    },
                    else => unreachable,
                };
                if (manager.options.verify_integrity) {
                    try verifyIntegrity(archive, if (package.integrity.len > 0) package.integrity else null);
                }
                try std.Io.Dir.cwd().createDirPath(manager.init_data.io, destination);
                var destination_dir = try std.Io.Dir.cwd().openDir(manager.init_data.io, destination, .{});
                defer destination_dir.close(manager.init_data.io);
                try extractTarballArchive(manager.init_data.io, manager.allocator, destination_dir, archive);
            },
            .git, .github => {
                const spec = (try Git.parse(manager.allocator, package.source)) orelse return error.InvalidGitDependency;
                const checkout_path = try manager.patchTempPath("git", package.key);
                const checkout = try Git.checkout(
                    manager.allocator,
                    manager.init_data.io,
                    manager.init_data.environ_map,
                    spec,
                    checkout_path,
                );
                defer deletePath(manager.init_data.io, checkout.path);
                try copyDirectoryTree(manager.init_data.io, manager.allocator, checkout.path, destination);
            },
            else => return error.UnsupportedPatchResolution,
        }
    }

    fn patchTempPath(manager: *Manager, label: []const u8, key: []const u8) ![]const u8 {
        const cache_dir = try std.fs.path.join(manager.allocator, &.{ manager.root_dir, "node_modules", ".cache" });
        try std.Io.Dir.cwd().createDirPath(manager.init_data.io, cache_dir);
        return std.fmt.allocPrint(manager.allocator, "{s}{c}cottontail-patch-{s}-{x}-{d}", .{
            cache_dir,
            std.fs.path.sep,
            label,
            std.hash.Wyhash.hash(0, key),
            std.Io.Clock.awake.now(manager.init_data.io).nanoseconds,
        });
    }

    fn prepareNodeModules(manager: *Manager) !void {
        if (manager.options.lockfile_only or manager.options.dry_run) return;
        const node_modules = try std.fs.path.join(manager.allocator, &.{ manager.root_dir, "node_modules" });
        if (manager.node_linker == .isolated) {
            try manager.isolated_managed_modules.put(try manager.allocator.dupe(u8, node_modules), {});
            const hidden_modules = try std.fs.path.join(manager.allocator, &.{ node_modules, ".bun", "node_modules" });
            try manager.isolated_managed_modules.put(try manager.allocator.dupe(u8, hidden_modules), {});
            try manager.prepareIsolatedNodeModules(node_modules);
        } else {
            try std.Io.Dir.cwd().createDirPath(manager.init_data.io, node_modules);
            const cache = try std.fs.path.join(manager.allocator, &.{ node_modules, ".cache" });
            try std.Io.Dir.cwd().createDirPath(manager.init_data.io, cache);
        }
    }

    fn prepareIsolatedNodeModules(manager: *Manager, node_modules: []const u8) !void {
        const store = try std.fs.path.join(manager.allocator, &.{ node_modules, ".bun" });
        if (manager.pathExists(store)) {
            const hoist = try std.fs.path.join(manager.allocator, &.{ store, "node_modules" });
            try std.Io.Dir.cwd().createDirPath(manager.init_data.io, hoist);
            return;
        }

        if (!manager.pathExists(node_modules)) {
            const hoist = try std.fs.path.join(manager.allocator, &.{ store, "node_modules" });
            try std.Io.Dir.cwd().createDirPath(manager.init_data.io, hoist);
            return;
        }

        const suffix: u128 = @bitCast(manager.started_ns);
        const holding = try std.fmt.allocPrint(manager.allocator, "{s}.cottontail-isolated-{x}", .{ node_modules, suffix });
        const old_name = try std.fmt.allocPrint(manager.allocator, ".old_modules-{x}", .{suffix});
        const old_modules = try std.fs.path.join(manager.allocator, &.{ node_modules, old_name });
        const hoist = try std.fs.path.join(manager.allocator, &.{ store, "node_modules" });
        deletePath(manager.init_data.io, holding);
        try std.Io.Dir.cwd().rename(node_modules, std.Io.Dir.cwd(), holding, manager.init_data.io);
        {
            errdefer {
                deletePath(manager.init_data.io, node_modules);
                std.Io.Dir.cwd().rename(holding, std.Io.Dir.cwd(), node_modules, manager.init_data.io) catch {};
            }
            try std.Io.Dir.cwd().createDirPath(manager.init_data.io, hoist);
            try std.Io.Dir.cwd().rename(holding, std.Io.Dir.cwd(), old_modules, manager.init_data.io);
        }

        const old_cache = try std.fs.path.join(manager.allocator, &.{ old_modules, ".cache" });
        const cache = try std.fs.path.join(manager.allocator, &.{ node_modules, ".cache" });
        std.Io.Dir.cwd().rename(old_cache, std.Io.Dir.cwd(), cache, manager.init_data.io) catch {};

        var workspaces = manager.workspaces.iterator();
        while (workspaces.next()) |entry| {
            const workspace = entry.value_ptr.*;
            const workspace_modules = try std.fs.path.join(manager.allocator, &.{ workspace.path, "node_modules" });
            if (!manager.pathExists(workspace_modules)) continue;
            const old_workspace_name = try std.fmt.allocPrint(manager.allocator, "old_{s}_modules", .{std.fs.path.basename(workspace.path)});
            const old_workspace_modules = try std.fs.path.join(manager.allocator, &.{ old_modules, old_workspace_name });
            std.Io.Dir.cwd().rename(
                workspace_modules,
                std.Io.Dir.cwd(),
                old_workspace_modules,
                manager.init_data.io,
            ) catch {};
        }
    }

    fn finalizeIsolatedNodeModules(manager: *Manager) !void {
        if (manager.node_linker != .isolated or manager.options.lockfile_only or manager.options.dry_run) return;

        var modules = manager.isolated_managed_modules.iterator();
        while (modules.next()) |entry| {
            try manager.pruneManagedModuleLinks(entry.key_ptr.*);
        }

        const store = try std.fs.path.join(manager.allocator, &.{ manager.root_dir, "node_modules", ".bun" });
        var store_dir = std.Io.Dir.cwd().openDir(manager.init_data.io, store, .{ .iterate = true }) catch return;
        defer store_dir.close(manager.init_data.io);
        var store_iterator = store_dir.iterate();
        while (try store_iterator.next(manager.init_data.io)) |entry| {
            if (std.mem.eql(u8, entry.name, "node_modules")) continue;
            if (manager.isolated_live_store_keys.contains(entry.name)) continue;
            deletePath(manager.init_data.io, try std.fs.path.join(manager.allocator, &.{ store, entry.name }));
        }

        const root_modules = try std.fs.path.join(manager.allocator, &.{ manager.root_dir, "node_modules" });
        var root_dir = std.Io.Dir.cwd().openDir(manager.init_data.io, root_modules, .{ .iterate = true }) catch return;
        defer root_dir.close(manager.init_data.io);
        var root_iterator = root_dir.iterate();
        while (try root_iterator.next(manager.init_data.io)) |entry| {
            if (!std.mem.startsWith(u8, entry.name, ".old_modules-")) continue;
            deletePath(manager.init_data.io, try std.fs.path.join(manager.allocator, &.{ root_modules, entry.name }));
        }
    }

    fn pruneManagedModuleLinks(manager: *Manager, modules_dir: []const u8) !void {
        var directory = std.Io.Dir.cwd().openDir(manager.init_data.io, modules_dir, .{ .iterate = true }) catch return;
        defer directory.close(manager.init_data.io);
        var iterator = directory.iterate();
        while (try iterator.next(manager.init_data.io)) |entry| {
            if (entry.name.len == 0 or entry.name[0] == '.') continue;
            const path = try std.fs.path.join(manager.allocator, &.{ modules_dir, entry.name });
            if (entry.kind == .sym_link) {
                if (!manager.isolated_live_links.contains(path)) deletePath(manager.init_data.io, path);
                continue;
            }
            if (entry.kind != .directory or entry.name[0] != '@') continue;
            try manager.pruneManagedScopeLinks(path);
            std.Io.Dir.cwd().deleteDir(manager.init_data.io, path) catch {};
        }
    }

    fn pruneManagedScopeLinks(manager: *Manager, scope_dir: []const u8) !void {
        var directory = std.Io.Dir.cwd().openDir(manager.init_data.io, scope_dir, .{ .iterate = true }) catch return;
        defer directory.close(manager.init_data.io);
        var iterator = directory.iterate();
        while (try iterator.next(manager.init_data.io)) |entry| {
            if (entry.name.len == 0 or entry.name[0] == '.') continue;
            const path = try std.fs.path.join(manager.allocator, &.{ scope_dir, entry.name });
            if (entry.kind == .sym_link and !manager.isolated_live_links.contains(path)) {
                deletePath(manager.init_data.io, path);
            }
        }
    }

    fn loadConfiguration(manager: *Manager) !void {
        var registry = manager.options.registry;
        var configured_linker = manager.options.linker;
        if (registry == null) registry = manager.init_data.environ_map.get("BUN_CONFIG_REGISTRY");
        if (registry == null) registry = manager.init_data.environ_map.get("npm_config_registry");
        if (registry == null) registry = manager.init_data.environ_map.get("NPM_CONFIG_REGISTRY");
        if (manager.init_data.environ_map.get("BUN_CONFIG_HTTP_RETRY_COUNT")) |value| {
            manager.max_retry_count = std.fmt.parseInt(u16, value, 10) catch manager.max_retry_count;
        }
        if (manager.init_data.environ_map.get("BUN_CONFIG_TOKEN") orelse
            manager.init_data.environ_map.get("NPM_CONFIG_TOKEN")) |token|
        {
            manager.registry_authorization = try std.fmt.allocPrint(manager.allocator, "Bearer {s}", .{token});
        } else if (manager.init_data.environ_map.get("BUN_CONFIG_USERNAME")) |username| {
            if (manager.init_data.environ_map.get("BUN_CONFIG_PASSWORD")) |password| {
                const credentials = try std.fmt.allocPrint(manager.allocator, "{s}:{s}", .{ username, password });
                const encoded_len = std.base64.standard.Encoder.calcSize(credentials.len);
                const encoded = try manager.allocator.alloc(u8, encoded_len);
                _ = std.base64.standard.Encoder.encode(encoded, credentials);
                manager.registry_authorization = try std.fmt.allocPrint(manager.allocator, "Basic {s}", .{encoded});
            }
        }

        const bunfig_path = manager.options.config_path orelse "bunfig.toml";
        const bunfig: ?[]u8 = std.Io.Dir.cwd().readFileAlloc(
            manager.init_data.io,
            bunfig_path,
            manager.allocator,
            .limited(1024 * 1024),
        ) catch |err| blk: {
            if (manager.options.config_path != null) return err;
            break :blk null;
        };
        if (bunfig) |source| {
            if (registry == null) registry = parseTomlString(source, "registry");
            if (configured_linker == null) {
                if (parseTomlString(source, "linker")) |value| {
                    configured_linker = Isolated.Linker.parse(value) orelse return error.UnsupportedPackageManagerLinker;
                }
            }
            if (parseTomlBool(source, "saveTextLockfile")) |value| manager.save_text_lockfile = value;
            if (parseTomlBool(source, "exact")) |value| manager.options.exact = value;
            if (parseTomlBool(source, "frozenLockfile")) |value| manager.options.frozen_lockfile = value;
            const public_patterns = parseTomlStringList(manager.allocator, source, "publicHoistPattern") catch |err| {
                try manager.reportPatternConfigurationError(err);
                return error.PackageManagerErrorReported;
            };
            if (public_patterns) |patterns| {
                manager.public_hoist_pattern = try Isolated.HoistPattern.init(manager.allocator, patterns);
            }
            const hidden_patterns = parseTomlStringList(manager.allocator, source, "hoistPattern") catch |err| {
                try manager.reportPatternConfigurationError(err);
                return error.PackageManagerErrorReported;
            };
            if (hidden_patterns) |patterns| {
                manager.hidden_hoist_pattern = try Isolated.HoistPattern.init(manager.allocator, patterns);
            }
        }
        if (manager.options.save_text_lockfile) manager.save_text_lockfile = true;

        if (std.Io.Dir.cwd().readFileAlloc(
            manager.init_data.io,
            ".npmrc",
            manager.allocator,
            .limited(1024 * 1024),
        ) catch null) |npmrc| {
            if (registry == null) registry = parseNpmrcValue(npmrc, "registry");
            if (manager.registry_authorization == null) {
                if (parseNpmrcValue(npmrc, "_authToken")) |token| {
                    manager.registry_authorization = try std.fmt.allocPrint(manager.allocator, "Bearer {s}", .{token});
                } else if (parseNpmrcValue(npmrc, "_auth")) |auth| {
                    manager.registry_authorization = try std.fmt.allocPrint(manager.allocator, "Basic {s}", .{auth});
                }
            }
            if (manager.public_hoist_pattern == null) {
                if (try parseNpmrcStringList(manager.allocator, npmrc, "public-hoist-pattern")) |patterns| {
                    manager.public_hoist_pattern = try Isolated.HoistPattern.init(manager.allocator, patterns);
                }
            }
            if (manager.hidden_hoist_pattern == null) {
                if (try parseNpmrcStringList(manager.allocator, npmrc, "hoist-pattern")) |patterns| {
                    manager.hidden_hoist_pattern = try Isolated.HoistPattern.init(manager.allocator, patterns);
                }
            }
        }

        manager.node_linker = configured_linker orelse linker: {
            if (manager.options.command == .patch or manager.options.command == .patch_commit) {
                const store = try std.fs.path.join(manager.allocator, &.{ manager.root_dir, "node_modules", ".bun" });
                if (manager.pathExists(store)) break :linker .isolated;
            }
            break :linker .hoisted;
        };

        const selected = registry orelse default_registry;
        manager.registry = if (std.mem.endsWith(u8, selected, "/"))
            try manager.allocator.dupe(u8, selected)
        else
            try std.fmt.allocPrint(manager.allocator, "{s}/", .{selected});
    }

    fn reportPatternConfigurationError(manager: *Manager, err: anyerror) !void {
        switch (err) {
            error.ExpectedPatternString => try manager.stderr.writeAll("error: Expected a string\n"),
            else => try manager.stderr.writeAll("error: Expected a string or an array of strings\n"),
        }
    }

    fn loadLockfile(manager: *Manager, root: *const Value) !void {
        const text_path = try std.fs.path.join(manager.allocator, &.{ manager.root_dir, "bun.lock" });
        const source = std.Io.Dir.cwd().readFileAlloc(
            manager.init_data.io,
            text_path,
            manager.allocator,
            .limited(256 * 1024 * 1024),
        ) catch |err| {
            if (err != error.FileNotFound) return err;
            const binary_path = try std.fs.path.join(manager.allocator, &.{ manager.root_dir, "bun.lockb" });
            std.Io.Dir.cwd().access(manager.init_data.io, binary_path, .{}) catch {
                if (manager.options.frozen_lockfile) return error.FrozenLockfileNotFound;
                return;
            };
            // COTTONTAIL-COMPAT: Bun's bun.lockb reader deserializes directly
            // into allocator-owned packed Lockfile.Buffers; it has no clean
            // standalone graph decoder to extract without Bun global state.
            return error.BinaryLockfileUnsupported;
        };

        manager.lock_graph = try Lockfile.parseText(manager.allocator, source);
        if (!manager.lock_graph.?.rootMatchesPackageJSON(root) or
            !manager.manifest_policy.?.matchesLockDocument(&manager.lock_graph.?.document))
        {
            if (manager.options.frozen_lockfile) return error.FrozenLockfileChanged;
            manager.changed = true;
        }
    }

    fn validateLockfileWorkspaces(manager: *Manager) !void {
        const graph = if (manager.lock_graph) |*value| value else return;
        var matched: usize = 1;
        var iterator = manager.workspaces.iterator();
        while (iterator.next()) |entry| {
            const workspace = entry.value_ptr.*;
            const path = try manager.relativeLockPath(workspace.path);
            if (!graph.workspaceMatchesPackageJSON(path, workspace.package_json)) {
                if (manager.options.frozen_lockfile) return error.FrozenLockfileChanged;
                manager.changed = true;
            } else {
                matched += 1;
            }
        }
        if (matched != graph.workspaces.count()) {
            if (manager.options.frozen_lockfile) return error.FrozenLockfileChanged;
            manager.changed = true;
        }
    }

    fn installRoot(manager: *Manager, root: *Value, report_direct: bool) !void {
        const previous_report_direct = manager.report_direct_installs;
        manager.report_direct_installs = report_direct and !manager.options.lockfile_only;
        defer manager.report_direct_installs = previous_report_direct;
        try manager.installDependencyObject(root, "dependencies", manager.root_dir, true, false);
        if (!manager.options.omit_optional) {
            try manager.installDependencyObject(root, "optionalDependencies", manager.root_dir, true, true);
        }
        if (!manager.options.production and !manager.options.omit_dev) {
            try manager.installDependencyObject(root, "devDependencies", manager.root_dir, true, false);
        }
        if (!manager.options.omit_peer) {
            try manager.installDependencyObject(root, "peerDependencies", manager.root_dir, true, false);
        }
        try manager.installWorkspaceDependencies();
        try manager.relinkNativeDependencyBins(root);
    }

    fn addPackages(manager: *Manager, root: *Value) !void {
        if (manager.options.positionals.len == 0) return error.MissingPackageName;
        var added_output: std.Io.Writer.Allocating = .init(manager.allocator);

        for (manager.options.positionals) |raw_spec| {
            if (hasUnknownURLScheme(raw_spec)) {
                try manager.stderr.print("error: unrecognised dependency format: {s}\n", .{raw_spec});
                return error.PackageManagerErrorReported;
            }

            const parsed = splitPackageSpec(raw_spec);
            var alias = parsed.name;
            var requested = parsed.spec;
            var resolved_version: []const u8 = undefined;
            var display_resolution: []const u8 = undefined;
            manager.direct_bins.clearRetainingCapacity();

            if (isGitSpec(requested)) {
                const git = try manager.installGit(alias, requested, manager.root_dir, true, false, null, &.{});
                alias = git.alias;
                resolved_version = git.version;
                display_resolution = git.source;
            } else if (isTarballSpec(requested)) {
                const tarball = try manager.installTarball(alias, requested, manager.root_dir, true, false, &.{});
                alias = tarball.alias;
                resolved_version = tarball.version;
                display_resolution = requested;
            } else if (isLocalSpec(requested)) {
                const local = manager.resolveLocalPackage(requested, manager.root_dir) catch |err| {
                    try manager.stderr.print("note: error occurred while resolving {s}\n", .{requested});
                    return err;
                };
                alias = alias orelse local.name;
                requested = try manager.normalizeLocalSpec(requested, local.path);
                display_resolution = localSpecPath(requested);
            } else if (alias == null) {
                return error.InvalidPackageName;
            }
            const name = alias.?;
            const target_section = manager.sectionForAdd(root, name);
            const section = try ensureObjectProperty(manager.allocator, &root.object, target_section.key());

            if (manager.options.only_missing and section.get(name) != null) continue;
            if (!isTarballSpec(requested) and !isGitSpec(requested)) {
                resolved_version = try manager.installDependency(name, requested, manager.root_dir, true, false);
                if (!isLocalSpec(requested)) display_resolution = resolved_version;
            }
            const saved_spec = if (isTarballSpec(requested) or isGitSpec(requested) or isLocalSpec(requested) or std.mem.startsWith(u8, requested, "workspace:"))
                requested
            else if (hasExplicitRange(raw_spec))
                requested
            else if (manager.options.exact)
                resolved_version
            else
                try std.fmt.allocPrint(manager.allocator, "^{s}", .{resolved_version});
            manager.removeDependencyFromOtherSections(root, name, target_section);
            try section.put(manager.allocator, try manager.allocator.dupe(u8, name), .{ .string = try manager.allocator.dupe(u8, saved_spec) });
            manager.changed = true;
            if (!manager.options.silent) {
                if (manager.direct_bins.items.len == 0) {
                    try added_output.writer.print("installed {s}@{s}\n", .{ name, display_resolution });
                } else {
                    try added_output.writer.print("installed {s}@{s} with binaries:\n", .{ name, display_resolution });
                    for (manager.direct_bins.items) |bin_name| try added_output.writer.print(" - {s}\n", .{bin_name});
                }
            }
        }
        const installed_before_reconcile = manager.installed_count;
        try manager.installRoot(root, true);
        if (!manager.options.silent) {
            if (manager.installed_count > installed_before_reconcile and added_output.written().len > 0) {
                try manager.stdout.writeByte('\n');
            }
            try manager.stdout.writeAll(added_output.written());
        }
    }

    fn sectionForAdd(manager: *Manager, root: *Value, name: []const u8) DependencySection {
        if (manager.options.section != .dependencies) return manager.options.section;
        const candidates = [_]DependencySection{ .dependencies, .devDependencies, .optionalDependencies, .peerDependencies };
        for (candidates) |candidate| {
            const section = root.object.get(candidate.key()) orelse continue;
            if (section == .object and section.object.get(name) != null) return candidate;
        }
        return .dependencies;
    }

    fn removeDependencyFromOtherSections(manager: *Manager, root: *Value, name: []const u8, keep: DependencySection) void {
        _ = manager;
        const sections = [_]DependencySection{ .dependencies, .devDependencies, .optionalDependencies, .peerDependencies };
        for (sections) |section| {
            if (section == keep) continue;
            if (root.object.getPtr(section.key())) |value| {
                if (value.* == .object) _ = value.object.orderedRemove(name);
            }
        }
    }

    fn removePackages(manager: *Manager, root: *Value) !void {
        if (manager.options.positionals.len == 0) return error.MissingPackageName;
        var removed: usize = 0;
        for (manager.options.positionals) |name| {
            for (all_dependency_sections) |section_name| {
                if (root.object.getPtr(section_name)) |section| {
                    if (section.* == .object and section.object.orderedRemove(name)) {
                        removed += 1;
                        manager.changed = true;
                    }
                    if (section.* == .object and section.object.count() == 0) {
                        _ = root.object.orderedRemove(section_name);
                    }
                }
            }
            const path = try packageDestination(manager.allocator, manager.root_dir, name);
            if (!manager.options.dry_run) deletePath(manager.init_data.io, path);
        }
        try manager.installRoot(root, true);
        if (!manager.options.silent and removed > 0) try manager.stdout.print("Removed: {d}\n", .{removed});
    }

    fn updatePackages(manager: *Manager, root: *Value) !void {
        const requested = manager.options.positionals;
        const previous_force = manager.options.force;
        manager.options.force = true;
        defer manager.options.force = previous_force;
        for (mutable_dependency_sections) |section_name| {
            const section_value = root.object.getPtr(section_name) orelse continue;
            if (section_value.* != .object) continue;
            for (section_value.object.keys(), section_value.object.values()) |name, *spec_value| {
                if (requested.len > 0 and !containsString(requested, name)) continue;
                if (spec_value.* != .string or isLocalSpec(spec_value.string)) continue;
                const resolved = try manager.installDependency(
                    name,
                    if (manager.options.latest or requested.len > 0) "latest" else spec_value.string,
                    manager.root_dir,
                    true,
                    false,
                );
                spec_value.* = .{ .string = if (manager.options.exact)
                    resolved
                else
                    try std.fmt.allocPrint(manager.allocator, "^{s}", .{resolved}) };
                manager.changed = true;
            }
        }
    }

    fn installDependencyObject(
        manager: *Manager,
        package_json: *Value,
        key: []const u8,
        parent_dir: []const u8,
        direct: bool,
        optional: bool,
    ) anyerror!void {
        if (package_json.* != .object) return;
        const dependencies = package_json.object.get(key) orelse return;
        if (dependencies != .object) return;
        for (dependencies.object.keys(), dependencies.object.values()) |alias, spec_value| {
            if (spec_value != .string) continue;
            if (std.mem.eql(u8, key, "dependencies") and objectSectionContains(package_json, "optionalDependencies", alias)) continue;
            if (std.mem.eql(u8, key, "peerDependencies") and
                (objectSectionContains(package_json, "dependencies", alias) or
                    objectSectionContains(package_json, "optionalDependencies", alias))) continue;
            const edge_optional = optional or
                (std.mem.eql(u8, key, "peerDependencies") and peerDependencyIsOptional(package_json, alias));
            const installed_before = manager.installed_count;
            const resolved_version = manager.installDependency(alias, spec_value.string, parent_dir, direct, edge_optional) catch |err| {
                if (edge_optional) continue;
                return err;
            };
            if (direct and manager.report_direct_installs and manager.installed_count > installed_before and !manager.options.silent) {
                const display = if (isTarballSpec(spec_value.string))
                    spec_value.string
                else if (isLocalSpec(spec_value.string))
                    localSpecPath(spec_value.string)
                else
                    resolved_version;
                try manager.stdout.print("+ {s}@{s}\n", .{ alias, display });
            }
        }
    }

    fn installDependency(
        manager: *Manager,
        alias: []const u8,
        spec: []const u8,
        parent_dir: []const u8,
        direct: bool,
        optional: bool,
    ) anyerror![]const u8 {
        const workspace_package = std.mem.startsWith(u8, spec, "workspace:") or manager.workspaces.get(alias) != null;
        const effective_spec = manager.manifest_policy.?.resolveDependency(alias, spec, workspace_package) catch |err| {
            if (err == error.CatalogDependencyNotFound or err == error.InvalidCatalogDependency) {
                try manager.stderr.print("error: {s}@{s} failed to resolve\n", .{ alias, spec });
                return error.PackageManagerErrorReported;
            }
            return err;
        };
        var protocol_patch_paths: []const []const u8 = &.{};
        const resolution_spec = if (try Patch.Spec.parseProtocol(manager.allocator, alias, effective_spec)) |protocol| blk: {
            protocol_patch_paths = protocol.patch_paths;
            break :blk protocol.base_spec;
        } else effective_spec;

        if (direct) {
            for (manager.records.items) |record| {
                if (std.mem.eql(u8, record.alias, alias) and std.mem.eql(u8, record.key, alias)) return record.version;
            }
        }

        if (try manager.findLockedSelection(alias, parent_dir)) |selection| {
            if (try manager.lockedPackageMatches(selection.package, alias, resolution_spec, parent_dir)) {
                const cycle_key = try std.fmt.allocPrint(manager.allocator, "lock:{s}", .{selection.package.key});
                if (manager.resolving.contains(cycle_key)) {
                    try manager.ensureIsolatedLinks(alias, parent_dir, selection.destination);
                    return selection.package.version;
                }
                try manager.resolving.put(cycle_key, {});
                defer _ = manager.resolving.remove(cycle_key);
                return manager.installLockedPackage(selection, alias, parent_dir, direct, optional, protocol_patch_paths);
            }
            if (manager.options.frozen_lockfile) return error.FrozenLockfileChanged;
        } else if (manager.options.frozen_lockfile) {
            return error.FrozenLockfilePackageMissing;
        }

        if (workspace_package) {
            if (protocol_patch_paths.len > 0) return error.UnsupportedPatchResolution;
            const workspace = try manager.resolveWorkspaceDependency(alias, resolution_spec, parent_dir) orelse return error.WorkspaceNotFound;
            _ = try manager.peerContextForPackage(workspace.package_json, parent_dir, true);
            const destination = if (manager.node_linker == .isolated)
                try std.fs.path.join(manager.allocator, &.{ try manager.isolatedConsumerModules(parent_dir), alias })
            else
                try packageDestination(manager.allocator, manager.root_dir, alias);
            if (!manager.options.lockfile_only) {
                if (manager.node_linker == .isolated)
                    try manager.linkRelativeDirectory(destination, workspace.path, true)
                else
                    try manager.linkDirectory(alias, workspace.path);
            }
            try manager.addRecord(.{
                .key = if (manager.node_linker == .isolated)
                    try manager.dependencyLockKey(parent_dir, alias)
                else
                    try manager.lockKeyForDestination(destination),
                .alias = alias,
                .name = workspace.name,
                .version = workspace.version,
                .local_path = workspace.path,
                .resolution = workspace.path,
                .kind = .workspace,
                .metadata = workspace.package_json,
                .install_dir = workspace.path,
            });
            try manager.rememberPackageMetadata(workspace.path, workspace.package_json);
            try manager.linkPeerDependencies(workspace.package_json, workspace.path, parent_dir);
            return workspace.version;
        }

        if (isGitSpec(resolution_spec)) {
            const git = try manager.installGit(alias, resolution_spec, parent_dir, direct, optional, null, protocol_patch_paths);
            return git.version;
        }

        if (isTarballSpec(resolution_spec)) {
            const tarball = try manager.installTarball(alias, resolution_spec, parent_dir, direct, optional, protocol_patch_paths);
            return tarball.version;
        }

        if (isLocalSpec(resolution_spec)) {
            if (protocol_patch_paths.len > 0) return error.UnsupportedPatchResolution;
            const local = try manager.resolveLocalPackage(resolution_spec, parent_dir);
            const kind: Lockfile.Kind = if (std.mem.startsWith(u8, resolution_spec, "link:")) .symlink else .folder;
            const placement_kind: Lockfile.Kind = if (std.mem.eql(u8, local.path, manager.root_dir)) .root else kind;
            const normalized_source = try manager.normalizeLocalSpec(resolution_spec, local.path);
            const peer_context = try manager.peerContextForPackage(local.package_json, parent_dir, true);
            const destination = if (manager.node_linker == .isolated)
                try manager.packageInstallDestinationWithPeerContext(
                    alias,
                    local.name,
                    local.version,
                    placement_kind,
                    localSpecPath(normalized_source),
                    parent_dir,
                    direct,
                    peer_context,
                )
            else
                try packageDestination(manager.allocator, manager.root_dir, alias);
            const newly_installed = !manager.pathExists(destination);
            if (!manager.options.lockfile_only) {
                if (manager.node_linker == .isolated) {
                    if (kind == .symlink or placement_kind == .root) {
                        try manager.linkRelativeDirectory(destination, local.path, true);
                    } else {
                        deletePath(manager.init_data.io, destination);
                        try copyDirectoryTree(manager.init_data.io, manager.allocator, local.path, destination);
                    }
                    try manager.ensureIsolatedLinks(alias, parent_dir, destination);
                } else {
                    try manager.linkDirectory(alias, local.path);
                }
                try manager.linkBins(alias, destination, local.package_json, direct, parent_dir);
            }
            try manager.addRecord(.{
                .key = if (manager.node_linker == .isolated)
                    try manager.dependencyLockKey(parent_dir, alias)
                else
                    try manager.lockKeyForDestination(destination),
                .alias = alias,
                .name = local.name,
                .version = local.version,
                .local_path = local.path,
                .resolution = localSpecPath(normalized_source),
                .kind = placement_kind,
                .metadata = local.package_json,
                .peer_hash = peer_context.hash,
                .install_dir = destination,
            });
            try manager.rememberPackageMetadata(destination, local.package_json);
            try manager.rememberPackageMetadata(local.path, local.package_json);
            manager.installed_count += 1;
            if (placement_kind != .root) {
                try manager.rememberIsolatedSourceParent(local.path, destination);
                const cycle_key = try std.fmt.allocPrint(manager.allocator, "local:{s}", .{local.path});
                if (!manager.resolving.contains(cycle_key)) {
                    try manager.resolving.put(cycle_key, {});
                    defer _ = manager.resolving.remove(cycle_key);
                    try manager.installDependencyObject(local.package_json, "dependencies", local.path, false, false);
                    if (!manager.options.omit_optional) {
                        try manager.installDependencyObject(local.package_json, "optionalDependencies", local.path, false, true);
                    }
                    try manager.installOrLinkPeerDependencies(local.package_json, local.path, destination, parent_dir);
                }
            }
            if (placement_kind != .root) {
                try manager.queuePackageScripts(alias, local.version, destination, .local, optional, newly_installed);
            }
            return local.version;
        }

        const registry_name, const registry_spec = parseNpmAlias(alias, resolution_spec);
        const cycle_key = try std.fmt.allocPrint(manager.allocator, "{s}@{s}", .{ registry_name, registry_spec });
        if (manager.resolving.contains(cycle_key)) {
            if (manager.node_linker == .isolated) {
                for (manager.records.items) |record| {
                    if (record.kind != .npm or
                        !std.mem.eql(u8, record.name, registry_name) or
                        !semverSatisfies(manager.allocator, registry_spec, record.version)) continue;
                    const placement = try manager.packagePlacementWithPeerContext(
                        record.name,
                        record.version,
                        record.kind,
                        record.tarball,
                        .{ .hash = record.peer_hash },
                    );
                    try manager.trackIsolatedPlacement(placement);
                    try manager.rememberIsolatedParent(placement, record.key);
                    try manager.ensureIsolatedLinks(alias, parent_dir, placement.package_dir);
                    return record.version;
                }
            }
            return registry_spec;
        }
        try manager.resolving.put(cycle_key, {});
        defer _ = manager.resolving.remove(cycle_key);

        if (!manager.options.force) {
            if (try manager.findInstalledVersion(alias, resolution_spec, parent_dir, direct, protocol_patch_paths)) |installed| return installed;
        }

        const resolved = try manager.resolveRegistryPackage(registry_name, registry_spec);
        const peer_context = try manager.peerContextForPackage(resolved.metadata, parent_dir, true);
        const destination = try manager.packageInstallDestinationWithPeerContext(
            alias,
            resolved.name,
            resolved.version,
            .npm,
            resolved.tarball,
            parent_dir,
            direct,
            peer_context,
        );
        if (!manager.options.lockfile_only and !manager.options.dry_run) {
            const archive = try manager.fetchBytes(resolved.tarball, false, max_tarball_bytes);
            if (manager.options.verify_integrity) try verifyIntegrity(archive, resolved.integrity);
            deletePath(manager.init_data.io, destination);
            try std.Io.Dir.cwd().createDirPath(manager.init_data.io, destination);
            var destination_dir = try std.Io.Dir.cwd().openDir(manager.init_data.io, destination, .{});
            defer destination_dir.close(manager.init_data.io);
            try extractTarballArchive(manager.init_data.io, manager.allocator, destination_dir, archive);
            try manager.applyPackagePatch(resolved.name, resolved.version, destination, protocol_patch_paths);
            try manager.ensureIsolatedLinks(alias, parent_dir, destination);
            const bin_metadata = (try manager.metadataForInstalledPackage(destination, resolved.metadata)).?;
            try manager.linkBins(alias, destination, bin_metadata, direct, parent_dir);
        }

        try manager.root_versions.put(try manager.allocator.dupe(u8, alias), resolved.version);
        try manager.addRecord(.{
            .key = if (manager.node_linker == .isolated)
                try manager.dependencyLockKey(parent_dir, alias)
            else
                try manager.lockKeyForDestination(destination),
            .alias = alias,
            .name = resolved.name,
            .version = resolved.version,
            .tarball = resolved.tarball,
            .integrity = resolved.integrity orelse "",
            .metadata = resolved.metadata,
            .peer_hash = peer_context.hash,
            .install_dir = destination,
        });
        try manager.rememberPackageMetadata(destination, resolved.metadata);
        manager.installed_count += 1;
        manager.changed = true;

        try manager.installDependencyObject(@constCast(resolved.metadata), "dependencies", destination, false, false);
        if (!manager.options.omit_optional) {
            try manager.installDependencyObject(@constCast(resolved.metadata), "optionalDependencies", destination, false, true);
        }
        try manager.installOrLinkPeerDependencies(resolved.metadata, destination, destination, parent_dir);
        try manager.queuePackageScripts(resolved.name, resolved.version, destination, .npm, optional, true);
        return resolved.version;
    }

    fn findLockedSelection(
        manager: *Manager,
        alias: []const u8,
        parent_dir: []const u8,
    ) !?LockedSelection {
        const graph = if (manager.lock_graph) |*value| value else return null;
        if (manager.node_linker == .isolated) {
            const logical_key = try manager.dependencyLockKey(parent_dir, alias);
            const package = graph.get(logical_key) orelse graph.get(alias) orelse return null;
            const peer_context = if (package.kind == .workspace)
                Isolated.PeerContext{}
            else
                try manager.peerContextForPackage(package.info, parent_dir, false);
            const destination = if (package.kind == .workspace)
                try std.fs.path.join(manager.allocator, &.{ try manager.isolatedConsumerModules(parent_dir), alias })
            else blk: {
                const placement = try manager.packagePlacementFromLock(package, peer_context);
                try manager.rememberIsolatedParent(placement, package.key);
                break :blk placement.package_dir;
            };
            return .{
                .package = package,
                .destination = destination,
                .peer_context = peer_context,
            };
        }
        var base = parent_dir;
        while (true) {
            const destination = try packageDestination(manager.allocator, base, alias);
            if (manager.lockKeyForDestination(destination) catch null) |key| {
                if (graph.get(key)) |package| return .{ .package = package, .destination = destination };
            }
            if (std.mem.eql(u8, base, manager.root_dir)) break;
            base = parentPackageBase(manager.root_dir, base) orelse break;
        }
        return null;
    }

    fn lockedPackageMatches(
        manager: *Manager,
        package: *const Lockfile.Package,
        alias: []const u8,
        spec: []const u8,
        parent_dir: []const u8,
    ) !bool {
        switch (package.kind) {
            .npm => {
                const registry_name, const registry_spec = parseNpmAlias(alias, spec);
                return std.mem.eql(u8, registry_name, package.name) and
                    semverSatisfies(manager.allocator, registry_spec, package.version);
            },
            .workspace => return std.mem.startsWith(u8, spec, "workspace:") and
                (std.mem.eql(u8, alias, package.name) or manager.workspaces.get(package.name) != null),
            .folder, .symlink => {
                if (!isLocalSpec(spec)) return false;
                const requested = try absolutePathFrom(manager.allocator, parent_dir, localSpecPath(spec));
                const locked = try absolutePathFrom(manager.allocator, manager.root_dir, package.source);
                return std.mem.eql(u8, requested, locked);
            },
            .local_tarball => {
                if (!isTarballSpec(spec)) return false;
                const requested = try absolutePathFrom(manager.allocator, parent_dir, localSpecPath(spec));
                const locked = try absolutePathFrom(manager.allocator, manager.root_dir, localSpecPath(package.source));
                return std.mem.eql(u8, requested, locked);
            },
            .remote_tarball => return std.mem.eql(u8, spec, package.source),
            .git, .github => {
                if (!isGitSpec(spec) or !try Git.matches(manager.allocator, package.source, spec)) return false;
                const requested = manager.lock_graph.?.rootDependencySpec(alias);
                if (requested != null and !std.mem.eql(u8, requested.?, spec)) {
                    const parsed = (try Git.parse(manager.allocator, spec)) orelse return false;
                    if (!isGitCommitish(parsed.committish)) return false;
                }
                return true;
            },
            .root => {
                if (!isLocalSpec(spec)) return false;
                const requested = try absolutePathFrom(manager.allocator, parent_dir, localSpecPath(spec));
                return std.mem.eql(u8, requested, manager.root_dir);
            },
        }
    }

    fn installLockedPackage(
        manager: *Manager,
        selection: LockedSelection,
        alias: []const u8,
        parent_dir: []const u8,
        direct: bool,
        optional: bool,
        protocol_patch_paths: []const []const u8,
    ) anyerror![]const u8 {
        const package = selection.package;
        if (manager.node_linker == .isolated and package.kind != .workspace) {
            try manager.trackIsolatedPlacement(try manager.packagePlacementFromLock(package, selection.peer_context));
            _ = try manager.peerContextForPackage(package.info, parent_dir, true);
        }
        switch (package.kind) {
            .npm => {
                const patch_paths = try manager.packagePatchPaths(package.name, package.version, protocol_patch_paths);
                var installed = false;
                if (!manager.options.lockfile_only and !manager.options.dry_run) {
                    installed = !manager.options.force and
                        try manager.installedPackageMatches(selection.destination, package.name, package.version) and
                        try manager.packagePatchStateMatches(selection.destination, patch_paths);
                    if (!installed) {
                        const tarball_url = if (package.source.len > 0)
                            package.source
                        else
                            try manager.defaultTarballURL(package.name, package.version);
                        const archive = try manager.fetchBytes(tarball_url, false, max_tarball_bytes);
                        if (manager.options.verify_integrity) {
                            try verifyIntegrity(archive, if (package.integrity.len > 0) package.integrity else null);
                        }
                        deletePath(manager.init_data.io, selection.destination);
                        try std.Io.Dir.cwd().createDirPath(manager.init_data.io, selection.destination);
                        var destination_dir = try std.Io.Dir.cwd().openDir(manager.init_data.io, selection.destination, .{});
                        defer destination_dir.close(manager.init_data.io);
                        try extractTarballArchive(manager.init_data.io, manager.allocator, destination_dir, archive);
                        try manager.applyPatchPaths(selection.destination, patch_paths);
                        manager.installed_count += 1;
                    }
                    try manager.ensureIsolatedLinks(alias, parent_dir, selection.destination);
                    if (try manager.metadataForInstalledPackage(selection.destination, package.info)) |info| {
                        try manager.linkBins(alias, selection.destination, info, direct, parent_dir);
                    }
                }

                if (isTopLevelDestination(manager.root_dir, selection.destination, alias)) {
                    try manager.root_versions.put(try manager.allocator.dupe(u8, alias), package.version);
                }
                try manager.addRecord(.{
                    .key = package.key,
                    .alias = alias,
                    .name = package.name,
                    .version = package.version,
                    .tarball = package.source,
                    .integrity = package.integrity,
                    .metadata = package.info,
                    .peer_hash = selection.peer_context.hash,
                    .install_dir = selection.destination,
                });
                try manager.rememberPackageMetadata(selection.destination, package.info);
                try manager.installLockedDependencies(package, selection.destination, selection.destination, parent_dir);
                try manager.queuePackageScripts(package.name, package.version, selection.destination, .npm, optional, !installed);
                return package.version;
            },
            .workspace => {
                if (protocol_patch_paths.len > 0) return error.UnsupportedPatchResolution;
                const workspace = manager.workspaces.get(package.name) orelse manager.workspaces.get(alias) orelse return error.WorkspaceNotFound;
                if (!manager.options.lockfile_only and !manager.options.dry_run) {
                    if (manager.node_linker == .isolated)
                        try manager.linkRelativeDirectory(selection.destination, workspace.path, true)
                    else
                        try manager.linkDirectoryAt(selection.destination, workspace.path);
                }
                try manager.addRecord(.{
                    .key = package.key,
                    .alias = alias,
                    .name = workspace.name,
                    .version = workspace.version,
                    .local_path = workspace.path,
                    .resolution = package.source,
                    .kind = .workspace,
                    .metadata = workspace.package_json,
                    .install_dir = workspace.path,
                });
                try manager.rememberPackageMetadata(workspace.path, workspace.package_json);
                if (!manager.options.lockfile_only and !manager.options.dry_run) {
                    try manager.linkBins(alias, selection.destination, workspace.package_json, direct, parent_dir);
                }
                try manager.installDependencyObject(workspace.package_json, "dependencies", workspace.path, false, false);
                if (!manager.options.omit_optional) {
                    try manager.installDependencyObject(workspace.package_json, "optionalDependencies", workspace.path, false, true);
                }
                try manager.installOrLinkPeerDependencies(workspace.package_json, workspace.path, workspace.path, parent_dir);
                return workspace.version;
            },
            .folder, .symlink => {
                if (protocol_patch_paths.len > 0) return error.UnsupportedPatchResolution;
                const spec = try std.fmt.allocPrint(manager.allocator, "{s}{s}", .{
                    if (package.kind == .symlink) "link:" else "file:",
                    package.source,
                });
                const local = try manager.resolveLocalPackage(spec, manager.root_dir);
                const newly_installed = !manager.pathExists(selection.destination);
                if (!manager.options.lockfile_only and !manager.options.dry_run) {
                    if (manager.node_linker == .isolated) {
                        if (package.kind == .symlink) {
                            try manager.linkRelativeDirectory(selection.destination, local.path, true);
                        } else {
                            deletePath(manager.init_data.io, selection.destination);
                            try copyDirectoryTree(manager.init_data.io, manager.allocator, local.path, selection.destination);
                        }
                        try manager.ensureIsolatedLinks(alias, parent_dir, selection.destination);
                    } else {
                        try manager.linkDirectoryAt(selection.destination, local.path);
                    }
                    try manager.linkBins(alias, selection.destination, package.info orelse local.package_json, direct, parent_dir);
                }
                try manager.addRecord(.{
                    .key = package.key,
                    .alias = alias,
                    .name = local.name,
                    .version = local.version,
                    .local_path = local.path,
                    .resolution = package.source,
                    .kind = package.kind,
                    .metadata = package.info orelse local.package_json,
                    .peer_hash = selection.peer_context.hash,
                    .install_dir = selection.destination,
                });
                try manager.rememberPackageMetadata(selection.destination, package.info orelse local.package_json);
                try manager.rememberPackageMetadata(local.path, package.info orelse local.package_json);
                try manager.rememberIsolatedSourceParent(local.path, selection.destination);
                try manager.installLockedDependencies(package, local.path, selection.destination, parent_dir);
                try manager.queuePackageScripts(package.name, local.version, selection.destination, .local, optional, newly_installed);
                return local.version;
            },
            .local_tarball, .remote_tarball => {
                const archive = if (package.kind == .remote_tarball)
                    try manager.fetchBytes(package.source, false, max_tarball_bytes)
                else blk: {
                    const path = try absolutePathFrom(manager.allocator, manager.root_dir, localSpecPath(package.source));
                    break :blk try std.Io.Dir.cwd().readFileAlloc(
                        manager.init_data.io,
                        path,
                        manager.allocator,
                        .limited(max_tarball_bytes),
                    );
                };
                if (manager.options.verify_integrity) {
                    try verifyIntegrity(archive, if (package.integrity.len > 0) package.integrity else null);
                }
                const metadata = try manager.readTarballPackageJSON(archive);
                const name = jsonString(metadata, "name") orelse package.name;
                const version_value = jsonString(metadata, "version") orelse "0.0.0";
                const patch_paths = try manager.packagePatchPaths(name, version_value, protocol_patch_paths);
                var installed = false;
                if (!manager.options.lockfile_only and !manager.options.dry_run) {
                    installed = !manager.options.force and
                        try manager.installedPackageMatches(selection.destination, name, version_value) and
                        try manager.packagePatchStateMatches(selection.destination, patch_paths);
                    if (!installed) {
                        deletePath(manager.init_data.io, selection.destination);
                        try std.Io.Dir.cwd().createDirPath(manager.init_data.io, selection.destination);
                        var destination_dir = try std.Io.Dir.cwd().openDir(manager.init_data.io, selection.destination, .{});
                        defer destination_dir.close(manager.init_data.io);
                        try extractTarballArchive(manager.init_data.io, manager.allocator, destination_dir, archive);
                        try manager.applyPatchPaths(selection.destination, patch_paths);
                        manager.installed_count += 1;
                    }
                    try manager.ensureIsolatedLinks(alias, parent_dir, selection.destination);
                    const bin_metadata = (try manager.metadataForInstalledPackage(
                        selection.destination,
                        package.info orelse metadata,
                    )).?;
                    try manager.linkBins(alias, selection.destination, bin_metadata, direct, parent_dir);
                }
                try manager.addRecord(.{
                    .key = package.key,
                    .alias = alias,
                    .name = name,
                    .version = version_value,
                    .tarball = package.source,
                    .integrity = package.integrity,
                    .resolution = package.source,
                    .kind = package.kind,
                    .metadata = package.info orelse metadata,
                    .peer_hash = selection.peer_context.hash,
                    .install_dir = selection.destination,
                });
                try manager.rememberPackageMetadata(selection.destination, package.info orelse metadata);
                try manager.installLockedDependencies(package, selection.destination, selection.destination, parent_dir);
                try manager.queuePackageScripts(name, version_value, selection.destination, .local, optional, !installed);
                return version_value;
            },
            .git, .github => {
                const git = try manager.installGit(alias, package.source, parent_dir, direct, optional, selection, protocol_patch_paths);
                return git.version;
            },
            .root => {
                const metadata = package.info orelse manager.root_package_json orelse return error.InvalidLockedRootResolution;
                const package_name = package.name;
                const package_version = jsonString(metadata, "version") orelse "0.0.0";
                if (!manager.options.lockfile_only and !manager.options.dry_run) {
                    try manager.linkRelativeDirectory(selection.destination, manager.root_dir, true);
                    try manager.ensureIsolatedLinks(alias, parent_dir, selection.destination);
                    try manager.linkBins(alias, selection.destination, metadata, direct, parent_dir);
                }
                try manager.addRecord(.{
                    .key = package.key,
                    .alias = alias,
                    .name = package_name,
                    .version = package_version,
                    .local_path = manager.root_dir,
                    .resolution = ".",
                    .kind = .root,
                    .metadata = metadata,
                    .peer_hash = selection.peer_context.hash,
                    .install_dir = selection.destination,
                });
                try manager.rememberPackageMetadata(selection.destination, metadata);
                return package_version;
            },
        }
    }

    fn installLockedDependencies(
        manager: *Manager,
        package: *const Lockfile.Package,
        dependency_parent_dir: []const u8,
        package_dir: []const u8,
        peer_parent_dir: []const u8,
    ) !void {
        const info = package.info orelse return;
        try manager.installDependencyObject(@constCast(info), "dependencies", dependency_parent_dir, false, false);
        if (!manager.options.omit_optional) {
            try manager.installDependencyObject(@constCast(info), "optionalDependencies", dependency_parent_dir, false, true);
        }
        try manager.installOrLinkPeerDependencies(info, dependency_parent_dir, package_dir, peer_parent_dir);
    }

    fn installedPackageMatches(manager: *Manager, destination: []const u8, name: []const u8, version_value: []const u8) !bool {
        const package_json_path = try std.fs.path.join(manager.allocator, &.{ destination, "package.json" });
        const source = std.Io.Dir.cwd().readFileAlloc(
            manager.init_data.io,
            package_json_path,
            manager.allocator,
            .limited(4 * 1024 * 1024),
        ) catch return false;
        const package_json = std.json.parseFromSliceLeaky(Value, manager.allocator, source, .{}) catch return false;
        return package_json == .object and
            std.mem.eql(u8, jsonString(&package_json, "name") orelse "", name) and
            std.mem.eql(u8, jsonString(&package_json, "version") orelse "", version_value);
    }

    fn packagePatchPaths(
        manager: *Manager,
        package_name: []const u8,
        version_value: []const u8,
        protocol_patch_paths: []const []const u8,
    ) ![]const []const u8 {
        const configured_path = manager.manifest_policy.?.patchPath(package_name, version_value);
        if (configured_path == null) return protocol_patch_paths;
        for (protocol_patch_paths) |path| {
            if (std.mem.eql(u8, path, configured_path.?)) return protocol_patch_paths;
        }

        var paths = std.array_list.Managed([]const u8).init(manager.allocator);
        try paths.appendSlice(protocol_patch_paths);
        try paths.append(configured_path.?);
        return paths.toOwnedSlice();
    }

    fn packagePatchStateMatches(
        manager: *Manager,
        package_dir: []const u8,
        patch_paths: []const []const u8,
    ) !bool {
        return Patch.installedStateMatches(
            manager.allocator,
            manager.init_data.io,
            manager.root_dir,
            package_dir,
            patch_paths,
        ) catch |err| return manager.patchFailure(err, patch_paths);
    }

    fn applyPackagePatch(
        manager: *Manager,
        package_name: []const u8,
        version_value: []const u8,
        package_dir: []const u8,
        protocol_patch_paths: []const []const u8,
    ) !void {
        const patch_paths = try manager.packagePatchPaths(package_name, version_value, protocol_patch_paths);
        return manager.applyPatchPaths(package_dir, patch_paths);
    }

    fn applyPatchPaths(
        manager: *Manager,
        package_dir: []const u8,
        patch_paths: []const []const u8,
    ) !void {
        Patch.apply(
            manager.allocator,
            manager.init_data.io,
            manager.root_dir,
            package_dir,
            patch_paths,
        ) catch |err| return manager.patchFailure(err, patch_paths);
    }

    fn patchFailure(manager: *Manager, err: anyerror, patch_paths: []const []const u8) anyerror {
        const path = if (patch_paths.len > 0) patch_paths[0] else "";
        switch (err) {
            error.PatchFileNotFound => manager.stderr.print("error: Couldn't find patch file: '{s}'\n", .{path}) catch {},
            error.EmptyPatchFile => manager.stderr.print("error: patchfile '{s}' is empty, please restore or delete it.\n", .{path}) catch {},
            error.InvalidPatchFile => manager.stderr.print("error: failed to parse patchfile ({s})\n", .{path}) catch {},
            error.PatchApplyFailed => manager.stderr.print("error: failed to apply patchfile ({s})\n", .{path}) catch {},
            else => manager.stderr.print("error: failed to apply patchfile ({s}): {s}\n", .{ path, @errorName(err) }) catch {},
        }
        return error.PackageManagerErrorReported;
    }

    fn defaultTarballURL(manager: *Manager, name: []const u8, version_value: []const u8) ![]const u8 {
        const encoded_name = try encodePackageName(manager.allocator, name);
        const basename = if (std.mem.lastIndexOfScalar(u8, name, '/')) |slash| name[slash + 1 ..] else name;
        return std.fmt.allocPrint(manager.allocator, "{s}{s}/-/{s}-{s}.tgz", .{
            manager.registry,
            encoded_name,
            basename,
            version_value,
        });
    }

    fn lockKeyForDestination(manager: *Manager, destination: []const u8) ![]const u8 {
        if (!pathHasPrefix(destination, manager.root_dir)) return error.PackageOutsideInstallRoot;
        var output: std.Io.Writer.Allocating = .init(manager.allocator);
        var components = std.mem.tokenizeAny(u8, destination[manager.root_dir.len..], "/\\");
        while (components.next()) |component| {
            if (std.mem.eql(u8, component, "node_modules")) continue;
            if (output.written().len > 0) try output.writer.writeByte('/');
            try output.writer.writeAll(component);
        }
        if (output.written().len == 0) return error.InvalidPackageDestination;
        return output.toOwnedSlice();
    }

    fn dependencyLockKey(manager: *Manager, parent_dir: []const u8, alias: []const u8) ![]const u8 {
        if (manager.node_linker != .isolated) {
            const destination = try packageDestination(manager.allocator, parent_dir, alias);
            return manager.lockKeyForDestination(destination);
        }
        if (std.mem.eql(u8, parent_dir, manager.root_dir)) return manager.allocator.dupe(u8, alias);
        if (manager.isolated_parent_keys.get(parent_dir)) |parent_key| {
            return std.fmt.allocPrint(manager.allocator, "{s}/{s}", .{ parent_key, alias });
        }
        var workspaces = manager.workspaces.iterator();
        while (workspaces.next()) |entry| {
            const workspace = entry.value_ptr.*;
            if (!std.mem.eql(u8, parent_dir, workspace.path)) continue;
            return std.fmt.allocPrint(manager.allocator, "{s}/{s}", .{
                try manager.relativeLockPath(workspace.path),
                alias,
            });
        }
        const destination = try packageDestination(manager.allocator, parent_dir, alias);
        return manager.lockKeyForDestination(destination);
    }

    fn rememberPackageMetadata(manager: *Manager, package_dir: []const u8, metadata: ?*const Value) !void {
        if (manager.node_linker != .isolated) return;
        const value = metadata orelse return;
        try manager.isolated_package_metadata.put(try manager.allocator.dupe(u8, package_dir), value);
    }

    fn peerContextForPackage(
        manager: *Manager,
        metadata: ?*const Value,
        parent_dir: []const u8,
        install_missing: bool,
    ) anyerror!Isolated.PeerContext {
        if (manager.node_linker != .isolated or manager.options.omit_peer) return .{};
        const package_json = metadata orelse return .{};
        if (package_json.* != .object) return .{};
        const peers = package_json.object.get("peerDependencies") orelse return .{};
        if (peers != .object) return .{};

        var resolutions = std.array_list.Managed(Isolated.PeerResolution).init(manager.allocator);
        for (peers.object.keys(), peers.object.values()) |alias, range_value| {
            if (range_value != .string or packageHasRuntimeDependency(package_json, alias)) continue;
            const optional = peerDependencyIsOptional(package_json, alias);
            var provider = try manager.findPeerProviderExact(alias, range_value.string, parent_dir);

            if (provider == null and install_missing) {
                const candidate = try manager.findPeerCandidate(alias, parent_dir);
                if (!optional or candidate != null) {
                    const requested = candidate orelse PeerCandidate{
                        .spec = range_value.string,
                        .parent_dir = parent_dir,
                        .direct = std.mem.eql(u8, parent_dir, manager.root_dir),
                    };
                    _ = manager.installDependency(
                        alias,
                        requested.spec,
                        requested.parent_dir,
                        requested.direct,
                        optional,
                    ) catch |err| {
                        if (!optional) return err;
                    };
                }
            }
            if (provider == null) provider = try manager.findPeerProvider(alias, range_value.string, parent_dir);

            if (provider) |resolved| {
                try resolutions.append(.{
                    .name = resolved.record.name,
                    .resolution = resolved.resolution,
                });
            } else if (!install_missing) {
                if (try manager.findLockedPeerResolution(alias, range_value.string, parent_dir)) |locked| {
                    try resolutions.append(locked);
                } else if (try manager.findPeerCandidate(alias, parent_dir)) |candidate| {
                    if (try manager.findLockedPeerResolution(alias, range_value.string, candidate.parent_dir)) |locked| {
                        try resolutions.append(locked);
                    }
                }
            }
        }
        return Isolated.PeerContext.init(manager.allocator, resolutions.items);
    }

    fn findPeerProvider(
        manager: *Manager,
        alias: []const u8,
        range: []const u8,
        parent_dir: []const u8,
    ) !?PeerProvider {
        if (try manager.findPeerProviderExact(alias, range, parent_dir)) |provider| return provider;
        for (manager.records.items) |record| {
            const record_key = if (record.key.len > 0) record.key else record.alias;
            if (!std.mem.eql(u8, record.alias, alias) or !std.mem.eql(u8, record_key, alias)) continue;
            const provider: PeerProvider = try manager.peerProviderFromRecord(record);
            return provider;
        }
        for (manager.records.items) |record| {
            if (!std.mem.eql(u8, record.alias, alias) or !manager.peerProviderSatisfies(record, range)) continue;
            const provider: PeerProvider = try manager.peerProviderFromRecord(record);
            return provider;
        }
        for (manager.records.items) |record| {
            if (!std.mem.eql(u8, record.alias, alias)) continue;
            const provider: PeerProvider = try manager.peerProviderFromRecord(record);
            return provider;
        }
        return null;
    }

    fn findPeerProviderExact(
        manager: *Manager,
        alias: []const u8,
        range: []const u8,
        parent_dir: []const u8,
    ) !?PeerProvider {
        _ = range;
        const exact_key = try manager.dependencyLockKey(parent_dir, alias);
        for (manager.records.items) |record| {
            const record_key = if (record.key.len > 0) record.key else record.alias;
            if (!std.mem.eql(u8, record.alias, alias) or !std.mem.eql(u8, record_key, exact_key)) continue;
            const provider: PeerProvider = try manager.peerProviderFromRecord(record);
            return provider;
        }
        return null;
    }

    fn peerProviderSatisfies(manager: *Manager, record: PackageRecord, range: []const u8) bool {
        return semverSatisfies(manager.allocator, range, record.version);
    }

    fn peerProviderFromRecord(manager: *Manager, record: PackageRecord) !PeerProvider {
        const destination = if (record.install_dir.len > 0)
            record.install_dir
        else if (record.kind == .workspace)
            record.local_path
        else blk: {
            const source = if (record.tarball.len > 0) record.tarball else record.resolution;
            const placement = try manager.packagePlacementWithPeerContext(
                record.name,
                record.version,
                record.kind,
                source,
                .{ .hash = record.peer_hash },
            );
            try manager.trackIsolatedPlacement(placement);
            break :blk placement.package_dir;
        };
        return .{
            .record = record,
            .destination = destination,
            .resolution = try manager.peerResolutionForRecord(record),
        };
    }

    fn peerResolutionForRecord(manager: *Manager, record: PackageRecord) ![]const u8 {
        return switch (record.kind) {
            .npm => manager.allocator.dupe(u8, record.version),
            .workspace => std.fmt.allocPrint(manager.allocator, "workspace:{s}", .{
                try manager.relativeLockPath(record.local_path),
            }),
            .folder => std.fmt.allocPrint(manager.allocator, "file:{s}", .{
                try manager.relativeLockPath(record.local_path),
            }),
            .symlink => std.fmt.allocPrint(manager.allocator, "link:{s}", .{
                try manager.relativeLockPath(record.local_path),
            }),
            else => manager.allocator.dupe(u8, if (record.resolution.len > 0) record.resolution else record.tarball),
        };
    }

    fn findLockedPeerResolution(
        manager: *Manager,
        alias: []const u8,
        range: []const u8,
        parent_dir: []const u8,
    ) !?Isolated.PeerResolution {
        const graph = if (manager.lock_graph) |*value| value else return null;
        const logical_key = try manager.dependencyLockKey(parent_dir, alias);
        const package = graph.get(logical_key) orelse graph.get(alias) orelse return null;
        _ = range;
        const resolution = switch (package.kind) {
            .npm => package.version,
            .workspace => try std.fmt.allocPrint(manager.allocator, "workspace:{s}", .{package.source}),
            .folder => try std.fmt.allocPrint(manager.allocator, "file:{s}", .{package.source}),
            .symlink => try std.fmt.allocPrint(manager.allocator, "link:{s}", .{package.source}),
            else => package.source,
        };
        return .{ .name = package.name, .resolution = resolution };
    }

    fn findPeerCandidate(manager: *Manager, alias: []const u8, parent_dir: []const u8) !?PeerCandidate {
        if (manager.isolated_package_metadata.get(parent_dir)) |metadata| {
            const spec = if (manager.isWorkspaceDirectory(parent_dir))
                ownedDependencySpec(metadata, alias)
            else
                runtimeDependencySpec(metadata, alias);
            if (spec) |value| {
                return .{ .spec = value, .parent_dir = parent_dir, .direct = false };
            }
        }
        if (manager.root_package_json) |root| {
            if (ownedDependencySpec(root, alias)) |spec| {
                return .{ .spec = spec, .parent_dir = manager.root_dir, .direct = true };
            }
        }

        var candidates = std.array_list.Managed(Workspace).init(manager.allocator);
        var workspaces = manager.workspaces.iterator();
        while (workspaces.next()) |entry| try candidates.append(entry.value_ptr.*);
        std.sort.pdq(Workspace, candidates.items, {}, struct {
            fn lessThan(_: void, left: Workspace, right: Workspace) bool {
                return std.mem.order(u8, left.path, right.path) == .lt;
            }
        }.lessThan);
        for (candidates.items) |workspace| {
            if (ownedDependencySpec(workspace.package_json, alias)) |spec| {
                return .{ .spec = spec, .parent_dir = workspace.path, .direct = false };
            }
        }
        return null;
    }

    fn isWorkspaceDirectory(manager: *Manager, path: []const u8) bool {
        var workspaces = manager.workspaces.iterator();
        while (workspaces.next()) |entry| {
            if (std.mem.eql(u8, entry.value_ptr.path, path)) return true;
        }
        return false;
    }

    fn linkPeerDependencies(
        manager: *Manager,
        metadata: ?*const Value,
        package_dir: []const u8,
        parent_dir: []const u8,
    ) !void {
        if (manager.node_linker != .isolated or manager.options.omit_peer or
            manager.options.lockfile_only or manager.options.dry_run) return;
        const package_json = metadata orelse return;
        if (package_json.* != .object) return;
        const peers = package_json.object.get("peerDependencies") orelse return;
        if (peers != .object) return;
        const modules_dir = try manager.isolatedConsumerModules(package_dir);
        for (peers.object.keys(), peers.object.values()) |alias, range_value| {
            if (range_value != .string or packageHasRuntimeDependency(package_json, alias)) continue;
            const provider = try manager.findPeerProvider(alias, range_value.string, parent_dir) orelse continue;
            const destination = try std.fs.path.join(manager.allocator, &.{ modules_dir, alias });
            if (!std.mem.eql(u8, destination, provider.destination)) {
                try manager.linkRelativeDirectory(destination, provider.destination, true);
            }
        }
    }

    fn installOrLinkPeerDependencies(
        manager: *Manager,
        metadata: ?*const Value,
        dependency_parent_dir: []const u8,
        package_dir: []const u8,
        peer_parent_dir: []const u8,
    ) !void {
        if (manager.options.omit_peer) return;
        if (manager.node_linker == .isolated) {
            return manager.linkPeerDependencies(metadata, package_dir, peer_parent_dir);
        }
        const package_json = metadata orelse return;
        try manager.installDependencyObject(@constCast(package_json), "peerDependencies", dependency_parent_dir, false, true);
    }

    fn packagePlacement(
        manager: *Manager,
        name: []const u8,
        version_value: []const u8,
        kind: Lockfile.Kind,
        source: []const u8,
    ) !Isolated.Placement {
        return manager.packagePlacementWithPeerContext(name, version_value, kind, source, .{});
    }

    fn packagePlacementWithPeerContext(
        manager: *Manager,
        name: []const u8,
        version_value: []const u8,
        kind: Lockfile.Kind,
        source: []const u8,
        peer_context: Isolated.PeerContext,
    ) !Isolated.Placement {
        const placement = try Isolated.placementWithPeerContext(
            manager.allocator,
            manager.root_dir,
            name,
            version_value,
            kind,
            source,
            peer_context,
        );
        return placement;
    }

    fn trackIsolatedPlacement(manager: *Manager, placement: Isolated.Placement) !void {
        if (manager.node_linker != .isolated) return;
        try manager.isolated_live_store_keys.put(try manager.allocator.dupe(u8, placement.store_key), {});
        try manager.isolated_managed_modules.put(try manager.allocator.dupe(u8, placement.modules_dir), {});
    }

    fn packagePlacementFromLock(
        manager: *Manager,
        package: *const Lockfile.Package,
        peer_context: Isolated.PeerContext,
    ) !Isolated.Placement {
        const version_value = if (package.version.len > 0)
            package.version
        else if (package.info) |info|
            jsonString(info, "version") orelse "0.0.0"
        else
            "0.0.0";
        return manager.packagePlacementWithPeerContext(
            package.name,
            version_value,
            package.kind,
            package.source,
            peer_context,
        );
    }

    fn packageInstallDestination(
        manager: *Manager,
        alias: []const u8,
        name: []const u8,
        version_value: []const u8,
        kind: Lockfile.Kind,
        source: []const u8,
        parent_dir: []const u8,
        direct: bool,
    ) ![]const u8 {
        return manager.packageInstallDestinationWithPeerContext(
            alias,
            name,
            version_value,
            kind,
            source,
            parent_dir,
            direct,
            .{},
        );
    }

    fn packageInstallDestinationWithPeerContext(
        manager: *Manager,
        alias: []const u8,
        name: []const u8,
        version_value: []const u8,
        kind: Lockfile.Kind,
        source: []const u8,
        parent_dir: []const u8,
        direct: bool,
        peer_context: Isolated.PeerContext,
    ) ![]const u8 {
        if (manager.node_linker != .isolated) return manager.chooseDestination(alias, version_value, parent_dir, direct);
        const placement = try manager.packagePlacementWithPeerContext(name, version_value, kind, source, peer_context);
        try manager.trackIsolatedPlacement(placement);
        const key = try manager.dependencyLockKey(parent_dir, alias);
        try manager.rememberIsolatedParent(placement, key);
        return placement.package_dir;
    }

    fn rememberIsolatedParent(manager: *Manager, placement: Isolated.Placement, logical_key: []const u8) !void {
        if (!manager.isolated_parent_modules.contains(placement.package_dir)) {
            try manager.isolated_parent_modules.put(
                try manager.allocator.dupe(u8, placement.package_dir),
                try manager.allocator.dupe(u8, placement.modules_dir),
            );
        }
        if (!manager.isolated_parent_keys.contains(placement.package_dir)) {
            try manager.isolated_parent_keys.put(
                try manager.allocator.dupe(u8, placement.package_dir),
                try manager.allocator.dupe(u8, logical_key),
            );
        }
    }

    fn rememberIsolatedSourceParent(manager: *Manager, source_dir: []const u8, package_dir: []const u8) !void {
        if (manager.node_linker != .isolated or std.mem.eql(u8, source_dir, package_dir)) return;
        if (manager.isolated_parent_modules.get(package_dir)) |modules| {
            if (!manager.isolated_parent_modules.contains(source_dir)) {
                try manager.isolated_parent_modules.put(
                    try manager.allocator.dupe(u8, source_dir),
                    try manager.allocator.dupe(u8, modules),
                );
            }
        }
        if (manager.isolated_parent_keys.get(package_dir)) |parent_key| {
            if (!manager.isolated_parent_keys.contains(source_dir)) {
                try manager.isolated_parent_keys.put(
                    try manager.allocator.dupe(u8, source_dir),
                    try manager.allocator.dupe(u8, parent_key),
                );
            }
        }
    }

    fn isolatedConsumerModules(manager: *Manager, parent_dir: []const u8) ![]const u8 {
        const modules = if (manager.isolated_parent_modules.get(parent_dir)) |known|
            known
        else
            try std.fs.path.join(manager.allocator, &.{ parent_dir, "node_modules" });
        if (manager.node_linker == .isolated) {
            try manager.isolated_managed_modules.put(try manager.allocator.dupe(u8, modules), {});
        }
        return modules;
    }

    fn ensureIsolatedLinks(
        manager: *Manager,
        alias: []const u8,
        parent_dir: []const u8,
        package_dir: []const u8,
    ) !void {
        if (manager.node_linker != .isolated or manager.options.lockfile_only or manager.options.dry_run) return;
        const consumer_modules = try manager.isolatedConsumerModules(parent_dir);
        const edge = try std.fs.path.join(manager.allocator, &.{ consumer_modules, alias });
        if (!std.mem.eql(u8, edge, package_dir)) try manager.linkRelativeDirectory(edge, package_dir, true);

        const hidden_matches = if (manager.hidden_hoist_pattern) |pattern|
            pattern.isMatch(alias)
        else
            true;
        if (hidden_matches) {
            const hidden_entry = try manager.isolated_hidden_hoists.getOrPut(alias);
            if (!hidden_entry.found_existing) {
                const hidden_modules = try std.fs.path.join(manager.allocator, &.{ manager.root_dir, "node_modules", ".bun", "node_modules" });
                try manager.isolated_managed_modules.put(try manager.allocator.dupe(u8, hidden_modules), {});
                const hoist = try std.fs.path.join(manager.allocator, &.{ hidden_modules, alias });
                try manager.linkRelativeDirectory(hoist, package_dir, true);
            }
        }

        const public_entry = try manager.isolated_public_hoists.getOrPut(alias);
        if (std.mem.eql(u8, parent_dir, manager.root_dir)) {
            // Direct dependencies always win at the public root, irrespective
            // of publicHoistPattern and traversal order.
            public_entry.value_ptr.* = {};
        } else if (!public_entry.found_existing) {
            if (manager.public_hoist_pattern) |pattern| {
                if (pattern.isMatch(alias)) {
                    const root_modules = try manager.isolatedConsumerModules(manager.root_dir);
                    const public_link = try std.fs.path.join(manager.allocator, &.{ root_modules, alias });
                    try manager.linkRelativeDirectory(public_link, package_dir, true);
                } else {
                    _ = manager.isolated_public_hoists.remove(alias);
                }
            } else {
                _ = manager.isolated_public_hoists.remove(alias);
            }
        }
    }

    fn linkRelativeDirectory(manager: *Manager, destination: []const u8, target: []const u8, replace: bool) !void {
        if (manager.node_linker == .isolated) {
            try manager.isolated_live_links.put(try manager.allocator.dupe(u8, destination), {});
        }
        if (replace) deletePath(manager.init_data.io, destination);
        if (std.fs.path.dirname(destination)) |parent| {
            try std.Io.Dir.cwd().createDirPath(manager.init_data.io, parent);
            const relative = try std.fs.path.relative(
                manager.allocator,
                manager.root_dir,
                manager.init_data.environ_map,
                parent,
                target,
            );
            std.Io.Dir.cwd().symLink(manager.init_data.io, relative, destination, .{ .is_directory = true }) catch |err| {
                if (builtin.os.tag != .windows) return err;
                try std.Io.Dir.symLinkAbsolute(manager.init_data.io, target, destination, .{ .is_directory = true });
            };
        }
    }

    fn installGit(
        manager: *Manager,
        alias_hint: ?[]const u8,
        requested: []const u8,
        parent_dir: []const u8,
        direct: bool,
        optional: bool,
        locked_selection: ?LockedSelection,
        protocol_patch_paths: []const []const u8,
    ) !GitPackage {
        const spec = (try Git.parse(manager.allocator, requested)) orelse return error.InvalidGitDependency;
        const destination = if (locked_selection) |selection|
            selection.destination
        else if (alias_hint) |alias|
            if (manager.node_linker == .isolated)
                ""
            else
                try manager.chooseDestination(alias, "0.0.0", parent_dir, direct)
        else
            "";

        var metadata: *Value = undefined;
        var package_name: []const u8 = alias_hint orelse "";
        var package_version: []const u8 = "0.0.0";
        var resolved_source: []const u8 = requested;
        var commit: []const u8 = spec.committish;
        var final_destination = destination;
        var peer_context = if (locked_selection) |selection| selection.peer_context else Isolated.PeerContext{};
        var installed = false;

        if (locked_selection != null and !manager.options.force and destination.len > 0) {
            const package_json_path = try std.fs.path.join(manager.allocator, &.{ destination, "package.json" });
            if (manager.pathExists(package_json_path)) {
                metadata = try manager.readInstalledPackageJSON(destination);
                package_name = jsonString(metadata, "name") orelse alias_hint orelse locked_selection.?.package.name;
                package_version = jsonString(metadata, "version") orelse locked_selection.?.package.version;
                resolved_source = locked_selection.?.package.source;
                const locked_spec = (try Git.parse(manager.allocator, resolved_source)).?;
                commit = locked_spec.committish;
                const patch_paths = try manager.packagePatchPaths(package_name, package_version, protocol_patch_paths);
                installed = try manager.packagePatchStateMatches(destination, patch_paths);
            }
        }

        if (!installed) {
            const cache_dir = try packageCachePath(manager.init_data, manager.allocator);
            try std.Io.Dir.cwd().createDirPath(manager.init_data.io, cache_dir);
            const checkout_path = try std.fmt.allocPrint(manager.allocator, "{s}{c}cottontail-git-{x}-{d}", .{
                cache_dir,
                std.fs.path.sep,
                std.hash.Wyhash.hash(0, requested),
                manager.records.items.len,
            });
            const checkout = Git.checkout(
                manager.allocator,
                manager.init_data.io,
                manager.init_data.environ_map,
                spec,
                checkout_path,
            ) catch |err| {
                try manager.stderr.print("error: git dependency {s} failed to resolve\n", .{requested});
                return err;
            };
            defer deletePath(manager.init_data.io, checkout.path);

            metadata = manager.readInstalledPackageJSON(checkout.path) catch |err| blk: {
                if (err != error.MissingPackageJSON) return err;
                const empty = try manager.allocator.create(Value);
                empty.* = .{ .object = .empty };
                break :blk empty;
            };
            package_name = jsonString(metadata, "name") orelse alias_hint orelse return error.InvalidPackageName;
            package_version = jsonString(metadata, "version") orelse "0.0.0";
            const alias = alias_hint orelse package_name;
            commit = checkout.commit;
            resolved_source = try spec.resolvedSource(manager.allocator, commit);
            if (locked_selection == null) {
                peer_context = try manager.peerContextForPackage(metadata, parent_dir, true);
            } else {
                _ = try manager.peerContextForPackage(metadata, parent_dir, true);
            }
            final_destination = if (locked_selection) |selection|
                selection.destination
            else
                try manager.packageInstallDestinationWithPeerContext(
                    alias,
                    package_name,
                    package_version,
                    if (spec.kind == .github) .github else .git,
                    resolved_source,
                    parent_dir,
                    direct,
                    peer_context,
                );

            if (!manager.options.lockfile_only and !manager.options.dry_run) {
                deletePath(manager.init_data.io, final_destination);
                try copyDirectoryTree(manager.init_data.io, manager.allocator, checkout.path, final_destination);
                try manager.applyPackagePatch(package_name, package_version, final_destination, protocol_patch_paths);
            }
            manager.installed_count += 1;
        }

        if (installed) _ = try manager.peerContextForPackage(metadata, parent_dir, true);

        const alias = alias_hint orelse package_name;
        if (!manager.options.lockfile_only and !manager.options.dry_run) {
            try manager.ensureIsolatedLinks(alias, parent_dir, final_destination);
            const bin_metadata = (try manager.metadataForInstalledPackage(final_destination, metadata)).?;
            try manager.linkBins(alias, final_destination, bin_metadata, direct, parent_dir);
        }
        try manager.root_versions.put(try manager.allocator.dupe(u8, alias), package_version);
        try manager.addRecord(.{
            .key = if (locked_selection) |selection|
                selection.package.key
            else if (manager.node_linker == .isolated)
                try manager.dependencyLockKey(parent_dir, alias)
            else
                try manager.lockKeyForDestination(final_destination),
            .alias = alias,
            .name = package_name,
            .version = package_version,
            .integrity = commit,
            .resolution = resolved_source,
            .kind = if (spec.kind == .github) .github else .git,
            .metadata = metadata,
            .peer_hash = peer_context.hash,
            .install_dir = final_destination,
        });
        try manager.rememberPackageMetadata(final_destination, metadata);
        if (locked_selection == null) manager.changed = true;

        try manager.installDependencyObject(metadata, "dependencies", final_destination, false, false);
        if (!manager.options.omit_optional) {
            try manager.installDependencyObject(metadata, "optionalDependencies", final_destination, false, true);
        }
        try manager.installOrLinkPeerDependencies(metadata, final_destination, final_destination, parent_dir);
        try manager.queuePackageScripts(alias, package_version, final_destination, .git, optional, !installed);
        return .{
            .alias = alias,
            .name = package_name,
            .version = package_version,
            .source = resolved_source,
            .package_json = metadata,
        };
    }

    fn readInstalledPackageJSON(manager: *Manager, package_dir: []const u8) !*Value {
        const package_json_path = try std.fs.path.join(manager.allocator, &.{ package_dir, "package.json" });
        const source = std.Io.Dir.cwd().readFileAlloc(
            manager.init_data.io,
            package_json_path,
            manager.allocator,
            .limited(16 * 1024 * 1024),
        ) catch return error.MissingPackageJSON;
        const package_json = try manager.allocator.create(Value);
        package_json.* = try std.json.parseFromSliceLeaky(Value, manager.allocator, source, .{});
        if (package_json.* != .object) return error.InvalidPackageJSON;
        return package_json;
    }

    fn metadataForInstalledPackage(
        manager: *Manager,
        package_dir: []const u8,
        fallback: ?*const Value,
    ) !?*const Value {
        const installed = manager.readInstalledPackageJSON(package_dir) catch return fallback;
        return installed;
    }

    fn installTarball(
        manager: *Manager,
        alias_hint: ?[]const u8,
        spec: []const u8,
        parent_dir: []const u8,
        direct: bool,
        optional: bool,
        protocol_patch_paths: []const []const u8,
    ) !TarballPackage {
        const archive = if (isRemoteTarballSpec(spec))
            try manager.fetchBytes(spec, false, max_tarball_bytes)
        else blk: {
            const tarball_path = try absolutePathFrom(
                manager.allocator,
                parent_dir,
                localSpecPath(spec),
            );
            break :blk try std.Io.Dir.cwd().readFileAlloc(
                manager.init_data.io,
                tarball_path,
                manager.allocator,
                .limited(max_tarball_bytes),
            );
        };
        const metadata = try manager.readTarballPackageJSON(archive);
        const package_name = jsonString(metadata, "name") orelse return error.InvalidPackageName;
        const package_version = jsonString(metadata, "version") orelse "0.0.0";
        const alias = alias_hint orelse package_name;
        const package_kind: Lockfile.Kind = if (isRemoteTarballSpec(spec)) .remote_tarball else .local_tarball;
        const peer_context = try manager.peerContextForPackage(metadata, parent_dir, true);
        const destination = try manager.packageInstallDestinationWithPeerContext(
            alias,
            package_name,
            package_version,
            package_kind,
            spec,
            parent_dir,
            direct,
            peer_context,
        );

        if (!manager.options.lockfile_only and !manager.options.dry_run) {
            deletePath(manager.init_data.io, destination);
            try std.Io.Dir.cwd().createDirPath(manager.init_data.io, destination);
            var destination_dir = try std.Io.Dir.cwd().openDir(manager.init_data.io, destination, .{});
            defer destination_dir.close(manager.init_data.io);
            try extractTarballArchive(manager.init_data.io, manager.allocator, destination_dir, archive);
            try manager.applyPackagePatch(package_name, package_version, destination, protocol_patch_paths);
            try manager.ensureIsolatedLinks(alias, parent_dir, destination);
            const bin_metadata = (try manager.metadataForInstalledPackage(destination, metadata)).?;
            try manager.linkBins(alias, destination, bin_metadata, direct, parent_dir);
        }

        try manager.root_versions.put(try manager.allocator.dupe(u8, alias), package_version);
        try manager.addRecord(.{
            .key = if (manager.node_linker == .isolated)
                try manager.dependencyLockKey(parent_dir, alias)
            else
                try manager.lockKeyForDestination(destination),
            .alias = alias,
            .name = package_name,
            .version = package_version,
            .tarball = spec,
            .integrity = try sha512Integrity(manager.allocator, archive),
            .resolution = if (isRemoteTarballSpec(spec)) spec else localSpecPath(spec),
            .kind = package_kind,
            .metadata = metadata,
            .peer_hash = peer_context.hash,
            .install_dir = destination,
        });
        try manager.rememberPackageMetadata(destination, metadata);
        manager.installed_count += 1;
        manager.changed = true;

        try manager.installDependencyObject(metadata, "dependencies", destination, false, false);
        if (!manager.options.omit_optional) {
            try manager.installDependencyObject(metadata, "optionalDependencies", destination, false, true);
        }
        try manager.installOrLinkPeerDependencies(metadata, destination, destination, parent_dir);
        try manager.queuePackageScripts(package_name, package_version, destination, .local, optional, true);
        return .{
            .alias = alias,
            .name = package_name,
            .version = package_version,
            .package_json = metadata,
        };
    }

    fn readTarballPackageJSON(manager: *Manager, archive: []const u8) !*Value {
        var compressed_reader: std.Io.Reader = .fixed(archive);
        var decompression_buffer: [std.compress.flate.max_window_len]u8 = undefined;
        var decompressor: std.compress.flate.Decompress = .init(&compressed_reader, .gzip, &decompression_buffer);
        var file_name_buffer: [std.fs.max_path_bytes]u8 = undefined;
        var link_name_buffer: [std.fs.max_path_bytes]u8 = undefined;
        var iterator: std.tar.Iterator = .init(&decompressor.reader, .{
            .file_name_buffer = &file_name_buffer,
            .link_name_buffer = &link_name_buffer,
        });
        while (try iterator.next()) |entry| {
            if (entry.kind != .file or !std.mem.eql(u8, std.fs.path.basename(entry.name), "package.json")) continue;
            if (entry.size > 16 * 1024 * 1024) return error.PackageJSONTooLarge;
            var contents: std.Io.Writer.Allocating = .init(manager.allocator);
            try iterator.streamRemaining(entry, &contents.writer);
            const package_json = try manager.allocator.create(Value);
            package_json.* = try std.json.parseFromSliceLeaky(Value, manager.allocator, contents.written(), .{});
            if (package_json.* != .object) return error.InvalidPackageJSON;
            return package_json;
        }
        return error.MissingPackageJSON;
    }

    fn chooseDestination(
        manager: *Manager,
        alias: []const u8,
        version_value: []const u8,
        parent_dir: []const u8,
        direct: bool,
    ) ![]const u8 {
        if (!direct) {
            if (manager.rootDependencySpec(alias)) |root_spec| {
                const effective = manager.manifest_policy.?.resolveDependency(alias, root_spec, false) catch root_spec;
                const unwrapped = if (try Patch.Spec.parseProtocol(manager.allocator, alias, effective)) |protocol|
                    protocol.base_spec
                else
                    effective;
                if (!isGitSpec(unwrapped) and !isTarballSpec(unwrapped) and !isLocalSpec(unwrapped) and
                    !std.mem.startsWith(u8, unwrapped, "workspace:"))
                {
                    const root_npm = parseNpmAlias(alias, unwrapped);
                    if (!semverSatisfies(manager.allocator, root_npm[1], version_value)) {
                        return packageDestination(manager.allocator, parent_dir, alias);
                    }
                }
            }
        }
        if (direct or manager.root_versions.get(alias) == null) {
            return packageDestination(manager.allocator, manager.root_dir, alias);
        }
        if (manager.root_versions.get(alias)) |existing| {
            if (std.mem.eql(u8, existing, version_value)) return packageDestination(manager.allocator, manager.root_dir, alias);
        }
        return packageDestination(manager.allocator, parent_dir, alias);
    }

    fn rootDependencySpec(manager: *Manager, alias: []const u8) ?[]const u8 {
        const root = manager.root_package_json orelse return null;
        if (root.* != .object) return null;
        for (all_dependency_sections) |section_name| {
            const section = root.object.get(section_name) orelse continue;
            if (section != .object) continue;
            const value = section.object.get(alias) orelse continue;
            if (value == .string) return value.string;
        }
        return null;
    }

    fn findInstalledVersion(
        manager: *Manager,
        alias: []const u8,
        spec: []const u8,
        parent_dir: []const u8,
        direct: bool,
        protocol_patch_paths: []const []const u8,
    ) !?[]const u8 {
        if (manager.node_linker == .isolated) {
            const registry_name, const registry_spec = parseNpmAlias(alias, spec);
            for (manager.records.items) |record| {
                if (record.kind != .npm or
                    !std.mem.eql(u8, record.name, registry_name) or
                    !semverSatisfies(manager.allocator, registry_spec, record.version)) continue;
                const peer_context = try manager.peerContextForPackage(record.metadata, parent_dir, false);
                if (peer_context.hash != record.peer_hash) continue;
                const placement = try manager.packagePlacementWithPeerContext(
                    record.name,
                    record.version,
                    record.kind,
                    record.tarball,
                    peer_context,
                );
                const patch_paths = try manager.packagePatchPaths(record.name, record.version, protocol_patch_paths);
                if (!try manager.packagePatchStateMatches(placement.package_dir, patch_paths)) continue;
                try manager.trackIsolatedPlacement(placement);
                const logical_key = try manager.dependencyLockKey(parent_dir, alias);
                try manager.rememberIsolatedParent(placement, logical_key);
                try manager.ensureIsolatedLinks(alias, parent_dir, placement.package_dir);
                if (!manager.options.lockfile_only and !manager.options.dry_run) {
                    if (try manager.metadataForInstalledPackage(placement.package_dir, record.metadata)) |metadata| {
                        try manager.linkBins(alias, placement.package_dir, metadata, direct, parent_dir);
                    }
                }
                try manager.root_versions.put(try manager.allocator.dupe(u8, alias), record.version);
                try manager.addRecord(.{
                    .key = logical_key,
                    .alias = alias,
                    .name = record.name,
                    .version = record.version,
                    .tarball = record.tarball,
                    .integrity = record.integrity,
                    .local_path = record.local_path,
                    .resolution = record.resolution,
                    .kind = record.kind,
                    .metadata = record.metadata,
                    .peer_hash = record.peer_hash,
                    .install_dir = placement.package_dir,
                });
                try manager.rememberPackageMetadata(placement.package_dir, record.metadata);
                try manager.linkPeerDependencies(record.metadata, placement.package_dir, parent_dir);
                return record.version;
            }
            return null;
        }
        const candidates = [_][]const u8{ parent_dir, manager.root_dir };
        for (candidates) |base| {
            const destination = try packageDestination(manager.allocator, base, alias);
            const package_json = try std.fs.path.join(manager.allocator, &.{ destination, "package.json" });
            const source = std.Io.Dir.cwd().readFileAlloc(
                manager.init_data.io,
                package_json,
                manager.allocator,
                .limited(4 * 1024 * 1024),
            ) catch continue;
            const value = try manager.allocator.create(Value);
            value.* = std.json.parseFromSliceLeaky(Value, manager.allocator, source, .{}) catch continue;
            if (value.* != .object) continue;
            const version_value = value.object.get("version") orelse continue;
            if (version_value != .string) continue;
            if (semverSatisfies(manager.allocator, spec, version_value.string)) {
                const package_name = jsonString(value, "name") orelse alias;
                const patch_paths = try manager.packagePatchPaths(package_name, version_value.string, protocol_patch_paths);
                if (!try manager.packagePatchStateMatches(destination, patch_paths)) continue;
                try manager.root_versions.put(try manager.allocator.dupe(u8, alias), version_value.string);
                try manager.addRecord(.{
                    .key = try manager.lockKeyForDestination(destination),
                    .alias = alias,
                    .name = package_name,
                    .version = version_value.string,
                    .metadata = value,
                });
                return version_value.string;
            }
        }
        return null;
    }

    fn resolveRegistryPackage(manager: *Manager, name: []const u8, spec: []const u8) !RegistryPackage {
        const encoded_name = try encodePackageName(manager.allocator, name);
        const manifest_url = try std.fmt.allocPrint(manager.allocator, "{s}{s}", .{ manager.registry, encoded_name });
        const bytes = try manager.fetchBytes(manifest_url, true, max_manifest_bytes);
        const manifest = try std.json.parseFromSliceLeaky(Value, manager.allocator, bytes, .{});
        if (manifest != .object) return error.InvalidRegistryManifest;
        const versions_value = manifest.object.get("versions") orelse return error.PackageNotFound;
        if (versions_value != .object) return error.InvalidRegistryManifest;

        var selected_version: ?[]const u8 = null;
        if (versions_value.object.get(spec) != null) {
            selected_version = spec;
        } else if (manifest.object.get("dist-tags")) |dist_tags| {
            if (dist_tags == .object) {
                if (dist_tags.object.get(spec)) |tag_value| {
                    if (tag_value == .string) selected_version = tag_value.string;
                } else if (std.mem.eql(u8, spec, "") or std.mem.eql(u8, spec, "*")) {
                    if (dist_tags.object.get("latest")) |latest| if (latest == .string) {
                        selected_version = latest.string;
                    };
                } else if (dist_tags.object.get("latest")) |latest| {
                    if (latest == .string and semverSatisfies(manager.allocator, spec, latest.string)) {
                        selected_version = latest.string;
                    }
                }
            }
        }
        if (selected_version == null) selected_version = bestMatchingVersion(manager.allocator, &versions_value.object, spec);
        const version_value = selected_version orelse return error.NoMatchingVersion;
        const metadata = versions_value.object.getPtr(version_value) orelse return error.NoMatchingVersion;
        if (metadata.* != .object) return error.InvalidRegistryManifest;
        const dist = metadata.object.get("dist") orelse return error.InvalidRegistryManifest;
        if (dist != .object) return error.InvalidRegistryManifest;
        const tarball_value = dist.object.get("tarball") orelse return error.InvalidRegistryManifest;
        if (tarball_value != .string) return error.InvalidRegistryManifest;
        const integrity = if (dist.object.get("integrity")) |value|
            if (value == .string) value.string else null
        else
            null;
        return .{
            .name = if (metadata.object.get("name")) |value| if (value == .string) value.string else name else name,
            .version = version_value,
            .tarball = tarball_value.string,
            .integrity = integrity,
            .metadata = metadata,
        };
    }

    fn fetchBytes(manager: *Manager, url: []const u8, manifest: bool, limit: usize) ![]const u8 {
        var headers_buffer: [2]std.http.Header = undefined;
        var header_count: usize = 0;
        if (manifest) {
            headers_buffer[header_count] = .{ .name = "accept", .value = manifest_accept };
            header_count += 1;
        }
        if (manager.registry_authorization) |authorization| {
            if (std.mem.startsWith(u8, url, manager.registry)) {
                headers_buffer[header_count] = .{ .name = "authorization", .value = authorization };
                header_count += 1;
            }
        }
        const headers = headers_buffer[0..header_count];
        var attempt: usize = 0;
        while (attempt <= manager.max_retry_count) : (attempt += 1) {
            var output: std.Io.Writer.Allocating = .init(manager.allocator);
            const result = manager.client.fetch(.{
                .location = .{ .url = url },
                .response_writer = &output.writer,
                .extra_headers = headers,
            }) catch |err| {
                if (attempt == manager.max_retry_count) {
                    try manager.stderr.print("error: GET {s} - {s}\n", .{ url, @errorName(err) });
                    return error.PackageManagerErrorReported;
                }
                continue;
            };
            const status: u16 = @intFromEnum(result.status);
            if (status >= 200 and status < 300) {
                if (output.written().len > limit) return error.ResponseTooLarge;
                return try output.toOwnedSlice();
            }
            output.deinit();
            if (status < 500 or attempt == manager.max_retry_count) {
                try manager.stderr.print("error: GET {s} - {d}\n", .{ url, status });
                return error.PackageManagerErrorReported;
            }
        }
        unreachable;
    }

    const LocalPackage = struct {
        name: []const u8,
        version: []const u8,
        path: []const u8,
        package_json: *Value,
    };

    fn resolveLocalPackage(manager: *Manager, spec: []const u8, parent_dir: []const u8) !LocalPackage {
        const raw_path = localSpecPath(spec);
        const path = try absolutePathFrom(manager.allocator, parent_dir, raw_path);
        const package_json_path = try std.fs.path.join(manager.allocator, &.{ path, "package.json" });
        const source = std.Io.Dir.cwd().readFileAlloc(
            manager.init_data.io,
            package_json_path,
            manager.allocator,
            .limited(16 * 1024 * 1024),
        ) catch return error.MissingPackageJSON;
        const package_json = try manager.allocator.create(Value);
        package_json.* = try std.json.parseFromSliceLeaky(Value, manager.allocator, source, .{});
        if (package_json.* != .object) return error.InvalidPackageJSON;
        const name = jsonString(package_json, "name") orelse return error.InvalidPackageName;
        return .{
            .name = name,
            .version = jsonString(package_json, "version") orelse "0.0.0",
            .path = path,
            .package_json = package_json,
        };
    }

    fn normalizeLocalSpec(manager: *Manager, spec: []const u8, path: []const u8) ![]const u8 {
        const prefix = if (std.mem.startsWith(u8, spec, "link:")) "link:" else "file:";
        const relative = try std.fs.path.relative(
            manager.allocator,
            manager.root_dir,
            manager.init_data.environ_map,
            manager.root_dir,
            path,
        );
        const normalized = try manager.allocator.dupe(u8, relative);
        if (builtin.os.tag == .windows) std.mem.replaceScalar(u8, normalized, '\\', '/');
        return try std.fmt.allocPrint(manager.allocator, "{s}{s}", .{ prefix, normalized });
    }

    fn linkDirectory(manager: *Manager, alias: []const u8, target: []const u8) !void {
        const destination = try packageDestination(manager.allocator, manager.root_dir, alias);
        return manager.linkDirectoryAt(destination, target);
    }

    fn linkDirectoryAt(manager: *Manager, destination: []const u8, target: []const u8) !void {
        if (manager.options.dry_run) return;
        deletePath(manager.init_data.io, destination);
        if (std.fs.path.dirname(destination)) |parent| try std.Io.Dir.cwd().createDirPath(manager.init_data.io, parent);
        std.Io.Dir.symLinkAbsolute(manager.init_data.io, target, destination, .{ .is_directory = true }) catch |err| {
            if (builtin.os.tag != .windows) return err;
            try copyDirectoryTree(manager.init_data.io, manager.allocator, target, destination);
        };
    }

    fn linkBins(
        manager: *Manager,
        alias: []const u8,
        package_dir: []const u8,
        metadata: *const Value,
        report_direct: bool,
        parent_dir: []const u8,
    ) !void {
        if (metadata.* != .object) return;
        const bin_dir = if (manager.node_linker == .isolated)
            try std.fs.path.join(manager.allocator, &.{ try manager.isolatedConsumerModules(parent_dir), ".bin" })
        else
            try manager.binDirectoryForPackage(package_dir);
        if (metadata.object.get("bin")) |bin_value| {
            if (bin_value == .string) {
                const base_name = normalizedBinName(alias);
                if (try manager.linkBin(bin_dir, base_name, package_dir, bin_value.string)) {
                    if (report_direct) try manager.direct_bins.append(base_name);
                }
            } else if (bin_value == .object) {
                for (bin_value.object.keys(), bin_value.object.values()) |name, path_value| {
                    if (path_value == .string and try manager.linkBin(bin_dir, normalizedBinName(name), package_dir, path_value.string)) {
                        if (report_direct) try manager.direct_bins.append(normalizedBinName(name));
                    }
                }
            }
            return;
        }

        const directories = metadata.object.get("directories") orelse return;
        if (directories != .object) return;
        const directory_value = directories.object.get("bin") orelse return;
        if (directory_value != .string) return;
        const directory_path = try std.fs.path.join(manager.allocator, &.{ package_dir, directory_value.string });
        var directory = std.Io.Dir.cwd().openDir(manager.init_data.io, directory_path, .{ .iterate = true }) catch return;
        defer directory.close(manager.init_data.io);
        var iterator = directory.iterate();
        while (try iterator.next(manager.init_data.io)) |entry| {
            if (entry.kind != .file) continue;
            const relative_target = try std.fs.path.join(manager.allocator, &.{ directory_value.string, entry.name });
            if (try manager.linkBin(bin_dir, normalizedBinName(entry.name), package_dir, relative_target)) {
                if (report_direct) try manager.direct_bins.append(normalizedBinName(entry.name));
            }
        }
    }

    fn linkBin(manager: *Manager, bin_dir: []const u8, name: []const u8, package_dir: []const u8, relative_target: []const u8) !bool {
        const target = try std.fs.path.join(manager.allocator, &.{ package_dir, relative_target });
        const stat = std.Io.Dir.cwd().statFile(manager.init_data.io, target, .{}) catch return false;
        if (stat.kind != .file) return false;
        if (builtin.os.tag != .windows) try manager.preparePosixBin(target, stat);
        try std.Io.Dir.cwd().createDirPath(manager.init_data.io, bin_dir);
        const destination = try std.fs.path.join(manager.allocator, &.{ bin_dir, name });
        deletePath(manager.init_data.io, destination);
        if (builtin.os.tag == .windows) {
            const command_path = try std.fmt.allocPrint(manager.allocator, "{s}.cmd", .{destination});
            const executable = try std.process.executablePathAlloc(manager.init_data.io, manager.allocator);
            const command = try std.fmt.allocPrint(manager.allocator, "@\"{s}\" \"{s}\" %*\r\n", .{ executable, target });
            try std.Io.Dir.cwd().writeFile(manager.init_data.io, .{ .sub_path = command_path, .data = command });
        } else {
            const bin_target = try std.fs.path.relative(
                manager.allocator,
                manager.root_dir,
                manager.init_data.environ_map,
                bin_dir,
                target,
            );
            try std.Io.Dir.cwd().symLink(manager.init_data.io, bin_target, destination, .{});
        }
        return true;
    }

    fn binDirectoryForPackage(manager: *Manager, package_dir: []const u8) ![]const u8 {
        const marker = std.fs.path.sep_str ++ "node_modules" ++ std.fs.path.sep_str;
        const marker_index = std.mem.lastIndexOf(u8, package_dir, marker) orelse
            return std.fs.path.join(manager.allocator, &.{ manager.root_dir, "node_modules", ".bin" });
        const node_modules_end = marker_index + marker.len - std.fs.path.sep_str.len;
        return std.fs.path.join(manager.allocator, &.{ package_dir[0..node_modules_end], ".bin" });
    }

    fn preparePosixBin(manager: *Manager, target: []const u8, stat: std.Io.File.Stat) !void {
        const source = std.Io.Dir.cwd().readFileAlloc(
            manager.init_data.io,
            target,
            manager.allocator,
            .limited(64 * 1024 * 1024),
        ) catch return;
        const newline = std.mem.indexOfScalar(u8, source, '\n');
        if (source.len >= 3 and source[0] == '#' and source[1] == '!' and newline != null and newline.? > 0 and source[newline.? - 1] == '\r') {
            const normalized = try manager.allocator.alloc(u8, source.len - 1);
            @memcpy(normalized[0 .. newline.? - 1], source[0 .. newline.? - 1]);
            @memcpy(normalized[newline.? - 1 ..], source[newline.?..]);
            try std.Io.Dir.cwd().writeFile(manager.init_data.io, .{
                .sub_path = target,
                .data = normalized,
                .flags = .{ .permissions = stat.permissions },
            });
        }
        const executable_permissions: std.Io.File.Permissions = @enumFromInt(@intFromEnum(stat.permissions) | 0o111);
        try std.Io.Dir.cwd().setFilePermissions(manager.init_data.io, target, executable_permissions, .{});
    }

    fn relinkNativeDependencyBins(manager: *Manager, root: *const Value) !void {
        if (builtin.os.tag == .windows or manager.options.lockfile_only or manager.options.dry_run) return;
        if (root.* != .object) return;
        const configured = root.object.get("nativeDependencies");
        const defaults = [_][]const u8{ "esbuild", "@anthropic-ai/claude-code" };
        if (configured != null and configured.? != .array) return;

        if (configured) |native_dependencies| {
            for (native_dependencies.array.items) |entry| {
                if (entry == .string) try manager.relinkNativeDependencyBin(entry.string);
            }
        } else {
            for (defaults) |name| try manager.relinkNativeDependencyBin(name);
        }
    }

    fn relinkNativeDependencyBin(manager: *Manager, package_name: []const u8) !void {
        const main_record = manager.findRecord(package_name) orelse return;
        const metadata = main_record.metadata orelse return;
        if (metadata.* != .object) return;
        const optional_dependencies = metadata.object.get("optionalDependencies") orelse return;
        if (optional_dependencies != .object) return;

        for (optional_dependencies.object.keys()) |candidate_name| {
            const candidate = manager.findRecord(candidate_name) orelse continue;
            const candidate_metadata = candidate.metadata orelse continue;
            if (!platformMatches(candidate_metadata)) continue;
            const candidate_dir = try packageDestination(manager.allocator, manager.root_dir, candidate.alias);
            try manager.linkBins(main_record.alias, candidate_dir, metadata, true, manager.root_dir);
            return;
        }
    }

    fn findRecord(manager: *Manager, name: []const u8) ?*const PackageRecord {
        for (manager.records.items) |*record| {
            if (std.mem.eql(u8, record.alias, name) or std.mem.eql(u8, record.name, name)) return record;
        }
        return null;
    }

    fn discoverWorkspaces(manager: *Manager, root: *Value) !void {
        if (root.* != .object) return;
        const workspace_value = root.object.get("workspaces") orelse return;
        const patterns = switch (workspace_value) {
            .array => |array| array.items,
            .object => |object| if (object.get("packages")) |packages| if (packages == .array) packages.array.items else return else return,
            else => return,
        };
        for (patterns) |pattern_value| {
            if (pattern_value != .string) continue;
            try manager.discoverWorkspacePattern(pattern_value.string);
        }
    }

    fn discoverWorkspacePattern(manager: *Manager, pattern: []const u8) !void {
        if (std.mem.endsWith(u8, pattern, "/*")) {
            const base = pattern[0 .. pattern.len - 2];
            var directory = std.Io.Dir.cwd().openDir(manager.init_data.io, base, .{ .iterate = true }) catch return;
            defer directory.close(manager.init_data.io);
            var iterator = directory.iterate();
            while (try iterator.next(manager.init_data.io)) |entry| {
                if (entry.kind != .directory) continue;
                const path = try std.fs.path.join(manager.allocator, &.{ manager.root_dir, base, entry.name });
                try manager.addWorkspace(path);
            }
        } else if (std.mem.indexOfScalar(u8, pattern, '*') == null) {
            const path = try std.fs.path.join(manager.allocator, &.{ manager.root_dir, pattern });
            try manager.addWorkspace(path);
        }
    }

    fn addWorkspace(manager: *Manager, path: []const u8) !void {
        const package_json_path = try std.fs.path.join(manager.allocator, &.{ path, "package.json" });
        const source = std.Io.Dir.cwd().readFileAlloc(
            manager.init_data.io,
            package_json_path,
            manager.allocator,
            .limited(16 * 1024 * 1024),
        ) catch return;
        const package_json = try manager.allocator.create(Value);
        package_json.* = std.json.parseFromSliceLeaky(Value, manager.allocator, source, .{}) catch return;
        if (package_json.* != .object) return;
        const name = jsonString(package_json, "name") orelse return;
        try manager.workspaces.put(name, .{
            .name = name,
            .path = path,
            .version = jsonString(package_json, "version") orelse "0.0.0",
            .package_json = package_json,
        });
    }

    fn resolveWorkspaceDependency(
        manager: *Manager,
        alias: []const u8,
        spec: []const u8,
        parent_dir: []const u8,
    ) !?Workspace {
        if (manager.workspaces.get(alias)) |workspace| return workspace;
        if (!std.mem.startsWith(u8, spec, "workspace:")) return null;

        const target = spec["workspace:".len..];
        if (target.len == 0 or target[0] != '.') return null;
        const target_path = try absolutePathFrom(manager.allocator, parent_dir, target);
        var workspaces = manager.workspaces.iterator();
        while (workspaces.next()) |entry| {
            const workspace = entry.value_ptr.*;
            if (std.mem.eql(u8, workspace.path, target_path)) return workspace;
        }
        return null;
    }

    fn installWorkspaceDependencies(manager: *Manager) !void {
        var iterator = manager.workspaces.iterator();
        while (iterator.next()) |entry| {
            const workspace = entry.value_ptr.*;
            try manager.rememberPackageMetadata(workspace.path, workspace.package_json);
            _ = try manager.peerContextForPackage(workspace.package_json, workspace.path, true);
            if (manager.node_linker == .hoisted) {
                if (!manager.options.lockfile_only) try manager.linkDirectory(workspace.name, workspace.path);
                const destination = try packageDestination(manager.allocator, manager.root_dir, workspace.name);
                if (!manager.options.lockfile_only) try manager.linkBins(workspace.name, destination, workspace.package_json, true, manager.root_dir);
                try manager.addRecord(.{
                    .key = try manager.lockKeyForDestination(destination),
                    .alias = workspace.name,
                    .name = workspace.name,
                    .version = workspace.version,
                    .local_path = workspace.path,
                    .resolution = workspace.path,
                    .kind = .workspace,
                });
            }
            try manager.installDependencyObject(workspace.package_json, "dependencies", workspace.path, false, false);
            if (!manager.options.omit_optional) {
                try manager.installDependencyObject(workspace.package_json, "optionalDependencies", workspace.path, false, true);
            }
            try manager.installOrLinkPeerDependencies(workspace.package_json, workspace.path, workspace.path, workspace.path);
            if (!manager.options.production) try manager.installDependencyObject(workspace.package_json, "devDependencies", workspace.path, false, false);
            try manager.script_queue.add(.{
                .name = workspace.name,
                .version = workspace.version,
                .cwd = workspace.path,
                .kind = .workspace,
                .optional = false,
            });
        }
    }

    fn queuePackageScripts(
        manager: *Manager,
        name: []const u8,
        version_value: []const u8,
        package_dir: []const u8,
        kind: Scripts.PackageKind,
        optional: bool,
        newly_installed: bool,
    ) !void {
        if (manager.options.ignore_scripts or manager.options.lockfile_only or manager.options.dry_run) return;
        const npm_package = kind == .npm;
        if (!manager.manifest_policy.?.isTrusted(name, npm_package)) return;

        if (!newly_installed) {
            if (manager.manifest_policy.?.trusted_dependencies == null) return;
            const graph = if (manager.lock_graph) |*value| value else null;
            if (graph) |locked| {
                if (Manifest.Policy.wasTrustedInLock(&locked.document, name)) return;
            }
        }

        try manager.script_queue.add(.{
            .name = name,
            .version = version_value,
            .cwd = package_dir,
            .kind = kind,
            .optional = optional,
        });
    }

    fn pathExists(manager: *Manager, path: []const u8) bool {
        std.Io.Dir.cwd().access(manager.init_data.io, path, .{}) catch return false;
        return true;
    }

    fn addRecord(manager: *Manager, record: PackageRecord) !void {
        for (manager.records.items) |existing| {
            const existing_key = if (existing.key.len > 0) existing.key else existing.alias;
            const record_key = if (record.key.len > 0) record.key else record.alias;
            if (std.mem.eql(u8, existing_key, record_key) and
                std.mem.eql(u8, existing.alias, record.alias) and
                std.mem.eql(u8, existing.version, record.version)) return;
        }
        try manager.records.append(record);
    }

    fn linkRecordMetadata(manager: *Manager, writer: *std.Io.Writer, record: PackageRecord) !void {
        try writeJSONString(writer, if (record.key.len > 0) record.key else record.alias);
        try writer.writeAll(": [");
        switch (record.kind) {
            .npm => {
                const resolution = try std.fmt.allocPrint(manager.allocator, "{s}@{s}", .{ record.name, record.version });
                try writeJSONString(writer, resolution);
                try writer.writeAll(", ");
                try writeJSONString(writer, record.tarball);
                try writer.writeAll(", ");
                try manager.writePackageInfo(writer, record.metadata);
                if (record.integrity.len > 0) {
                    try writer.writeAll(", ");
                    try writeJSONString(writer, record.integrity);
                }
            },
            .workspace => {
                const relative = try manager.relativeLockPath(if (record.local_path.len > 0) record.local_path else record.resolution);
                const resolution = try std.fmt.allocPrint(manager.allocator, "{s}@workspace:{s}", .{ record.name, relative });
                try writeJSONString(writer, resolution);
            },
            .folder, .symlink => {
                const relative = try manager.relativeLockPath(if (record.local_path.len > 0) record.local_path else record.resolution);
                const resolution = try std.fmt.allocPrint(manager.allocator, "{s}@{s}:{s}", .{
                    record.name,
                    if (record.kind == .symlink) "link" else "file",
                    relative,
                });
                try writeJSONString(writer, resolution);
                try writer.writeAll(", ");
                try manager.writePackageInfo(writer, record.metadata);
            },
            .local_tarball, .remote_tarball, .git, .github => {
                const source = if (record.resolution.len > 0) record.resolution else record.tarball;
                const resolution = try std.fmt.allocPrint(manager.allocator, "{s}@{s}", .{ record.name, source });
                try writeJSONString(writer, resolution);
                try writer.writeAll(", ");
                try manager.writePackageInfo(writer, record.metadata);
                if (record.integrity.len > 0) {
                    try writer.writeAll(", ");
                    try writeJSONString(writer, record.integrity);
                }
            },
            .root => {
                const resolution = try std.fmt.allocPrint(manager.allocator, "{s}@root:", .{record.name});
                try writeJSONString(writer, resolution);
                try writer.writeAll(", ");
                try manager.writePackageInfo(writer, record.metadata);
            },
        }
        try writer.writeByte(']');
    }

    fn relativeLockPath(manager: *Manager, path: []const u8) ![]const u8 {
        if (path.len == 0) return "";
        if (!std.fs.path.isAbsolute(path)) return path;
        const relative = try std.fs.path.relative(
            manager.allocator,
            manager.root_dir,
            manager.init_data.environ_map,
            manager.root_dir,
            path,
        );
        if (builtin.os.tag != .windows) return relative;
        const normalized = try manager.allocator.dupe(u8, relative);
        std.mem.replaceScalar(u8, normalized, '\\', '/');
        return normalized;
    }

    fn writePackageInfo(manager: *Manager, writer: *std.Io.Writer, metadata: ?*const Value) !void {
        _ = manager;
        const value = metadata orelse {
            try writer.writeAll("{}");
            return;
        };
        if (value.* != .object) {
            try writer.writeAll("{}");
            return;
        }
        const fields = [_][]const u8{
            "dependencies",
            "devDependencies",
            "optionalDependencies",
            "peerDependencies",
            "peerDependenciesMeta",
            "optionalPeers",
            "os",
            "cpu",
            "libc",
            "bin",
            "binDir",
            "bundled",
        };
        try writer.writeByte('{');
        var first = true;
        for (fields) |field| {
            const field_value = value.object.get(field) orelse continue;
            if (!first) try writer.writeAll(", ");
            first = false;
            try writeJSONString(writer, field);
            try writer.writeAll(": ");
            try std.json.Stringify.value(field_value, .{}, writer);
        }
        try writer.writeByte('}');
    }

    fn writeTextLockfile(manager: *Manager, root: *Value) !void {
        if (manager.options.frozen_lockfile and manager.changed) return error.FrozenLockfileChanged;
        if (!manager.save_text_lockfile and !manager.options.silent) {
            try manager.stderr.writeAll("warning: binary bun.lockb output is not available; writing bun.lock\n");
        }
        var output: std.Io.Writer.Allocating = .init(manager.allocator);
        const writer = &output.writer;
        try writer.writeAll("{\n  \"lockfileVersion\": 1,\n  \"configVersion\": 1,\n  \"workspaces\": {\n    \"\": ");
        try manager.writeWorkspaceInfo(writer, root);
        var sorted_workspaces = std.array_list.Managed(Workspace).init(manager.allocator);
        defer sorted_workspaces.deinit();
        var workspace_iterator = manager.workspaces.iterator();
        while (workspace_iterator.next()) |entry| try sorted_workspaces.append(entry.value_ptr.*);
        std.sort.pdq(Workspace, sorted_workspaces.items, {}, struct {
            fn lessThan(_: void, left: Workspace, right: Workspace) bool {
                return std.mem.order(u8, left.path, right.path) == .lt;
            }
        }.lessThan);
        for (sorted_workspaces.items) |workspace| {
            const path = try manager.relativeLockPath(workspace.path);
            try writer.writeAll(",\n\n    ");
            try writeJSONString(writer, path);
            try writer.writeAll(": ");
            try manager.writeWorkspaceInfo(writer, workspace.package_json);
        }
        try writer.writeAll("\n  }");
        try manager.manifest_policy.?.writeLockFields(writer);
        try writer.writeAll(",\n  \"packages\": {");
        const records = try manager.allocator.dupe(PackageRecord, manager.records.items);
        defer manager.allocator.free(records);
        std.sort.pdq(PackageRecord, records, {}, struct {
            fn lessThan(_: void, left: PackageRecord, right: PackageRecord) bool {
                const left_key = if (left.key.len > 0) left.key else left.alias;
                const right_key = if (right.key.len > 0) right.key else right.alias;
                return std.mem.order(u8, left_key, right_key) == .lt;
            }
        }.lessThan);
        for (records, 0..) |record, index| {
            try writer.writeAll(if (index == 0) "\n    " else ",\n\n    ");
            try manager.linkRecordMetadata(writer, record);
        }
        if (records.len > 0) try writer.writeByte(',');
        try writer.writeAll("\n  }\n}\n");

        // COTTONTAIL-COMPAT: Cottontail owns the text format end-to-end. Binary
        // bun.lockb serialization remains isolated in the vendored Bun source
        // until its lockfile graph can be shared without Bun's global state.
        const lockfile_path = try std.fs.path.join(manager.allocator, &.{ manager.root_dir, "bun.lock" });
        try std.Io.Dir.cwd().writeFile(manager.init_data.io, .{ .sub_path = lockfile_path, .data = output.written() });
        if (!manager.options.silent) try manager.stderr.writeAll("Saved lockfile\n");
    }

    fn writeWorkspaceInfo(manager: *Manager, writer: *std.Io.Writer, package_json: *const Value) !void {
        _ = manager;
        try writer.writeByte('{');
        var first = true;
        if (jsonString(package_json, "name")) |name| {
            try writer.writeAll("\n      \"name\": ");
            try writeJSONString(writer, name);
            first = false;
        }
        if (package_json.* == .object) {
            for (all_dependency_sections) |section_name| {
                const section = package_json.object.get(section_name) orelse continue;
                if (section != .object or section.object.count() == 0) continue;
                if (!first) try writer.writeByte(',');
                try writer.print("\n      \"{s}\": ", .{section_name});
                try std.json.Stringify.value(section, .{}, writer);
                first = false;
            }
        }
        if (!first) try writer.writeByte('\n');
        try writer.writeAll("    }");
    }

    fn deleteLockfiles(manager: *Manager) void {
        const text_path = std.fs.path.join(manager.allocator, &.{ manager.root_dir, "bun.lock" }) catch return;
        const binary_path = std.fs.path.join(manager.allocator, &.{ manager.root_dir, "bun.lockb" }) catch return;
        std.Io.Dir.cwd().deleteFile(manager.init_data.io, text_path) catch {};
        std.Io.Dir.cwd().deleteFile(manager.init_data.io, binary_path) catch {};
    }

    fn hasExistingLockfile(manager: *Manager) bool {
        const text_path = std.fs.path.join(manager.allocator, &.{ manager.root_dir, "bun.lock" }) catch return false;
        std.Io.Dir.cwd().access(manager.init_data.io, text_path, .{}) catch return false;
        return true;
    }
};

fn splitPackageSpec(input: []const u8) PackageSpec {
    if (isGitSpec(input) or isTarballSpec(input) or isLocalSpec(input) or std.mem.startsWith(u8, input, "http://") or std.mem.startsWith(u8, input, "https://")) {
        return .{ .name = null, .spec = input };
    }
    if (std.mem.startsWith(u8, input, "@")) {
        const slash = std.mem.indexOfScalar(u8, input, '/') orelse return .{ .name = input, .spec = "latest" };
        if (std.mem.indexOfScalarPos(u8, input, slash + 1, '@')) |at| {
            return .{ .name = input[0..at], .spec = if (at + 1 < input.len) input[at + 1 ..] else "latest" };
        }
        return .{ .name = input, .spec = "latest" };
    }
    if (std.mem.indexOfScalar(u8, input, '@')) |at| {
        if (at > 0) return .{ .name = input[0..at], .spec = if (at + 1 < input.len) input[at + 1 ..] else "latest" };
    }
    return .{ .name = input, .spec = "latest" };
}

fn parseNpmAlias(alias: []const u8, spec: []const u8) struct { []const u8, []const u8 } {
    if (!std.mem.startsWith(u8, spec, "npm:")) return .{ alias, spec };
    const parsed = splitPackageSpec(spec["npm:".len..]);
    return .{ parsed.name orelse alias, parsed.spec };
}

fn hasExplicitRange(input: []const u8) bool {
    const parsed = splitPackageSpec(input);
    return parsed.name != null and !std.mem.eql(u8, parsed.spec, "latest");
}

fn isLocalSpec(spec: []const u8) bool {
    return std.mem.startsWith(u8, spec, "file:") or
        std.mem.startsWith(u8, spec, "link:") or
        std.mem.startsWith(u8, spec, "./") or
        std.mem.startsWith(u8, spec, "../") or
        std.fs.path.isAbsolute(spec);
}

fn localSpecPath(spec: []const u8) []const u8 {
    if (std.mem.startsWith(u8, spec, "file:")) {
        const raw = spec["file:".len..];
        var slash_count: usize = 0;
        while (slash_count < raw.len and raw[slash_count] == '/') : (slash_count += 1) {}
        if (slash_count == 0) return raw;
        const remainder = raw[slash_count..];
        if (std.mem.startsWith(u8, remainder, "./") or std.mem.startsWith(u8, remainder, "../")) return remainder;
        if (remainder.len == 0) return "/";
        return raw[slash_count - 1 ..];
    }
    if (std.mem.startsWith(u8, spec, "link:")) return spec["link:".len..];
    return spec;
}

fn isTarballSpec(spec: []const u8) bool {
    return std.mem.endsWith(u8, spec, ".tgz") or std.mem.endsWith(u8, spec, ".tar.gz");
}

fn isRemoteTarballSpec(spec: []const u8) bool {
    return isTarballSpec(spec) and
        (std.mem.startsWith(u8, spec, "http://") or std.mem.startsWith(u8, spec, "https://"));
}

fn isGitSpec(spec: []const u8) bool {
    if (std.mem.startsWith(u8, spec, "github:") or
        std.mem.startsWith(u8, spec, "git+") or
        std.mem.startsWith(u8, spec, "git://") or
        std.mem.startsWith(u8, spec, "ssh://") or
        std.mem.startsWith(u8, spec, "git@")) return true;
    if (std.mem.indexOf(u8, spec, "github.com/") != null and std.mem.indexOf(u8, spec, "/tarball/") == null) return true;
    if (spec.len == 0 or spec[0] == '@' or std.mem.startsWith(u8, spec, "./") or std.mem.startsWith(u8, spec, "../")) return false;
    const without_fragment = if (std.mem.indexOfScalar(u8, spec, '#')) |hash| spec[0..hash] else spec;
    const slash = std.mem.indexOfScalar(u8, without_fragment, '/') orelse return false;
    return slash > 0 and slash + 1 < without_fragment.len and
        std.mem.indexOfScalarPos(u8, without_fragment, slash + 1, '/') == null and
        std.mem.indexOfScalar(u8, without_fragment, ':') == null;
}

fn isGitCommitish(value: []const u8) bool {
    if (value.len < 7 or value.len > 40) return false;
    for (value) |byte| if (!std.ascii.isHex(byte)) return false;
    return true;
}

fn hasUnknownURLScheme(spec: []const u8) bool {
    const scheme = std.mem.indexOf(u8, spec, "://") orelse return false;
    if (scheme == 0) return true;
    return !std.mem.startsWith(u8, spec, "http://") and
        !std.mem.startsWith(u8, spec, "https://") and
        !std.mem.startsWith(u8, spec, "file://") and
        !std.mem.startsWith(u8, spec, "git://") and
        !std.mem.startsWith(u8, spec, "git+") and
        !std.mem.startsWith(u8, spec, "ssh://");
}

fn packageDestination(allocator: std.mem.Allocator, base: []const u8, alias: []const u8) ![]const u8 {
    return std.fs.path.join(allocator, &.{ base, "node_modules", alias });
}

fn packageNameFromNodeModulesPath(path: []const u8) ?[]const u8 {
    var start: ?usize = null;
    if (std.mem.startsWith(u8, path, "node_modules/") or std.mem.startsWith(u8, path, "node_modules\\")) {
        start = "node_modules/".len;
    }
    if (std.mem.lastIndexOf(u8, path, "/node_modules/")) |index| start = index + "/node_modules/".len;
    if (std.mem.lastIndexOf(u8, path, "\\node_modules\\")) |index| start = index + "\\node_modules\\".len;
    const tail = path[start orelse return null ..];
    if (tail.len == 0) return null;
    if (tail[0] == '@') {
        const scope_end = std.mem.indexOfAny(u8, tail, "/\\") orelse return null;
        const package_end = std.mem.indexOfAnyPos(u8, tail, scope_end + 1, "/\\") orelse tail.len;
        if (scope_end + 1 >= package_end) return null;
        return tail[0..package_end];
    }
    const package_end = std.mem.indexOfAny(u8, tail, "/\\") orelse tail.len;
    return if (package_end > 0) tail[0..package_end] else null;
}

fn isPatchableResolution(kind: Lockfile.Kind) bool {
    return switch (kind) {
        .npm, .local_tarball, .remote_tarball, .git, .github => true,
        else => false,
    };
}

fn findPatchProjectRoot(io: std.Io, allocator: std.mem.Allocator, start: []const u8) ![]const u8 {
    var current = try allocator.dupe(u8, start);
    while (true) {
        const text_lock = try std.fs.path.join(allocator, &.{ current, "bun.lock" });
        if (std.Io.Dir.cwd().access(io, text_lock, .{})) |_| return current else |_| {}
        const binary_lock = try std.fs.path.join(allocator, &.{ current, "bun.lockb" });
        if (std.Io.Dir.cwd().access(io, binary_lock, .{})) |_| return current else |_| {}
        const parent = std.fs.path.dirname(current) orelse return allocator.dupe(u8, start);
        if (std.mem.eql(u8, parent, current)) return allocator.dupe(u8, start);
        current = try allocator.dupe(u8, parent);
    }
}

fn normalizePathForManifest(allocator: std.mem.Allocator, path: []const u8) ![]const u8 {
    const normalized = try allocator.dupe(u8, path);
    if (builtin.os.tag == .windows) std.mem.replaceScalar(u8, normalized, '\\', '/');
    return normalized;
}

fn pathsEquivalent(io: std.Io, allocator: std.mem.Allocator, left: []const u8, right: []const u8) !bool {
    const resolved_left = try std.fs.path.resolve(allocator, &.{left});
    const resolved_right = try std.fs.path.resolve(allocator, &.{right});
    if (std.mem.eql(u8, resolved_left, resolved_right)) return true;
    const real_left = std.Io.Dir.cwd().realPathFileAlloc(io, left, allocator) catch return false;
    const real_right = std.Io.Dir.cwd().realPathFileAlloc(io, right, allocator) catch return false;
    return std.mem.eql(u8, real_left, real_right);
}

fn normalizedBinName(name: []const u8) []const u8 {
    if (std.mem.lastIndexOfAny(u8, name, "/\\:")) |index| return name[index + 1 ..];
    return name;
}

fn platformMatches(metadata: *const Value) bool {
    if (metadata.* != .object) return false;
    const os = metadata.object.get("os") orelse return false;
    const cpu = metadata.object.get("cpu") orelse return false;
    const os_name = switch (builtin.os.tag) {
        .macos => "darwin",
        .windows => "win32",
        else => @tagName(builtin.os.tag),
    };
    const cpu_name = switch (builtin.cpu.arch) {
        .aarch64 => "arm64",
        .x86_64 => "x64",
        .x86 => "ia32",
        else => @tagName(builtin.cpu.arch),
    };
    return platformFieldMatches(os, os_name) and platformFieldMatches(cpu, cpu_name);
}

fn platformFieldMatches(value: Value, target: []const u8) bool {
    if (value == .string) return platformEntryMatches(value.string, target);
    if (value != .array) return false;
    var has_positive = false;
    var positive_match = false;
    for (value.array.items) |entry| {
        if (entry != .string or entry.string.len == 0) continue;
        if (entry.string[0] == '!') {
            if (std.mem.eql(u8, entry.string[1..], target)) return false;
        } else {
            has_positive = true;
            if (platformEntryMatches(entry.string, target)) positive_match = true;
        }
    }
    return !has_positive or positive_match;
}

fn platformEntryMatches(value: []const u8, target: []const u8) bool {
    return std.mem.eql(u8, value, target) or std.mem.eql(u8, value, "any") or std.mem.eql(u8, value, "*");
}

fn parentPackageBase(root_dir: []const u8, package_dir: []const u8) ?[]const u8 {
    if (std.mem.eql(u8, root_dir, package_dir)) return null;
    const marker = std.fs.path.sep_str ++ "node_modules" ++ std.fs.path.sep_str;
    const index = std.mem.lastIndexOf(u8, package_dir, marker) orelse return root_dir;
    if (index <= root_dir.len) return root_dir;
    return package_dir[0..index];
}

fn isTopLevelDestination(root_dir: []const u8, destination: []const u8, alias: []const u8) bool {
    var buffer: [std.fs.max_path_bytes]u8 = undefined;
    const expected = std.fmt.bufPrint(&buffer, "{s}{c}node_modules{c}{s}", .{
        root_dir,
        std.fs.path.sep,
        std.fs.path.sep,
        alias,
    }) catch return false;
    return std.mem.eql(u8, expected, destination);
}

fn pathHasPrefix(path: []const u8, prefix: []const u8) bool {
    if (!std.mem.startsWith(u8, path, prefix)) return false;
    return path.len == prefix.len or path[prefix.len] == '/' or path[prefix.len] == '\\';
}

fn absolutePath(io: std.Io, allocator: std.mem.Allocator, path: []const u8) ![]const u8 {
    if (std.fs.path.isAbsolute(path)) return std.fs.path.resolve(allocator, &.{path});
    const cwd = try std.Io.Dir.cwd().realPathFileAlloc(io, ".", allocator);
    return absolutePathFrom(allocator, cwd, path);
}

fn absolutePathFrom(allocator: std.mem.Allocator, base: []const u8, path: []const u8) ![]const u8 {
    if (std.fs.path.isAbsolute(path)) return std.fs.path.resolve(allocator, &.{path});
    return std.fs.path.resolve(allocator, &.{ base, path });
}

fn packageCachePath(init: std.process.Init, allocator: std.mem.Allocator) ![]const u8 {
    if (init.environ_map.get("BUN_INSTALL_CACHE_DIR")) |cache| return allocator.dupe(u8, cache);
    if (init.environ_map.get("XDG_CACHE_HOME")) |home| return std.fs.path.join(allocator, &.{ home, ".bun", "install", "cache" });
    if (init.environ_map.get("HOME")) |home| return std.fs.path.join(allocator, &.{ home, ".bun", "install", "cache" });
    return absolutePath(init.io, allocator, "node_modules/.cache");
}

fn encodePackageName(allocator: std.mem.Allocator, name: []const u8) ![]const u8 {
    if (!std.mem.startsWith(u8, name, "@")) return allocator.dupe(u8, name);
    const slash = std.mem.indexOfScalar(u8, name, '/') orelse return allocator.dupe(u8, name);
    return std.fmt.allocPrint(allocator, "{s}%2f{s}", .{ name[0..slash], name[slash + 1 ..] });
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

fn sha512Integrity(allocator: std.mem.Allocator, bytes: []const u8) ![]const u8 {
    var digest: [64]u8 = undefined;
    std.crypto.hash.sha2.Sha512.hash(bytes, &digest, .{});
    const encoded_len = std.base64.standard.Encoder.calcSize(digest.len);
    const integrity = try allocator.alloc(u8, "sha512-".len + encoded_len);
    @memcpy(integrity[0.."sha512-".len], "sha512-");
    _ = std.base64.standard.Encoder.encode(integrity["sha512-".len..], &digest);
    return integrity;
}

fn verifyIntegrity(bytes: []const u8, integrity: ?[]const u8) !void {
    const value = integrity orelse return;
    if (!std.mem.startsWith(u8, value, "sha512-")) return;
    const encoded = value["sha512-".len..];
    var expected: [64]u8 = undefined;
    const decoded_len = std.base64.standard.Decoder.calcSizeForSlice(encoded) catch return error.IntegrityCheckFailed;
    if (decoded_len != expected.len) return error.IntegrityCheckFailed;
    _ = std.base64.standard.Decoder.decode(&expected, encoded) catch return error.IntegrityCheckFailed;
    var actual: [64]u8 = undefined;
    std.crypto.hash.sha2.Sha512.hash(bytes, &actual, .{});
    if (!std.crypto.timing_safe.eql([64]u8, expected, actual)) return error.IntegrityCheckFailed;
}

fn extractTarballArchive(
    io: std.Io,
    allocator: std.mem.Allocator,
    destination: std.Io.Dir,
    archive: []const u8,
) !void {
    var compressed_reader: std.Io.Reader = .fixed(archive);
    var decompression_buffer: [std.compress.flate.max_window_len]u8 = undefined;
    var decompressor: std.compress.flate.Decompress = .init(&compressed_reader, .gzip, &decompression_buffer);
    var diagnostics: std.tar.Diagnostics = .{ .allocator = allocator };
    defer diagnostics.deinit();
    try std.tar.extract(io, destination, &decompressor.reader, .{
        .strip_components = 1,
        .diagnostics = &diagnostics,
    });
    for (diagnostics.errors.items) |problem| switch (problem) {
        .components_outside_stripped_prefix => {},
        .unable_to_create_file => |info| return info.code,
        .unable_to_create_sym_link => |info| return info.code,
        .unsupported_file_type => return error.TarUnsupportedHeader,
    };
}

fn jsonString(value: *const Value, key: []const u8) ?[]const u8 {
    if (value.* != .object) return null;
    const field = value.object.get(key) orelse return null;
    return if (field == .string) field.string else null;
}

fn objectSectionContains(value: *const Value, section_name: []const u8, key: []const u8) bool {
    if (value.* != .object) return false;
    const section = value.object.get(section_name) orelse return false;
    return section == .object and section.object.get(key) != null;
}

fn ownedDependencySpec(value: *const Value, alias: []const u8) ?[]const u8 {
    return dependencySpec(value, alias, &mutable_dependency_sections);
}

fn runtimeDependencySpec(value: *const Value, alias: []const u8) ?[]const u8 {
    return dependencySpec(value, alias, &runtime_dependency_sections);
}

fn dependencySpec(value: *const Value, alias: []const u8, sections: []const []const u8) ?[]const u8 {
    if (value.* != .object) return null;
    for (sections) |section_name| {
        const section = value.object.get(section_name) orelse continue;
        if (section != .object) continue;
        const spec = section.object.get(alias) orelse continue;
        if (spec == .string) return spec.string;
    }
    return null;
}

fn packageHasRuntimeDependency(value: *const Value, alias: []const u8) bool {
    return runtimeDependencySpec(value, alias) != null;
}

fn peerDependencyIsOptional(value: *const Value, alias: []const u8) bool {
    if (value.* != .object) return false;
    if (value.object.get("peerDependenciesMeta")) |meta| {
        if (meta == .object) {
            if (meta.object.get(alias)) |peer_meta| {
                if (peer_meta == .object) {
                    if (peer_meta.object.get("optional")) |optional| {
                        if (optional == .bool) return optional.bool;
                    }
                }
            }
        }
    }
    if (value.object.get("optionalPeers")) |optional_peers| switch (optional_peers) {
        .array => for (optional_peers.array.items) |entry| {
            if (entry == .string and std.mem.eql(u8, entry.string, alias)) return true;
        },
        .object => if (optional_peers.object.get(alias)) |entry| {
            if (entry == .bool) return entry.bool;
        },
        else => {},
    };
    return false;
}

fn ensureObjectProperty(
    allocator: std.mem.Allocator,
    object: *std.json.ObjectMap,
    key: []const u8,
) !*std.json.ObjectMap {
    if (object.getPtr(key)) |existing| {
        if (existing.* != .object) return error.InvalidPackageJSON;
        return &existing.object;
    }
    try object.put(allocator, try allocator.dupe(u8, key), .{ .object = .empty });
    return &object.getPtr(key).?.object;
}

fn hasAnyDependencies(root: *const Value) bool {
    if (root.* != .object) return false;
    for (all_dependency_sections) |key| {
        if (root.object.get(key)) |value| if (value == .object and value.object.count() > 0) return true;
    }
    return false;
}

fn containsString(values: []const []const u8, needle: []const u8) bool {
    for (values) |value| if (std.mem.eql(u8, value, needle)) return true;
    return false;
}

fn parseTomlString(source: []const u8, key: []const u8) ?[]const u8 {
    var lines = std.mem.splitScalar(u8, source, '\n');
    while (lines.next()) |raw_line| {
        const line = std.mem.trim(u8, raw_line, " \t\r");
        if (!std.mem.startsWith(u8, line, key)) continue;
        var rest = std.mem.trimStart(u8, line[key.len..], " \t");
        if (rest.len == 0 or rest[0] != '=') continue;
        rest = std.mem.trim(u8, rest[1..], " \t\r");
        if (rest.len >= 2 and (rest[0] == '"' or rest[0] == '\'') and rest[rest.len - 1] == rest[0]) return rest[1 .. rest.len - 1];
    }
    return null;
}

fn parseTomlStringList(
    allocator: std.mem.Allocator,
    source: []const u8,
    key: []const u8,
) !?[]const []const u8 {
    const raw_value = tomlAssignment(source, key) orelse return null;
    const value = std.mem.trim(u8, raw_value, " \t\r");
    if (value.len == 0) return error.ExpectedPatternStringOrArray;

    if (value[0] == '"' or value[0] == '\'') {
        const end = findClosingQuote(value, 0) orelse return error.ExpectedPatternStringOrArray;
        const trailing = std.mem.trim(u8, value[end + 1 ..], " \t\r");
        if (trailing.len > 0 and trailing[0] != '#') return error.ExpectedPatternStringOrArray;
        const patterns = try allocator.alloc([]const u8, 1);
        patterns[0] = try allocator.dupe(u8, value[1..end]);
        return patterns;
    }
    if (value[0] != '[') return error.ExpectedPatternStringOrArray;

    var patterns = std.array_list.Managed([]const u8).init(allocator);
    var index: usize = 1;
    while (true) {
        while (index < value.len and (std.ascii.isWhitespace(value[index]) or value[index] == ',')) index += 1;
        if (index >= value.len) return error.ExpectedPatternStringOrArray;
        if (value[index] == ']') {
            index += 1;
            const trailing = std.mem.trim(u8, value[index..], " \t\r");
            if (trailing.len > 0 and trailing[0] != '#') return error.ExpectedPatternStringOrArray;
            const owned: []const []const u8 = try patterns.toOwnedSlice();
            return owned;
        }
        if (value[index] != '"' and value[index] != '\'') return error.ExpectedPatternString;
        const end = findClosingQuote(value, index) orelse return error.ExpectedPatternString;
        try patterns.append(try allocator.dupe(u8, value[index + 1 .. end]));
        index = end + 1;
        while (index < value.len and std.ascii.isWhitespace(value[index])) index += 1;
        if (index < value.len and value[index] != ',' and value[index] != ']') return error.ExpectedPatternString;
    }
}

fn tomlAssignment(source: []const u8, key: []const u8) ?[]const u8 {
    var line_start: usize = 0;
    while (line_start < source.len) {
        const line_end = std.mem.indexOfScalarPos(u8, source, line_start, '\n') orelse source.len;
        const raw_line = source[line_start..line_end];
        const line = std.mem.trim(u8, raw_line, " \t\r");
        if (line.len > 0 and line[0] != '#') {
            if (std.mem.indexOfScalar(u8, raw_line, '=')) |equals| {
                if (std.mem.eql(u8, std.mem.trim(u8, raw_line[0..equals], " \t"), key)) {
                    var value_start = line_start + equals + 1;
                    while (value_start < source.len and (source[value_start] == ' ' or source[value_start] == '\t')) value_start += 1;
                    if (value_start >= source.len or source[value_start] != '[') return source[value_start..line_end];

                    var quote: ?u8 = null;
                    var escaped = false;
                    var index = value_start + 1;
                    while (index < source.len) : (index += 1) {
                        const byte = source[index];
                        if (quote) |active_quote| {
                            if (active_quote == '"' and byte == '\\' and !escaped) {
                                escaped = true;
                                continue;
                            }
                            if (byte == active_quote and !escaped) quote = null;
                            escaped = false;
                            continue;
                        }
                        if (byte == '"' or byte == '\'') {
                            quote = byte;
                        } else if (byte == ']') {
                            return source[value_start .. index + 1];
                        }
                    }
                    return source[value_start..];
                }
            }
        }
        line_start = if (line_end < source.len) line_end + 1 else source.len;
    }
    return null;
}

fn findClosingQuote(value: []const u8, start: usize) ?usize {
    const quote = value[start];
    var index = start + 1;
    while (index < value.len) : (index += 1) {
        if (value[index] != quote) continue;
        if (quote == '"') {
            var backslashes: usize = 0;
            var cursor = index;
            while (cursor > start and value[cursor - 1] == '\\') : (cursor -= 1) backslashes += 1;
            if (backslashes % 2 == 1) continue;
        }
        return index;
    }
    return null;
}

fn parseTomlBool(source: []const u8, key: []const u8) ?bool {
    var lines = std.mem.splitScalar(u8, source, '\n');
    while (lines.next()) |raw_line| {
        const line = std.mem.trim(u8, raw_line, " \t\r");
        if (!std.mem.startsWith(u8, line, key)) continue;
        const equals = std.mem.indexOfScalar(u8, line, '=') orelse continue;
        const value = std.mem.trim(u8, line[equals + 1 ..], " \t\r");
        if (std.mem.eql(u8, value, "true")) return true;
        if (std.mem.eql(u8, value, "false")) return false;
    }
    return null;
}

fn parseNpmrcValue(source: []const u8, key: []const u8) ?[]const u8 {
    var lines = std.mem.splitScalar(u8, source, '\n');
    while (lines.next()) |raw_line| {
        const line = std.mem.trim(u8, raw_line, " \t\r");
        if (line.len == 0 or line[0] == '#' or line[0] == ';') continue;
        const equals = std.mem.indexOfScalar(u8, line, '=') orelse continue;
        if (!std.mem.eql(u8, std.mem.trim(u8, line[0..equals], " \t"), key)) continue;
        return std.mem.trim(u8, line[equals + 1 ..], " \t\r");
    }
    return null;
}

fn parseNpmrcStringList(
    allocator: std.mem.Allocator,
    source: []const u8,
    key: []const u8,
) !?[]const []const u8 {
    var patterns = std.array_list.Managed([]const u8).init(allocator);
    const array_name = try std.fmt.allocPrint(allocator, "{s}[]", .{key});
    var lines = std.mem.splitScalar(u8, source, '\n');
    while (lines.next()) |raw_line| {
        const line = std.mem.trim(u8, raw_line, " \t\r");
        if (line.len == 0 or line[0] == '#' or line[0] == ';') continue;
        const equals = std.mem.indexOfScalar(u8, line, '=') orelse continue;
        const raw_name = std.mem.trim(u8, line[0..equals], " \t");
        if (!std.mem.eql(u8, raw_name, key) and !std.mem.eql(u8, raw_name, array_name)) continue;
        try patterns.append(try allocator.dupe(u8, std.mem.trim(u8, line[equals + 1 ..], " \t\r")));
    }
    if (patterns.items.len == 0) return null;
    const owned: []const []const u8 = try patterns.toOwnedSlice();
    return owned;
}

fn writePackageJSON(
    io: std.Io,
    allocator: std.mem.Allocator,
    path: []const u8,
    value: Value,
    trailing_newline: bool,
) !void {
    var output: std.Io.Writer.Allocating = .init(allocator);
    try std.json.Stringify.value(value, .{ .whitespace = .indent_2 }, &output.writer);
    if (trailing_newline) try output.writer.writeByte('\n');
    try std.Io.Dir.cwd().writeFile(io, .{ .sub_path = path, .data = output.written() });
}

fn writeJSONString(writer: *std.Io.Writer, value: []const u8) !void {
    try std.json.Stringify.value(value, .{}, writer);
}

fn deletePath(io: std.Io, path: []const u8) void {
    std.Io.Dir.cwd().deleteTree(io, path) catch {
        std.Io.Dir.cwd().deleteFile(io, path) catch {};
    };
}

fn copyDirectoryTree(io: std.Io, allocator: std.mem.Allocator, source: []const u8, destination: []const u8) !void {
    try std.Io.Dir.cwd().createDirPath(io, destination);
    var source_dir = try std.Io.Dir.cwd().openDir(io, source, .{ .iterate = true });
    defer source_dir.close(io);
    var iterator = source_dir.iterate();
    while (try iterator.next(io)) |entry| {
        const source_path = try std.fs.path.join(allocator, &.{ source, entry.name });
        const destination_path = try std.fs.path.join(allocator, &.{ destination, entry.name });
        switch (entry.kind) {
            .directory => try copyDirectoryTree(io, allocator, source_path, destination_path),
            .file => try std.Io.Dir.copyFileAbsolute(source_path, destination_path, io, .{ .replace = true, .make_path = true }),
            else => {},
        }
    }
}

test "package specs preserve scoped names and ranges" {
    const scoped = splitPackageSpec("@scope/pkg@^1.2.0");
    try std.testing.expectEqualStrings("@scope/pkg", scoped.name.?);
    try std.testing.expectEqualStrings("^1.2.0", scoped.spec);
    const plain = splitPackageSpec("react");
    try std.testing.expectEqualStrings("react", plain.name.?);
    try std.testing.expectEqualStrings("latest", plain.spec);
    const alias = splitPackageSpec("bap@npm:baz@0.0.5");
    try std.testing.expectEqualStrings("bap", alias.name.?);
    try std.testing.expectEqualStrings("npm:baz@0.0.5", alias.spec);
}

test "file URL paths follow Bun folder resolution" {
    try std.testing.expectEqualStrings("../pkg", localSpecPath("file:///../pkg"));
    try std.testing.expectEqualStrings("/tmp/pkg", localSpecPath("file:////tmp/pkg"));
    try std.testing.expectEqualStrings("../pkg", localSpecPath("file:../pkg"));
    try std.testing.expect(hasUnknownURLScheme("fileblah://pkg"));
    try std.testing.expect(!hasUnknownURLScheme("https://registry.example/pkg.tgz"));
}

test "bun semver source selects the highest satisfying version" {
    var object: std.json.ObjectMap = .empty;
    defer object.deinit(std.testing.allocator);
    try object.put(std.testing.allocator, "1.0.0", .null);
    try object.put(std.testing.allocator, "1.9.0", .null);
    try object.put(std.testing.allocator, "2.0.0", .null);
    try std.testing.expectEqualStrings("1.9.0", bestMatchingVersion(std.testing.allocator, &object, "^1.0.0").?);
}
