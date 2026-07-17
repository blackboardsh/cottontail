const std = @import("std");
const builtin = @import("builtin");
const compiler = @import("cottontail_compiler");

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
const lifecycle_stages = [_][]const u8{ "preinstall", "install", "postinstall" };

const Command = enum {
    install,
    add,
    remove,
    update,
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

const RegistryPackage = struct {
    name: []const u8,
    version: []const u8,
    tarball: []const u8,
    integrity: ?[]const u8,
    metadata: *const Value,
};

const PackageRecord = struct {
    alias: []const u8,
    name: []const u8,
    version: []const u8,
    tarball: []const u8 = "",
    integrity: []const u8 = "",
    local_path: []const u8 = "",
};

const Workspace = struct {
    name: []const u8,
    path: []const u8,
    version: []const u8,
    package_json: *Value,
};

pub fn recognizes(command: []const u8) bool {
    return commandFromString(command) != null;
}

fn commandFromString(command: []const u8) ?Command {
    if (std.mem.eql(u8, command, "install") or std.mem.eql(u8, command, "i")) return .install;
    if (std.mem.eql(u8, command, "add") or std.mem.eql(u8, command, "a")) return .add;
    if (std.mem.eql(u8, command, "remove") or std.mem.eql(u8, command, "rm") or std.mem.eql(u8, command, "uninstall")) return .remove;
    if (std.mem.eql(u8, command, "update") or std.mem.eql(u8, command, "up")) return .update;
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
        if (err != error.PackageManagerErrorReported) {
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
        } else if (std.mem.eql(u8, arg, "--omit")) {
            index += 1;
            if (index >= args.len) return error.MissingOptionValue;
            try applyOmit(&options, args[index]);
        } else if (std.mem.startsWith(u8, arg, "--omit=")) {
            try applyOmit(&options, arg["--omit=".len..]);
        } else if (std.mem.eql(u8, arg, "--linker")) {
            index += 1;
            if (index >= args.len) return error.MissingOptionValue;
            if (!std.mem.eql(u8, args[index], "hoisted")) return error.UnsupportedPackageManagerLinker;
        } else if (std.mem.startsWith(u8, arg, "--linker=")) {
            if (!std.mem.eql(u8, arg["--linker=".len..], "hoisted")) return error.UnsupportedPackageManagerLinker;
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
        \\  --no-save                Do not update package.json or bun.lock
        \\  --no-verify              Skip package integrity verification
        \\  -f, --force              Re-resolve and reinstall dependencies
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
            .started_ns = std.Io.Clock.awake.now(init_data.io).nanoseconds,
        };
    }

    fn deinit(manager: *Manager) void {
        manager.client.deinit();
    }

    fn execute(manager: *Manager) !u8 {
        // Bun treats `install <package>` as `add <package>` before it
        // initializes the package manager.
        if (manager.options.command == .install and manager.options.positionals.len > 0) {
            manager.options.command = .add;
        }
        manager.root_dir = try absolutePath(manager.init_data.io, manager.allocator, ".");
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

        if (manager.options.frozen_lockfile) {
            if (manager.options.command != .install) return error.FrozenLockfileChanged;
            if (!manager.hasExistingLockfile()) return error.FrozenLockfileNotFound;
        }

        try manager.discoverWorkspaces(&root);
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
            .pm => unreachable,
        }

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

        if (!manager.options.ignore_scripts and !manager.options.dry_run and manager.options.command == .install and !manager.options.lockfile_only) {
            try manager.runRootLifecycleScripts(&root);
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

    fn prepareNodeModules(manager: *Manager) !void {
        if (manager.options.lockfile_only or manager.options.dry_run) return;
        const node_modules = try std.fs.path.join(manager.allocator, &.{ manager.root_dir, "node_modules" });
        try std.Io.Dir.cwd().createDirPath(manager.init_data.io, node_modules);
        const cache = try std.fs.path.join(manager.allocator, &.{ node_modules, ".cache" });
        try std.Io.Dir.cwd().createDirPath(manager.init_data.io, cache);
    }

    fn loadConfiguration(manager: *Manager) !void {
        var registry = manager.options.registry;
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
            if (parseTomlBool(source, "saveTextLockfile")) |value| manager.save_text_lockfile = value;
            if (parseTomlBool(source, "exact")) |value| manager.options.exact = value;
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
        }

        const selected = registry orelse default_registry;
        manager.registry = if (std.mem.endsWith(u8, selected, "/"))
            try manager.allocator.dupe(u8, selected)
        else
            try std.fmt.allocPrint(manager.allocator, "{s}/", .{selected});
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

            if (isTarballSpec(requested)) {
                const tarball = try manager.installTarball(alias, requested, manager.root_dir, true);
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
            if (!isTarballSpec(requested)) {
                resolved_version = try manager.installDependency(name, requested, manager.root_dir, true, false);
                if (!isLocalSpec(requested)) display_resolution = resolved_version;
            }
            const saved_spec = if (isTarballSpec(requested) or isLocalSpec(requested) or std.mem.startsWith(u8, requested, "workspace:"))
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
            const installed_before = manager.installed_count;
            const resolved_version = manager.installDependency(alias, spec_value.string, parent_dir, direct, optional) catch |err| {
                if (optional) continue;
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
        _ = optional;
        if (direct) {
            for (manager.records.items) |record| {
                if (std.mem.eql(u8, record.alias, alias)) return record.version;
            }
        }
        if (std.mem.startsWith(u8, spec, "workspace:")) {
            const workspace = manager.workspaces.get(alias) orelse return error.WorkspaceNotFound;
            if (!manager.options.lockfile_only) try manager.linkDirectory(alias, workspace.path);
            try manager.addRecord(.{ .alias = alias, .name = workspace.name, .version = workspace.version, .local_path = workspace.path });
            return workspace.version;
        }

        if (isTarballSpec(spec)) {
            const tarball = try manager.installTarball(alias, spec, parent_dir, direct);
            return tarball.version;
        }

        if (isLocalSpec(spec)) {
            const local = try manager.resolveLocalPackage(spec, parent_dir);
            if (!manager.options.lockfile_only) try manager.linkDirectory(alias, local.path);
            try manager.addRecord(.{ .alias = alias, .name = local.name, .version = local.version, .local_path = local.path });
            manager.installed_count += 1;
            try manager.installDependencyObject(local.package_json, "dependencies", local.path, false, false);
            return local.version;
        }

        const registry_name, const registry_spec = parseNpmAlias(alias, spec);
        const cycle_key = try std.fmt.allocPrint(manager.allocator, "{s}@{s}", .{ registry_name, registry_spec });
        if (manager.resolving.contains(cycle_key)) return registry_spec;
        try manager.resolving.put(cycle_key, {});
        defer _ = manager.resolving.remove(cycle_key);

        if (!manager.options.force) {
            if (try manager.findInstalledVersion(alias, spec, parent_dir)) |installed| return installed;
        }

        // Without the parsed lockfile graph Cottontail cannot prove which
        // archive a frozen install selected, so fail before touching disk.
        if (manager.options.frozen_lockfile) return error.FrozenLockfileInstallRequiresLockGraph;

        const resolved = try manager.resolveRegistryPackage(registry_name, registry_spec);
        const destination = try manager.chooseDestination(alias, resolved.version, parent_dir, direct);
        if (!manager.options.lockfile_only and !manager.options.dry_run) {
            const archive = try manager.fetchBytes(resolved.tarball, false, max_tarball_bytes);
            if (manager.options.verify_integrity) try verifyIntegrity(archive, resolved.integrity);
            deletePath(manager.init_data.io, destination);
            try std.Io.Dir.cwd().createDirPath(manager.init_data.io, destination);
            var destination_dir = try std.Io.Dir.cwd().openDir(manager.init_data.io, destination, .{});
            defer destination_dir.close(manager.init_data.io);
            try extractTarballArchive(manager.init_data.io, manager.allocator, destination_dir, archive);
            try manager.linkBins(alias, destination, resolved.metadata, direct);
        }

        try manager.root_versions.put(try manager.allocator.dupe(u8, alias), resolved.version);
        try manager.addRecord(.{
            .alias = alias,
            .name = resolved.name,
            .version = resolved.version,
            .tarball = resolved.tarball,
            .integrity = resolved.integrity orelse "",
        });
        manager.installed_count += 1;
        manager.changed = true;

        try manager.installDependencyObject(@constCast(resolved.metadata), "dependencies", destination, false, false);
        if (!manager.options.omit_optional) {
            try manager.installDependencyObject(@constCast(resolved.metadata), "optionalDependencies", destination, false, true);
        }
        if (!manager.options.omit_peer) {
            try manager.installDependencyObject(@constCast(resolved.metadata), "peerDependencies", destination, false, true);
        }
        return resolved.version;
    }

    fn installTarball(
        manager: *Manager,
        alias_hint: ?[]const u8,
        spec: []const u8,
        parent_dir: []const u8,
        direct: bool,
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
        const destination = try manager.chooseDestination(alias, package_version, parent_dir, direct);

        if (!manager.options.lockfile_only and !manager.options.dry_run) {
            deletePath(manager.init_data.io, destination);
            try std.Io.Dir.cwd().createDirPath(manager.init_data.io, destination);
            var destination_dir = try std.Io.Dir.cwd().openDir(manager.init_data.io, destination, .{});
            defer destination_dir.close(manager.init_data.io);
            try extractTarballArchive(manager.init_data.io, manager.allocator, destination_dir, archive);
            try manager.linkBins(alias, destination, metadata, direct);
        }

        try manager.root_versions.put(try manager.allocator.dupe(u8, alias), package_version);
        try manager.addRecord(.{
            .alias = alias,
            .name = package_name,
            .version = package_version,
            .tarball = spec,
        });
        manager.installed_count += 1;
        manager.changed = true;

        try manager.installDependencyObject(metadata, "dependencies", destination, false, false);
        if (!manager.options.omit_optional) {
            try manager.installDependencyObject(metadata, "optionalDependencies", destination, false, true);
        }
        if (!manager.options.omit_peer) {
            try manager.installDependencyObject(metadata, "peerDependencies", destination, false, true);
        }
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
        if (direct or manager.root_versions.get(alias) == null) {
            return packageDestination(manager.allocator, manager.root_dir, alias);
        }
        if (manager.root_versions.get(alias)) |existing| {
            if (std.mem.eql(u8, existing, version_value)) return packageDestination(manager.allocator, manager.root_dir, alias);
        }
        return packageDestination(manager.allocator, parent_dir, alias);
    }

    fn findInstalledVersion(
        manager: *Manager,
        alias: []const u8,
        spec: []const u8,
        parent_dir: []const u8,
    ) !?[]const u8 {
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
            const value = std.json.parseFromSliceLeaky(Value, manager.allocator, source, .{}) catch continue;
            if (value != .object) continue;
            const version_value = value.object.get("version") orelse continue;
            if (version_value != .string) continue;
            if (semverSatisfies(manager.allocator, spec, version_value.string)) {
                try manager.root_versions.put(try manager.allocator.dupe(u8, alias), version_value.string);
                try manager.addRecord(.{
                    .alias = alias,
                    .name = jsonString(&value, "name") orelse alias,
                    .version = version_value.string,
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
    ) !void {
        if (metadata.* != .object) return;
        const bin_value = metadata.object.get("bin") orelse return;
        const bin_dir = try std.fs.path.join(manager.allocator, &.{ manager.root_dir, "node_modules", ".bin" });
        try std.Io.Dir.cwd().createDirPath(manager.init_data.io, bin_dir);
        if (bin_value == .string) {
            const base_name = if (std.mem.lastIndexOfScalar(u8, alias, '/')) |slash| alias[slash + 1 ..] else alias;
            try manager.linkBin(bin_dir, base_name, package_dir, bin_value.string);
            if (report_direct) try manager.direct_bins.append(base_name);
        } else if (bin_value == .object) {
            for (bin_value.object.keys(), bin_value.object.values()) |name, path_value| {
                if (path_value == .string) {
                    try manager.linkBin(bin_dir, name, package_dir, path_value.string);
                    if (report_direct) try manager.direct_bins.append(name);
                }
            }
        }
    }

    fn linkBin(manager: *Manager, bin_dir: []const u8, name: []const u8, package_dir: []const u8, relative_target: []const u8) !void {
        const target = try std.fs.path.join(manager.allocator, &.{ package_dir, relative_target });
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

    fn installWorkspaceDependencies(manager: *Manager) !void {
        var iterator = manager.workspaces.iterator();
        while (iterator.next()) |entry| {
            const workspace = entry.value_ptr.*;
            if (!manager.options.lockfile_only) try manager.linkDirectory(workspace.name, workspace.path);
            try manager.addRecord(.{
                .alias = workspace.name,
                .name = workspace.name,
                .version = workspace.version,
                .local_path = workspace.path,
            });
            try manager.installDependencyObject(workspace.package_json, "dependencies", workspace.path, true, false);
            if (!manager.options.production) try manager.installDependencyObject(workspace.package_json, "devDependencies", workspace.path, true, false);
        }
    }

    fn addRecord(manager: *Manager, record: PackageRecord) !void {
        for (manager.records.items) |existing| {
            if (std.mem.eql(u8, existing.alias, record.alias) and std.mem.eql(u8, existing.version, record.version)) return;
        }
        try manager.records.append(record);
    }

    fn linkRecordMetadata(manager: *Manager, writer: *std.Io.Writer, record: PackageRecord) !void {
        try writeJSONString(writer, record.alias);
        try writer.writeAll(": [");
        if (record.local_path.len > 0) {
            const relative = std.fs.path.relative(
                manager.allocator,
                manager.root_dir,
                manager.init_data.environ_map,
                manager.root_dir,
                record.local_path,
            ) catch record.local_path;
            const resolution = try std.fmt.allocPrint(manager.allocator, "{s}@workspace:{s}", .{ record.name, relative });
            try writeJSONString(writer, resolution);
        } else {
            const resolution = try std.fmt.allocPrint(manager.allocator, "{s}@{s}", .{ record.name, record.version });
            try writeJSONString(writer, resolution);
            try writer.writeAll(", ");
            try writeJSONString(writer, record.tarball);
            try writer.writeAll(", {}");
            if (record.integrity.len > 0) {
                try writer.writeAll(", ");
                try writeJSONString(writer, record.integrity);
            }
        }
        try writer.writeByte(']');
    }

    fn writeTextLockfile(manager: *Manager, root: *Value) !void {
        if (manager.options.frozen_lockfile and manager.changed) return error.FrozenLockfileChanged;
        if (!manager.save_text_lockfile and !manager.options.silent) {
            try manager.stderr.writeAll("warning: binary bun.lockb output is not available; writing bun.lock\n");
        }
        var output: std.Io.Writer.Allocating = .init(manager.allocator);
        const writer = &output.writer;
        try writer.writeAll("{\n  \"lockfileVersion\": 1,\n  \"workspaces\": {\n    \"\": {");
        if (jsonString(root, "name")) |name| {
            try writer.writeAll("\n      \"name\": ");
            try writeJSONString(writer, name);
            try writer.writeByte(',');
        }
        for (all_dependency_sections) |section_name| {
            if (root.object.get(section_name)) |section| {
                if (section == .object and section.object.count() > 0) {
                    try writer.print("\n      \"{s}\": ", .{section_name});
                    try std.json.Stringify.value(section, .{ .whitespace = .indent_2 }, writer);
                    try writer.writeByte(',');
                }
            }
        }
        try writer.writeAll("\n    },\n  },\n  \"packages\": {");
        for (manager.records.items, 0..) |record, index| {
            try writer.writeAll(if (index == 0) "\n    " else ",\n\n    ");
            try manager.linkRecordMetadata(writer, record);
        }
        if (manager.records.items.len > 0) try writer.writeByte(',');
        try writer.writeAll("\n  }\n}\n");

        // COTTONTAIL-COMPAT: Cottontail owns the text format end-to-end. Binary
        // bun.lockb serialization remains isolated in the vendored Bun source
        // until its lockfile graph can be shared without Bun's global state.
        const lockfile_path = try std.fs.path.join(manager.allocator, &.{ manager.root_dir, "bun.lock" });
        try std.Io.Dir.cwd().writeFile(manager.init_data.io, .{ .sub_path = lockfile_path, .data = output.written() });
        if (manager.changed and !manager.options.silent) try manager.stderr.writeAll("Saved lockfile\n");
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

    fn runRootLifecycleScripts(manager: *Manager, root: *Value) !void {
        if (root.* != .object) return;
        const scripts = root.object.get("scripts") orelse return;
        if (scripts != .object) return;
        for (lifecycle_stages) |stage| {
            const command_value = scripts.object.get(stage) orelse continue;
            if (command_value != .string) continue;
            const shell_args: []const []const u8 = if (builtin.os.tag == .windows)
                &.{ "cmd.exe", "/d", "/s", "/c", command_value.string }
            else
                &.{ "/bin/sh", "-c", command_value.string };
            var child = try std.process.spawn(manager.init_data.io, .{
                .argv = shell_args,
                .cwd = .{ .path = manager.root_dir },
                .environ_map = manager.init_data.environ_map,
                .stdin = .inherit,
                .stdout = .inherit,
                .stderr = .inherit,
                .create_no_window = true,
            });
            defer child.kill(manager.init_data.io);
            const result = try child.wait(manager.init_data.io);
            const exit_code: u8 = switch (result) {
                .exited => |code| @intCast(@min(code, 255)),
                else => 1,
            };
            if (exit_code != 0) return error.LifecycleScriptFailed;
        }
    }
};

fn splitPackageSpec(input: []const u8) PackageSpec {
    if (isTarballSpec(input) or isLocalSpec(input) or std.mem.startsWith(u8, input, "http://") or std.mem.startsWith(u8, input, "https://")) {
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

fn hasUnknownURLScheme(spec: []const u8) bool {
    const scheme = std.mem.indexOf(u8, spec, "://") orelse return false;
    if (scheme == 0) return true;
    return !std.mem.startsWith(u8, spec, "http://") and
        !std.mem.startsWith(u8, spec, "https://") and
        !std.mem.startsWith(u8, spec, "file://") and
        !std.mem.startsWith(u8, spec, "git://");
}

fn packageDestination(allocator: std.mem.Allocator, base: []const u8, alias: []const u8) ![]const u8 {
    return std.fs.path.join(allocator, &.{ base, "node_modules", alias });
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
