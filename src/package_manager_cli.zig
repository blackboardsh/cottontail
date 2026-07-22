const std = @import("std");
const builtin = @import("builtin");
const compiler = @import("cottontail_compiler");
const Lockfile = @import("package_manager_lockfile.zig");
const LockfileMigration = @import("package_manager_lockfile_migration.zig");
const Manifest = @import("package_manager_manifest.zig");
const Scripts = @import("package_manager_scripts.zig");
const Git = @import("package_manager_git.zig");
const Patch = @import("package_manager_patch.zig");
const BunLockfile = @import("package_manager_bun_lockfile.zig");
const PmPkg = @import("package_manager_pm_pkg.zig");
const PmInfo = @import("package_manager_pm_info.zig");
const PmVersion = @import("package_manager_pm_version.zig");
const PmWhy = @import("package_manager_pm_why.zig");
const PmTrusted = @import("package_manager_pm_trusted.zig");
const Isolated = @import("package_manager_isolated.zig");
const Workspaces = @import("package_manager_workspaces.zig");
const Analyzer = @import("package_manager_analyzer.zig");
const Audit = @import("package_manager_audit.zig");
const MinimumReleaseAge = @import("package_manager_minimum_release_age.zig");
const PackageJSON = @import("package_manager_json.zig");
const Pack = @import("package_manager_pack.zig");
const ScriptRunner = @import("script_runner.zig");
const Publish = @import("package_manager_publish.zig");
const DistTag = @import("package_manager_dist_tag.zig");

const version = @import("version.zig").version;
const Semver = compiler.Semver;
const Npm = compiler.install.Npm;
const Value = std.json.Value;

// Keep this aligned with compat/upstream/targets.json. Package-manager output
// identifies the Bun contract separately from the Cottontail release.
const bun_compat_version = "1.3.10";
const manifest_accept = "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*";
const extended_manifest_accept = "application/json";
const default_registry = "https://registry.npmjs.org/";
const max_manifest_bytes = 64 * 1024 * 1024;
const max_tarball_bytes = 512 * 1024 * 1024;
const security_resolution_output_env = "COTTONTAIL_PM_SECURITY_RESOLUTION_OUTPUT";
const all_dependency_sections = [_][]const u8{ "dependencies", "devDependencies", "optionalDependencies", "peerDependencies" };
const mutable_dependency_sections = [_][]const u8{ "dependencies", "devDependencies", "optionalDependencies" };
const runtime_dependency_sections = [_][]const u8{ "dependencies", "optionalDependencies" };

const Command = enum {
    audit,
    install,
    add,
    remove,
    update,
    outdated,
    link,
    unlink,
    patch,
    patch_commit,
    publish,
    pm,
    pm_list,
    pm_info,
    pm_whoami,
    pm_why,
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

const UpdateDependencySection = struct {
    name: []const u8,
    optional: bool = false,
};

// This is Bun's install/update precedence. When a dependency is declared in
// more than one group, only the first declaration is updated.
const update_dependency_sections = [_]UpdateDependencySection{
    .{ .name = "optionalDependencies", .optional = true },
    .{ .name = "devDependencies" },
    .{ .name = "dependencies" },
    .{ .name = "peerDependencies" },
};

const Options = struct {
    command: Command,
    positionals: []const []const u8,
    original_args: []const [:0]const u8 = &.{},
    cwd: ?[]const u8 = null,
    config_path: ?[]const u8 = null,
    filters: []const []const u8 = &.{},
    registry: ?[]const u8 = null,
    ca: []const []const u8 = &.{},
    ca_file_name: ?[]const u8 = null,
    global: bool = false,
    production: bool = false,
    ignore_scripts: bool = false,
    trust: bool = false,
    lockfile_only: bool = false,
    frozen_lockfile: bool = false,
    no_save: bool = false,
    exact: bool = false,
    only_missing: bool = false,
    analyze: bool = false,
    force: bool = false,
    dry_run: bool = false,
    silent: bool = false,
    no_summary: bool = false,
    no_cache: bool = false,
    verbose: bool = false,
    verify_integrity: bool = true,
    latest: bool = false,
    interactive: bool = false,
    recursive: bool = false,
    save_text_lockfile: bool = false,
    save_yarn_lockfile: bool = false,
    omit_dev: bool = false,
    omit_optional: bool = false,
    omit_peer: bool = false,
    help: bool = false,
    all: bool = false,
    json_output: bool = false,
    git_tag_version: bool = true,
    allow_same_version: bool = false,
    message: ?[]const u8 = null,
    preid: []const u8 = "",
    top_only: bool = false,
    depth: ?usize = null,
    patches_dir: []const u8 = "patches",
    linker: ?Isolated.Linker = null,
    section: DependencySection = .dependencies,
    cpu: Npm.Architecture = .current,
    os: Npm.OperatingSystem = .current,
    cpu_overridden: bool = false,
    os_overridden: bool = false,
    invalid_cpu: ?[]const u8 = null,
    invalid_os: ?[]const u8 = null,
    minimum_release_age_ms: ?f64 = null,
    minimum_release_age_cli: bool = false,
    concurrent_scripts: ?usize = null,
    concurrent_scripts_cli: bool = false,
    network_concurrency: ?usize = null,
    invalid_network_concurrency: ?[]const u8 = null,
    pack_destination: ?[]const u8 = null,
    pack_filename: ?[]const u8 = null,
    pack_gzip_level: ?[]const u8 = null,
    publish_access: ?Publish.Access = null,
    publish_tag: []const u8 = "",
    publish_otp: []const u8 = "",
    publish_auth_type: ?Publish.AuthType = null,
    tolerate_republish: bool = false,
    invalid_publish_access: ?[]const u8 = null,
    invalid_publish_auth_type: ?[]const u8 = null,
    registry_auth_option_used: bool = false,
};

const PackageSpec = struct {
    name: ?[]const u8,
    spec: []const u8,
};

const UpdateRequest = struct {
    alias: ?[]const u8,
    spec: ?[]const u8,
};

const UpdateResult = struct {
    alias: []const u8,
    resolved_version: []const u8,
    saved_spec: []const u8,
    previous_version: ?[]const u8,
};

const InteractiveUpdatePackage = struct {
    alias: []const u8,
    current_version: []const u8,
    target_version: []const u8,
    latest_version: []const u8,
    dependency_type: []const u8,
    spec_value: *Value,
    manifest: *Value,
    manifest_dir: []const u8,
    selected: bool = false,
    use_latest: bool = false,
};

const InteractiveChangedManifest = struct {
    package_json: *Value,
    path: []const u8,
    had_trailing_newline: bool,
};

const InteractivePromptResult = enum { selected, empty, cancelled };

const OutdatedPackage = struct {
    alias: []const u8,
    current_version: []const u8,
    update_version: []const u8,
    latest_version: []const u8,
    dependency_type: []const u8,
    workspace_name: []const u8,
    catalog_name: ?[]const u8,
    update_filtered: bool,
    latest_filtered: bool,
};

const RenderedOutdatedPackage = struct {
    package: OutdatedPackage,
    workspace_display: []const u8,
};

const InteractiveTerminalMode = if (builtin.os.tag == .windows) struct {
    is_tty: bool = false,

    fn enter() @This() {
        return .{};
    }

    fn restore(_: @This()) void {}
} else struct {
    saved: ?std.posix.termios = null,
    is_tty: bool = false,

    fn enter() @This() {
        const saved = std.posix.tcgetattr(0) catch return .{};
        var raw = saved;
        raw.lflag.ICANON = false;
        raw.lflag.ECHO = false;
        raw.lflag.ISIG = false;
        raw.lflag.IEXTEN = false;
        raw.cc[@intFromEnum(std.posix.V.MIN)] = 1;
        raw.cc[@intFromEnum(std.posix.V.TIME)] = 0;
        std.posix.tcsetattr(0, .NOW, raw) catch return .{};
        return .{ .saved = saved, .is_tty = true };
    }

    fn restore(mode: @This()) void {
        if (mode.saved) |saved| std.posix.tcsetattr(0, .NOW, saved) catch {};
    }
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

const GitCheckoutResult = struct {
    checkout: Git.Checkout,
    integrity: []const u8 = "",
    resolved_name: []const u8 = "",
};

const RegistryPackage = struct {
    name: []const u8,
    version: []const u8,
    latest_version: ?[]const u8,
    tarball: []const u8,
    integrity: ?[]const u8,
    metadata: *const Value,
    authorization: ?[]const u8 = null,
    age_filtered: bool = false,

    fn archive(package: RegistryPackage) RegistryArchive {
        return .{
            .name = package.name,
            .version = package.version,
            .tarball = package.tarball,
            .integrity = package.integrity,
            .authorization = package.authorization,
        };
    }
};

const RegistryArchive = struct {
    name: []const u8,
    version: []const u8,
    tarball: []const u8,
    integrity: ?[]const u8,
    authorization: ?[]const u8 = null,
};

const RegistryConfig = struct {
    url: []const u8,
    source_url: ?[]const u8 = null,
    authorization: ?[]const u8 = null,
};

const FetchLogLevel = enum {
    err,
    warn,

    fn label(level: FetchLogLevel) []const u8 {
        return switch (level) {
            .err => "error",
            .warn => "warn",
        };
    }
};

fn packageManagerFetchErrorName(err: anyerror) []const u8 {
    return switch (err) {
        // COTTONTAIL-COMPAT: Zig's HTTP client collapses TLS certificate
        // verification failures into TlsInitializationFailed at its TCP/TLS
        // boundary. Bun exposes this untrusted-registry condition with its
        // certificate-specific error code.
        error.TlsCertificateNotVerified, error.TlsInitializationFailed => "DEPTH_ZERO_SELF_SIGNED_CERT",
        else => @errorName(err),
    };
}

const RegistryManifestFetch = struct {
    io: std.Io,
    environment: *const std.process.Environ.Map,
    name: []const u8,
    url: []const u8,
    authorization: ?[]const u8,
    cache_path: ?[]const u8,
    accept: []const u8,
    bytes: ?[]u8 = null,
    failure: ?anyerror = null,

    fn run(fetch_state: *RegistryManifestFetch) std.Io.Cancelable!void {
        fetch_state.fetch() catch |err| {
            if (err == error.Canceled) return error.Canceled;
            fetch_state.failure = err;
        };
    }

    fn fetch(fetch_state: *RegistryManifestFetch) !void {
        var client: std.http.Client = .{ .allocator = std.heap.smp_allocator, .io = fetch_state.io };
        defer client.deinit();
        client.initDefaultProxies(std.heap.smp_allocator, fetch_state.environment) catch {};

        var headers: [3]std.http.Header = undefined;
        var header_count: usize = 0;
        headers[header_count] = .{ .name = "accept", .value = fetch_state.accept };
        header_count += 1;
        if (fetch_state.authorization) |authorization| {
            headers[header_count] = .{ .name = "authorization", .value = authorization };
            header_count += 1;
            headers[header_count] = .{ .name = "npm-auth-type", .value = "legacy" };
            header_count += 1;
        }

        var output: std.Io.Writer.Allocating = .init(std.heap.smp_allocator);
        defer output.deinit();
        const result = try client.fetch(.{
            .location = .{ .url = fetch_state.url },
            .response_writer = &output.writer,
            .extra_headers = headers[0..header_count],
        });
        const status: u16 = @intFromEnum(result.status);
        if (status < 200 or status >= 300) return error.RegistryManifestRequestFailed;
        if (output.written().len > max_manifest_bytes) return error.ResponseTooLarge;
        fetch_state.bytes = try output.toOwnedSlice();
    }
};

const RegistryArchiveFetch = struct {
    io: std.Io,
    environment: *const std.process.Environ.Map,
    url: []const u8,
    authorization: ?[]const u8,
    integrity: ?[]const u8,
    verify_integrity: bool,
    cache_path: []const u8,
    failure: ?anyerror = null,
    fetched: bool = false,

    fn run(fetch_state: *RegistryArchiveFetch) std.Io.Cancelable!void {
        fetch_state.fetch() catch |err| {
            if (err == error.Canceled) return error.Canceled;
            fetch_state.failure = err;
        };
    }

    fn fetch(fetch_state: *RegistryArchiveFetch) !void {
        if (std.Io.Dir.cwd().readFileAlloc(
            fetch_state.io,
            fetch_state.cache_path,
            std.heap.smp_allocator,
            .limited(max_tarball_bytes),
        ) catch null) |cached| {
            defer std.heap.smp_allocator.free(cached);
            const valid = if (fetch_state.verify_integrity) blk: {
                verifyIntegrity(cached, fetch_state.integrity) catch break :blk false;
                break :blk true;
            } else true;
            if (valid) return;
            std.Io.Dir.cwd().deleteFile(fetch_state.io, fetch_state.cache_path) catch {};
        }

        var client: std.http.Client = .{ .allocator = std.heap.smp_allocator, .io = fetch_state.io };
        defer client.deinit();
        client.initDefaultProxies(std.heap.smp_allocator, fetch_state.environment) catch {};
        fetch_state.fetched = true;

        var headers: [1]std.http.Header = undefined;
        const header_count: usize = if (fetch_state.authorization) |authorization| blk: {
            headers[0] = .{ .name = "authorization", .value = authorization };
            break :blk 1;
        } else 0;

        var output: std.Io.Writer.Allocating = .init(std.heap.smp_allocator);
        defer output.deinit();
        const result = try client.fetch(.{
            .location = .{ .url = fetch_state.url },
            .response_writer = &output.writer,
            .extra_headers = headers[0..header_count],
        });
        const status: u16 = @intFromEnum(result.status);
        if (status < 200 or status >= 300) return error.RegistryArchiveRequestFailed;
        if (output.written().len > max_tarball_bytes) return error.ResponseTooLarge;
        if (fetch_state.verify_integrity) try verifyIntegrity(output.written(), fetch_state.integrity);
        try std.Io.Dir.cwd().writeFile(fetch_state.io, .{
            .sub_path = fetch_state.cache_path,
            .data = output.written(),
        });
    }
};

const RegistryDependencyRequest = struct {
    name: []const u8,
    spec: []const u8,
    optional: bool,
};

const DirectInstallReport = struct {
    alias: []const u8,
    display: []const u8,
    latest_version: ?[]const u8,
    section_priority: u8,
    sequence: usize,
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
    git_resolved: []const u8 = "",
    peer_hash: u64 = 0,
    install_dir: []const u8 = "",
};

const InstalledIsolatedDependency = struct {
    alias: []const u8,
    spec: []const u8,
};

const Workspace = Workspaces.Entry;

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

const IsolatedSourceContext = struct {
    source_dir: []const u8,
    previous_modules: ?[]const u8,
    previous_key: ?[]const u8,
    active: bool,
};

const ReconciledRecord = struct {
    context: Isolated.PeerContext,
    placement: ?Isolated.Placement,
    old_package_dir: []const u8,
    package_dir: []const u8,
    modules_dir: []const u8,
};

pub fn recognizes(command: []const u8) bool {
    return commandFromString(command) != null;
}

fn commandFromString(command: []const u8) ?Command {
    if (std.mem.eql(u8, command, "audit")) return .audit;
    if (std.mem.eql(u8, command, "install") or std.mem.eql(u8, command, "i") or std.mem.eql(u8, command, "ci")) return .install;
    if (std.mem.eql(u8, command, "add") or std.mem.eql(u8, command, "a")) return .add;
    if (std.mem.eql(u8, command, "remove") or std.mem.eql(u8, command, "rm") or std.mem.eql(u8, command, "uninstall")) return .remove;
    if (std.mem.eql(u8, command, "update") or std.mem.eql(u8, command, "up")) return .update;
    if (std.mem.eql(u8, command, "outdated")) return .outdated;
    if (std.mem.eql(u8, command, "link")) return .link;
    if (std.mem.eql(u8, command, "unlink")) return .unlink;
    if (std.mem.eql(u8, command, "patch")) return .patch;
    if (std.mem.eql(u8, command, "patch-commit")) return .patch_commit;
    if (std.mem.eql(u8, command, "publish")) return .publish;
    if (std.mem.eql(u8, command, "pm")) return .pm;
    if (std.mem.eql(u8, command, "list")) return .pm_list;
    if (std.mem.eql(u8, command, "info")) return .pm_info;
    if (std.mem.eql(u8, command, "whoami")) return .pm_whoami;
    if (std.mem.eql(u8, command, "why")) return .pm_why;
    return null;
}

fn commandUsesSecurityScanner(command: Command) bool {
    return switch (command) {
        .install, .add, .remove, .update, .link => true,
        .audit, .outdated, .unlink, .patch, .patch_commit, .publish, .pm, .pm_list, .pm_info, .pm_whoami, .pm_why => false,
    };
}

fn packageManagerChildExitCode(term: std.process.Child.Term) u8 {
    return switch (term) {
        .exited => |code| @intCast(@min(code, 255)),
        else => 1,
    };
}

pub fn run(
    init: std.process.Init,
    args: []const [:0]const u8,
    stdout: *std.Io.Writer,
    stderr: *std.Io.Writer,
) !u8 {
    if (args.len >= 2 and std.mem.eql(u8, args[1], "audit")) {
        return Audit.run(init, args, stdout, stderr);
    }
    const allocator = init.arena.allocator();
    const options = parseOptions(allocator, args) catch |err| {
        switch (err) {
            error.TrustWithProductionUnsupported => try stderr.writeAll(
                "error: The '--production' and '--trust' flags together are not supported because the --trust flag potentially modifies the lockfile after installing packages\n",
            ),
            error.TrustWithFrozenLockfileUnsupported => try stderr.writeAll(
                "error: The '--frozen-lockfile' and '--trust' flags together are not supported because the --trust flag potentially modifies the lockfile after installing packages\n",
            ),
            else => try stderr.print("error: {s}\n", .{@errorName(err)}),
        }
        try stderr.flush();
        return 1;
    };

    if (options.invalid_network_concurrency) |value| {
        try stderr.print(
            "error: Expected --network-concurrency to be a number between 0 and 65535: {s}\n",
            .{value},
        );
        try stderr.flush();
        return 1;
    }

    if (options.invalid_cpu) |value| {
        try stderr.print("error: Invalid CPU architecture: '{s}'. Valid values are: *, any, arm, arm64, ia32, mips, mipsel, ppc, ppc64, s390, s390x, x32, x64. Use !name to negate.\n", .{value});
        try stderr.flush();
        return 1;
    }
    if (options.invalid_os) |value| {
        try stderr.print("error: Invalid operating system: '{s}'. Valid values are: *, any, aix, darwin, freebsd, linux, openbsd, sunos, win32, android. Use !name to negate.\n", .{value});
        try stderr.flush();
        return 1;
    }
    if (options.invalid_publish_access) |value| {
        try stderr.print("error: invalid `access` value: '{s}'\n", .{value});
        try stderr.flush();
        return 1;
    }
    if (options.invalid_publish_auth_type) |value| {
        try stderr.print("error: invalid `auth-type` value: '{s}'\n", .{value});
        try stderr.flush();
        return 1;
    }

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

    if (options.command == .publish) return runPublish(init, options, stdout, stderr);

    if (options.command == .pm and
        options.positionals.len > 0 and
        std.mem.eql(u8, options.positionals[0], "scan"))
    {
        var manager = Manager.init(init, options, stdout, stderr);
        defer manager.deinit();
        return manager.executeSecurityScan() catch |err| {
            if (err != error.PackageManagerErrorReported) {
                try stderr.print("error: {s}\n", .{@errorName(err)});
            }
            try stderr.flush();
            return 1;
        };
    }

    if (options.command == .pm or options.command == .pm_list or options.command == .pm_info or options.command == .pm_whoami or options.command == .pm_why) {
        return try runPm(init, options, stdout, stderr);
    }

    var manager = Manager.init(init, options, stdout, stderr);
    defer manager.deinit();
    return manager.execute() catch |err| {
        if (init.environ_map.get("COTTONTAIL_PM_ERROR_TRACE") != null) {
            if (@errorReturnTrace()) |trace| std.debug.dumpErrorReturnTrace(trace);
        }
        if (err == error.FrozenLockfileChanged or err == error.FrozenLockfilePackageMissing) {
            try stderr.writeAll("error: lockfile had changes, but lockfile is frozen\n");
        } else if (err == error.FrozenLockfileNotFound) {
            try stderr.writeAll("error: lockfile not found, but lockfile is frozen\n");
        } else if (err == error.IntegrityCheckFailed) {
            try stderr.writeAll("error: Integrity check failed\n");
        } else if (err == error.NPMLockfileVersionMismatch) {
            try stderr.writeAll(
                "error: Please upgrade package-lock.json to lockfileVersion 2 or 3\n" ++
                    "Run 'npm i --lockfile-version 3 --frozen-lockfile' to upgrade your lockfile without changing dependencies.\n",
            );
        } else if (err == error.BinaryLockfileReadUnsupported) {
            try stderr.writeAll(
                "error: reading bun.lockb requires Bun's packed Lockfile.Buffers, Package.Serializer, and global string/semver stores; use bun.lock\n",
            );
        } else if (err == error.BinaryLockfileWriteUnsupported) {
            try stderr.writeAll(
                "error: writing bun.lockb requires Bun's packed Lockfile.Buffers and Package.Serializer; use --save-text-lockfile\n",
            );
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
        .original_args = args,
        .frozen_lockfile = std.mem.eql(u8, args[1], "ci"),
    };
    var positionals = std.array_list.Managed([]const u8).init(allocator);
    var filters = std.array_list.Managed([]const u8).init(allocator);
    var certificate_authorities = std.array_list.Managed([]const u8).init(allocator);
    var cpu_override = Npm.Architecture.none.negatable();
    var os_override = Npm.OperatingSystem.none.negatable();

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
        } else if (std.mem.startsWith(u8, arg, "-c=")) {
            options.config_path = arg["-c=".len..];
        } else if (std.mem.eql(u8, arg, "--filter")) {
            index += 1;
            if (index >= args.len) return error.MissingOptionValue;
            try filters.append(args[index]);
        } else if (std.mem.startsWith(u8, arg, "--filter=")) {
            const value = arg["--filter=".len..];
            if (value.len == 0) return error.MissingOptionValue;
            try filters.append(value);
        } else if (std.mem.eql(u8, arg, "--registry")) {
            index += 1;
            if (index >= args.len) return error.MissingRegistry;
            options.registry = args[index];
        } else if (std.mem.startsWith(u8, arg, "--registry=")) {
            options.registry = arg["--registry=".len..];
        } else if (std.mem.eql(u8, arg, "--ca")) {
            index += 1;
            if (index >= args.len) return error.MissingOptionValue;
            try certificate_authorities.append(args[index]);
        } else if (std.mem.startsWith(u8, arg, "--ca=")) {
            const value = arg["--ca=".len..];
            if (value.len == 0) return error.MissingOptionValue;
            try certificate_authorities.append(value);
        } else if (std.mem.eql(u8, arg, "--cafile")) {
            index += 1;
            if (index >= args.len) return error.MissingOptionValue;
            options.ca_file_name = args[index];
        } else if (std.mem.startsWith(u8, arg, "--cafile=")) {
            const value = arg["--cafile=".len..];
            if (value.len == 0) return error.MissingOptionValue;
            options.ca_file_name = value;
        } else if (std.mem.eql(u8, arg, "--cpu")) {
            index += 1;
            if (index >= args.len) return error.MissingOptionValue;
            options.cpu_overridden = true;
            if (!applyPlatformOverride(Npm.Architecture, &cpu_override, args[index])) options.invalid_cpu = args[index];
        } else if (std.mem.startsWith(u8, arg, "--cpu=")) {
            const value = arg["--cpu=".len..];
            if (value.len == 0) return error.MissingOptionValue;
            options.cpu_overridden = true;
            if (!applyPlatformOverride(Npm.Architecture, &cpu_override, value)) options.invalid_cpu = value;
        } else if (std.mem.eql(u8, arg, "--os")) {
            index += 1;
            if (index >= args.len) return error.MissingOptionValue;
            options.os_overridden = true;
            if (!applyPlatformOverride(Npm.OperatingSystem, &os_override, args[index])) options.invalid_os = args[index];
        } else if (std.mem.startsWith(u8, arg, "--os=")) {
            const value = arg["--os=".len..];
            if (value.len == 0) return error.MissingOptionValue;
            options.os_overridden = true;
            if (!applyPlatformOverride(Npm.OperatingSystem, &os_override, value)) options.invalid_os = value;
        } else if (std.mem.eql(u8, arg, "--global") or std.mem.eql(u8, arg, "-g")) {
            if (options.command != .install and options.command != .add) return error.InvalidPackageManagerOption;
            options.global = true;
        } else if (std.mem.eql(u8, arg, "--production") or std.mem.eql(u8, arg, "--prod") or std.mem.eql(u8, arg, "-p") or std.mem.eql(u8, arg, "-P")) {
            options.production = true;
        } else if (std.mem.eql(u8, arg, "--ignore-scripts")) {
            options.ignore_scripts = true;
        } else if (std.mem.eql(u8, arg, "--concurrent-scripts")) {
            index += 1;
            if (index >= args.len) return error.MissingOptionValue;
            options.concurrent_scripts = try parseConcurrentScripts(args[index]);
            options.concurrent_scripts_cli = true;
        } else if (std.mem.startsWith(u8, arg, "--concurrent-scripts=")) {
            const value = arg["--concurrent-scripts=".len..];
            if (value.len == 0) return error.MissingOptionValue;
            options.concurrent_scripts = try parseConcurrentScripts(value);
            options.concurrent_scripts_cli = true;
        } else if (std.mem.eql(u8, arg, "--trust")) {
            options.trust = true;
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
        } else if (std.mem.eql(u8, arg, "--analyze") or
            (std.mem.eql(u8, arg, "-a") and (options.command == .add or options.command == .install)))
        {
            options.analyze = true;
        } else if (std.mem.eql(u8, arg, "--force") or std.mem.eql(u8, arg, "-f")) {
            options.force = true;
        } else if (std.mem.eql(u8, arg, "--dry-run")) {
            options.dry_run = true;
        } else if (std.mem.eql(u8, arg, "--destination")) {
            index += 1;
            if (index >= args.len) return error.MissingOptionValue;
            options.pack_destination = args[index];
        } else if (std.mem.startsWith(u8, arg, "--destination=")) {
            options.pack_destination = arg["--destination=".len..];
        } else if (std.mem.eql(u8, arg, "--filename")) {
            index += 1;
            if (index >= args.len) return error.MissingOptionValue;
            options.pack_filename = args[index];
        } else if (std.mem.startsWith(u8, arg, "--filename=")) {
            options.pack_filename = arg["--filename=".len..];
        } else if (std.mem.eql(u8, arg, "--gzip-level")) {
            index += 1;
            if (index >= args.len) return error.MissingOptionValue;
            options.pack_gzip_level = args[index];
        } else if (std.mem.startsWith(u8, arg, "--gzip-level=")) {
            options.pack_gzip_level = arg["--gzip-level=".len..];
        } else if (std.mem.eql(u8, arg, "--access")) {
            if (options.command != .publish) return error.InvalidPackageManagerOption;
            index += 1;
            if (index >= args.len) return error.MissingOptionValue;
            options.publish_access = Publish.Access.parse(args[index]);
            if (options.publish_access == null) options.invalid_publish_access = args[index];
        } else if (std.mem.startsWith(u8, arg, "--access=")) {
            if (options.command != .publish) return error.InvalidPackageManagerOption;
            const value = arg["--access=".len..];
            if (value.len == 0) return error.MissingOptionValue;
            options.publish_access = Publish.Access.parse(value);
            if (options.publish_access == null) options.invalid_publish_access = value;
        } else if (std.mem.eql(u8, arg, "--tag")) {
            if (options.command != .publish) return error.InvalidPackageManagerOption;
            index += 1;
            if (index >= args.len) return error.MissingOptionValue;
            if (args[index].len == 0) return error.MissingOptionValue;
            options.publish_tag = args[index];
        } else if (std.mem.startsWith(u8, arg, "--tag=")) {
            if (options.command != .publish) return error.InvalidPackageManagerOption;
            const value = arg["--tag=".len..];
            if (value.len == 0) return error.MissingOptionValue;
            options.publish_tag = value;
        } else if (std.mem.eql(u8, arg, "--otp")) {
            if (options.command != .publish and options.command != .pm) return error.InvalidPackageManagerOption;
            index += 1;
            if (index >= args.len) return error.MissingOptionValue;
            options.publish_otp = args[index];
            options.registry_auth_option_used = true;
        } else if (std.mem.startsWith(u8, arg, "--otp=")) {
            if (options.command != .publish and options.command != .pm) return error.InvalidPackageManagerOption;
            options.publish_otp = arg["--otp=".len..];
            options.registry_auth_option_used = true;
        } else if (std.mem.eql(u8, arg, "--auth-type")) {
            if (options.command != .publish and options.command != .pm) return error.InvalidPackageManagerOption;
            index += 1;
            if (index >= args.len) return error.MissingOptionValue;
            options.publish_auth_type = Publish.AuthType.parse(args[index]);
            if (options.publish_auth_type == null) options.invalid_publish_auth_type = args[index];
            options.registry_auth_option_used = true;
        } else if (std.mem.startsWith(u8, arg, "--auth-type=")) {
            if (options.command != .publish and options.command != .pm) return error.InvalidPackageManagerOption;
            const value = arg["--auth-type=".len..];
            if (value.len == 0) return error.MissingOptionValue;
            options.publish_auth_type = Publish.AuthType.parse(value);
            if (options.publish_auth_type == null) options.invalid_publish_auth_type = value;
            options.registry_auth_option_used = true;
        } else if (std.mem.eql(u8, arg, "--tolerate-republish")) {
            if (options.command != .publish) return error.InvalidPackageManagerOption;
            options.tolerate_republish = true;
        } else if (std.mem.eql(u8, arg, "--silent") or std.mem.eql(u8, arg, "--quiet")) {
            options.silent = true;
        } else if (std.mem.eql(u8, arg, "--verbose")) {
            options.verbose = true;
        } else if (std.mem.eql(u8, arg, "--minimum-release-age")) {
            index += 1;
            if (index >= args.len) return error.MissingOptionValue;
            options.minimum_release_age_ms = try parseMinimumReleaseAge(args[index]);
            options.minimum_release_age_cli = true;
        } else if (std.mem.startsWith(u8, arg, "--minimum-release-age=")) {
            const value = arg["--minimum-release-age=".len..];
            if (value.len == 0) return error.MissingOptionValue;
            options.minimum_release_age_ms = try parseMinimumReleaseAge(value);
            options.minimum_release_age_cli = true;
        } else if (std.mem.eql(u8, arg, "--network-concurrency")) {
            index += 1;
            if (index >= args.len) return error.MissingOptionValue;
            options.network_concurrency = parseNetworkConcurrency(args[index]) catch invalid: {
                options.invalid_network_concurrency = args[index];
                break :invalid null;
            };
        } else if (std.mem.startsWith(u8, arg, "--network-concurrency=")) {
            const value = arg["--network-concurrency=".len..];
            options.network_concurrency = parseNetworkConcurrency(value) catch invalid: {
                options.invalid_network_concurrency = value;
                break :invalid null;
            };
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
        } else if (std.mem.eql(u8, arg, "--interactive") or std.mem.eql(u8, arg, "-i")) {
            if (options.command != .update) return error.InvalidPackageManagerOption;
            options.interactive = true;
        } else if (std.mem.eql(u8, arg, "--recursive") or std.mem.eql(u8, arg, "-r")) {
            if (options.command != .update and options.command != .outdated) return error.InvalidPackageManagerOption;
            options.recursive = true;
        } else if (std.mem.eql(u8, arg, "--all") or std.mem.eql(u8, arg, "-a") or std.mem.eql(u8, arg, "-A")) {
            options.all = true;
        } else if (std.mem.eql(u8, arg, "--json")) {
            options.json_output = true;
        } else if (std.mem.eql(u8, arg, "--no-git-tag-version") or std.mem.eql(u8, arg, "--git-tag-version=false")) {
            options.git_tag_version = false;
        } else if (std.mem.eql(u8, arg, "--git-tag-version=true")) {
            options.git_tag_version = true;
        } else if (std.mem.eql(u8, arg, "--allow-same-version")) {
            options.allow_same_version = true;
        } else if (std.mem.eql(u8, arg, "--message") or std.mem.eql(u8, arg, "-m")) {
            index += 1;
            if (index >= args.len) return error.MissingOptionValue;
            options.message = args[index];
        } else if (std.mem.startsWith(u8, arg, "--message=")) {
            options.message = arg["--message=".len..];
        } else if (std.mem.eql(u8, arg, "--preid")) {
            index += 1;
            if (index >= args.len) return error.MissingOptionValue;
            options.preid = args[index];
        } else if (std.mem.startsWith(u8, arg, "--preid=")) {
            options.preid = arg["--preid=".len..];
        } else if (std.mem.eql(u8, arg, "--top")) {
            options.top_only = true;
        } else if (std.mem.eql(u8, arg, "--depth")) {
            index += 1;
            if (index >= args.len) return error.MissingOptionValue;
            options.depth = std.fmt.parseInt(usize, args[index], 10) catch return error.InvalidDepth;
        } else if (std.mem.startsWith(u8, arg, "--depth=")) {
            options.depth = std.fmt.parseInt(usize, arg["--depth=".len..], 10) catch return error.InvalidDepth;
        } else if (std.mem.eql(u8, arg, "--save-text-lockfile")) {
            options.save_text_lockfile = true;
        } else if (std.mem.eql(u8, arg, "--yarn")) {
            options.save_yarn_lockfile = true;
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
        } else if (std.mem.eql(u8, arg, "--no-cache")) {
            options.no_cache = true;
        } else if (std.mem.eql(u8, arg, "--no-progress")) {
            // The package manager has no progress UI.
        } else if (std.mem.eql(u8, arg, "--help") or std.mem.eql(u8, arg, "-h")) {
            options.help = true;
        } else {
            return error.UnknownPackageManagerOption;
        }
    }
    options.positionals = try positionals.toOwnedSlice();
    options.filters = try filters.toOwnedSlice();
    options.ca = try certificate_authorities.toOwnedSlice();
    if (options.cpu_overridden) options.cpu = cpu_override.combine();
    if (options.os_overridden) options.os = os_override.combine();
    if ((options.command == .patch or options.command == .patch_commit) and options.positionals.len == 0) {
        return error.MissingPatchTarget;
    }
    if (options.command == .pm and options.registry_auth_option_used and
        (options.positionals.len == 0 or
            (!std.mem.eql(u8, options.positionals[0], "dist-tag") and
                !std.mem.eql(u8, options.positionals[0], "dist-tags"))))
    {
        return error.InvalidPackageManagerOption;
    }
    if (options.trust and options.command != .install and options.command != .add) {
        return error.InvalidPackageManagerOption;
    }
    if (options.trust and options.production) return error.TrustWithProductionUnsupported;
    if (options.trust and options.frozen_lockfile) return error.TrustWithFrozenLockfileUnsupported;
    return options;
}

fn applyPlatformOverride(comptime T: type, override: *Npm.Negatable(T), value: []const u8) bool {
    if (value.len == 0) return false;
    const name = if (value[0] == '!') value[1..] else value;
    const recognized = std.mem.eql(u8, name, "*") or
        std.mem.eql(u8, name, "any") or
        std.mem.eql(u8, name, "none") or
        T.NameMap.get(name) != null;
    if (!recognized) return false;
    if (std.mem.eql(u8, value, "*")) {
        override.had_wildcard = true;
        override.had_unrecognized_values = false;
    } else {
        override.apply(value);
    }
    return true;
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

fn parseMinimumReleaseAge(value: []const u8) !f64 {
    const seconds = std.fmt.parseFloat(f64, value) catch return error.InvalidMinimumReleaseAge;
    if (!std.math.isFinite(seconds) or seconds < 0) return error.InvalidMinimumReleaseAge;
    const milliseconds = seconds * std.time.ms_per_s;
    if (!std.math.isFinite(milliseconds)) return error.InvalidMinimumReleaseAge;
    return milliseconds;
}

fn parseNetworkConcurrency(value: []const u8) !usize {
    const parsed = std.fmt.parseInt(u16, value, 10) catch return error.InvalidNetworkConcurrency;
    return @max(1, parsed);
}

fn parseConcurrentScripts(value: []const u8) !?usize {
    const concurrency = std.fmt.parseInt(usize, value, 10) catch return error.InvalidConcurrentScripts;
    return if (concurrency == 0) null else concurrency;
}

fn printPackageManagerHelp(command: Command, writer: *std.Io.Writer) !void {
    try writer.print(
        \\Usage: cottontail {s} [packages...] [flags]
        \\
        \\  --cwd <path>             Set the working directory
        \\  --registry <url>         Override the package registry
        \\  --ca <certificate>       Add a trusted certificate authority
        \\  --cafile <path>          Add trusted certificate authorities from a file
        \\  --cpu <architecture>     Override target CPU (repeatable; * selects all)
        \\  --os <operating-system>  Override target OS (repeatable; * selects all)
        \\  -p, --production         Omit devDependencies
        \\  --omit <kind>            Omit dev, optional, or peer dependencies
        \\  --ignore-scripts         Skip project lifecycle scripts
        \\  --concurrent-scripts N  Maximum concurrent lifecycle scripts
        \\  --trust                  Trust added packages and run lifecycle scripts
        \\  --lockfile-only          Resolve without writing node_modules
        \\  --linker <strategy>      Use the isolated or hoisted install layout
        \\  --no-save                Do not update package.json or bun.lock
        \\  --no-verify              Skip package integrity verification
        \\  -f, --force              Re-resolve and reinstall dependencies
        \\  --dry-run                Perform a dry run without making changes
        \\  --patches-dir <path>     Set the generated patch directory
        \\
    , .{@tagName(command)});
    if (command == .update or command == .outdated) {
        try writer.writeAll(
            \\  -r, --recursive          Include packages in all workspaces
            \\
        );
        if (command == .update) {
            try writer.writeAll(
                \\  -i, --interactive        Select outdated packages to update
                \\  --latest                 Update to the latest version
                \\
            );
        }
    }
    if (command == .publish) {
        try writer.writeAll(
            \\Publish options:
            \\
            \\  --access <public|restricted>  Set package access
            \\  --tag <name>                  Publish under a dist-tag (default: latest)
            \\  --otp <code>                  Provide a one-time password
            \\  --auth-type <web|legacy>      Select one-time password authentication
            \\  --tolerate-republish          Succeed when the version already exists
            \\  --gzip-level <0-9>            Set tarball compression level
            \\
        );
    } else if (command == .pm) {
        try writer.writeAll(
            \\Registry utilities:
            \\
            \\  dist-tag add <package@version> [tag]
            \\  dist-tag rm <package> <tag>
            \\  dist-tag ls [package]
            \\
        );
    }
}

fn runPublish(
    init: std.process.Init,
    options: Options,
    stdout: *std.Io.Writer,
    stderr: *std.Io.Writer,
) !u8 {
    if (options.positionals.len > 1) {
        try stderr.writeAll("error: bun publish accepts at most one package tarball\n");
        try stderr.flush();
        return 1;
    }
    if (options.publish_tag.len > 0) {
        Publish.validateDistTag(options.publish_tag) catch |err| {
            try reportPublishTagError(err, options.publish_tag, stderr);
            return 1;
        };
    }
    if (!options.silent) {
        try stdout.print("bun publish v{s} (cottontail)\n", .{bun_compat_version});
        try stdout.flush();
    }

    var manager = Manager.init(init, options, stdout, stderr);
    defer manager.deinit();
    manager.invocation_dir = try absolutePath(init.io, manager.allocator, ".");
    manager.root_dir = manager.invocation_dir;
    manager.invocation_package_dir = manager.invocation_dir;
    if (options.positionals.len == 0) {
        const project = try findInstallProject(init.io, manager.allocator, manager.invocation_dir);
        manager.root_dir = project.root_dir;
        manager.invocation_package_dir = project.package_dir;
    }
    manager.loadConfiguration() catch |err| {
        if (err != error.PackageManagerErrorReported) {
            try stderr.print("error: failed to load package manager configuration: {s}\n", .{@errorName(err)});
        }
        try stderr.flush();
        return 1;
    };
    manager.client.initDefaultProxies(manager.allocator, manager.init_data.environ_map) catch {};

    var publish_options: Publish.Options = .{
        .access = options.publish_access,
        .tag = options.publish_tag,
        .otp = options.publish_otp,
        .auth_type = options.publish_auth_type,
        .tolerate_republish = options.tolerate_republish,
        .dry_run = options.dry_run,
        .ignore_scripts = options.ignore_scripts,
        .quiet = options.silent,
        .gzip_level = options.pack_gzip_level,
    };
    var prepared = (if (options.positionals.len == 1)
        Publish.prepareTarball(init, options.positionals[0], &publish_options, stdout)
    else
        Publish.prepareWorkspace(
            init,
            manager.root_dir,
            manager.invocation_package_dir,
            &publish_options,
            stdout,
            stderr,
        )) catch |err| {
        try reportPublishPreparationError(
            err,
            options.positionals.len == 1,
            options.positionals,
            publish_options.tag,
            stderr,
        );
        return 1;
    };

    const configured = manager.registryConfigForPackage(prepared.package_name);
    const result = try Publish.publish(
        init,
        &manager.client,
        &prepared,
        .{ .url = configured.url, .authorization = configured.authorization },
        publish_options,
        stdout,
        stderr,
    );
    if (result != 0) return result;

    try stdout.print("\n + {s}@{s}{s}\n", .{
        prepared.package_name,
        Publish.versionWithoutBuild(prepared.package_version),
        if (options.dry_run) " (dry-run)" else "",
    });
    try stdout.flush();
    Publish.runPostPublishScripts(init, &prepared, publish_options, stderr) catch return 1;
    return 0;
}

fn reportPublishPreparationError(
    err: anyerror,
    from_tarball: bool,
    positionals: []const []const u8,
    tag: []const u8,
    stderr: *std.Io.Writer,
) !void {
    switch (err) {
        error.FileNotFound => if (from_tarball)
            try stderr.print("error: failed to read tarball: '{s}'\n", .{positionals[0]})
        else
            try stderr.writeAll("error: missing package.json, nothing to publish\n"),
        error.MissingPackageJSON => if (from_tarball)
            try stderr.print("error: failed to find package.json in tarball '{s}'\n", .{positionals[0]})
        else
            try stderr.writeAll("error: missing package.json, nothing to publish\n"),
        error.InvalidPackageJSON => try stderr.writeAll("error: failed to parse package.json\n"),
        error.MissingPackageName => try stderr.writeAll("error: missing `name` string in package.json\n"),
        error.MissingPackageVersion => try stderr.writeAll("error: missing `version` string in package.json\n"),
        error.InvalidPackageName, error.InvalidPackageVersion => try stderr.writeAll("error: package.json `name` and `version` fields must be non-empty strings\n"),
        error.PrivatePackage => try stderr.writeAll("error: attempted to publish a private package\n"),
        error.RestrictedUnscopedPackage => try stderr.writeAll("error: unable to restrict access to unscoped package\n"),
        error.InvalidPublishAccess => try stderr.writeAll("error: invalid `access` value in publishConfig\n"),
        error.SemverDistTag, error.InvalidDistTag => try reportPublishTagError(err, tag, stderr),
        error.InvalidGzipLevel => try stderr.writeAll("error: compression level must be between 0 and 9\n"),
        error.WorkspaceVersionUnresolved, error.InvalidBundledDependencies, error.InvalidFiles, error.LifecycleScriptFailed => {},
        else => try stderr.print("error: failed to prepare package for publishing: {s}\n", .{@errorName(err)}),
    }
    try stderr.flush();
}

fn reportPublishTagError(err: anyerror, tag: []const u8, stderr: *std.Io.Writer) !void {
    if (err == error.SemverDistTag) {
        try stderr.print("error: Tag name must not be a valid SemVer range: {s}\n", .{tag});
    } else {
        try stderr.print("error: invalid publish dist-tag: {s}\n", .{tag});
    }
    try stderr.flush();
}

fn runPm(
    init: std.process.Init,
    options: Options,
    stdout: *std.Io.Writer,
    stderr: *std.Io.Writer,
) !u8 {
    const subcommand = switch (options.command) {
        .pm_list => "ls",
        .pm_info => "view",
        .pm_whoami => "whoami",
        .pm_why => "why",
        else => if (options.positionals.len > 0) options.positionals[0] else "",
    };
    if (std.mem.eql(u8, subcommand, "default-trusted")) {
        return PmTrusted.runDefaultTrusted(stdout);
    }
    if (std.mem.eql(u8, subcommand, "untrusted")) {
        const cwd = try absolutePath(init.io, init.arena.allocator(), ".");
        return PmTrusted.runUntrusted(init, cwd, stdout, stderr);
    }
    if (std.mem.eql(u8, subcommand, "trust")) {
        const cwd = try absolutePath(init.io, init.arena.allocator(), ".");
        return PmTrusted.runTrust(
            init,
            cwd,
            options.positionals[1..],
            options.all,
            stdout,
            stderr,
        );
    }
    if (std.mem.eql(u8, subcommand, "ls") or std.mem.eql(u8, subcommand, "list")) {
        return runPmList(init, options, stdout, stderr);
    }
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
            try stdout.writeAll(cache_path);
        }
        try stdout.flush();
        return 0;
    }
    if (std.mem.eql(u8, subcommand, "migrate")) return runPmMigrate(init, options, stdout, stderr);
    if (std.mem.eql(u8, subcommand, "dist-tag") or std.mem.eql(u8, subcommand, "dist-tags")) {
        return runPmDistTag(init, options, stdout, stderr);
    }
    if (std.mem.eql(u8, subcommand, "pack")) {
        const invocation_dir = try absolutePath(init.io, init.arena.allocator(), ".");
        const project = try findInstallProject(init.io, init.arena.allocator(), invocation_dir);
        return Pack.run(
            init,
            project.root_dir,
            project.package_dir,
            .{
                .destination = options.pack_destination,
                .filename = options.pack_filename,
                .gzip_level = options.pack_gzip_level,
                .dry_run = options.dry_run,
                .ignore_scripts = options.ignore_scripts,
                .quiet = options.silent,
            },
            stdout,
            stderr,
        );
    }
    if (std.mem.eql(u8, subcommand, "pkg")) {
        const cwd = try absolutePath(init.io, init.arena.allocator(), ".");
        return PmPkg.run(
            init.io,
            init.arena.allocator(),
            options.positionals[1..],
            options.json_output,
            cwd,
            stdout,
            stderr,
        );
    }
    if (std.mem.eql(u8, subcommand, "version")) {
        const cwd = try absolutePath(init.io, init.arena.allocator(), ".");
        return PmVersion.run(
            init,
            options.positionals[1..],
            .{
                .git_tag_version = options.git_tag_version,
                .allow_same_version = options.allow_same_version,
                .force = options.force,
                .ignore_scripts = options.ignore_scripts,
                .message = options.message,
                .preid = options.preid,
            },
            cwd,
            stdout,
            stderr,
        );
    }
    if (std.mem.eql(u8, subcommand, "view")) {
        const info_args = if (options.command == .pm_info) options.positionals else options.positionals[1..];
        return runPmInfo(init, options, info_args, stdout, stderr);
    }
    if (std.mem.eql(u8, subcommand, "why")) {
        const cwd = try absolutePath(init.io, init.arena.allocator(), ".");
        const why_args = if (options.command == .pm_why) options.positionals else options.positionals[1..];
        return PmWhy.run(
            init,
            why_args,
            .{ .top_only = options.top_only, .depth = options.depth },
            cwd,
            stdout,
            stderr,
        );
    }
    if (std.mem.eql(u8, subcommand, "hash") or std.mem.eql(u8, subcommand, "hash-print")) {
        return runPmHash(init, stdout, stderr);
    }
    if (std.mem.eql(u8, subcommand, "hash-string")) {
        return runPmHashString(init, stdout, stderr);
    }
    if (std.mem.eql(u8, subcommand, "whoami")) return runPmWhoami(init, options, stdout, stderr);
    try stderr.writeAll("error: unsupported package-manager utility\n");
    try stderr.flush();
    return 1;
}

fn runPmDistTag(
    init: std.process.Init,
    options: Options,
    stdout: *std.Io.Writer,
    stderr: *std.Io.Writer,
) !u8 {
    const allocator = init.arena.allocator();
    const invocation_dir = try absolutePath(init.io, allocator, ".");
    const project: ?InstallProject = findInstallProject(init.io, allocator, invocation_dir) catch null;
    const default_name = if (project) |found|
        readProjectPackageName(init.io, allocator, found.package_dir) catch null
    else
        null;
    const action = DistTag.parse(options.positionals[1..], default_name) catch |err| {
        try reportDistTagUsageError(err, options.positionals[1..], stderr);
        return 1;
    };

    var manager = Manager.init(init, options, stdout, stderr);
    defer manager.deinit();
    manager.invocation_dir = invocation_dir;
    manager.root_dir = if (project) |found| found.root_dir else invocation_dir;
    manager.invocation_package_dir = if (project) |found| found.package_dir else invocation_dir;
    manager.loadConfiguration() catch |err| {
        if (err != error.PackageManagerErrorReported) {
            try stderr.print("error: failed to load package manager configuration: {s}\n", .{@errorName(err)});
        }
        try stderr.flush();
        return 1;
    };
    manager.client.initDefaultProxies(manager.allocator, manager.init_data.environ_map) catch {};

    const configured = manager.registryConfigForPackage(action.packageName());
    return DistTag.run(
        init,
        &manager.client,
        action,
        .{ .url = configured.url, .authorization = configured.authorization },
        .{ .otp = options.publish_otp, .auth_type = options.publish_auth_type },
        stdout,
        stderr,
    );
}

fn readProjectPackageName(
    io: std.Io,
    allocator: std.mem.Allocator,
    package_dir: []const u8,
) !?[]const u8 {
    const path = try std.fs.path.join(allocator, &.{ package_dir, "package.json" });
    const source = try std.Io.Dir.cwd().readFileAlloc(io, path, allocator, .limited(64 * 1024 * 1024));
    const manifest = try PackageJSON.parsePackageJSON(allocator, path, source);
    if (manifest != .object) return null;
    const name = manifest.object.get("name") orelse return null;
    if (name != .string or name.string.len == 0) return null;
    return name.string;
}

fn reportDistTagUsageError(
    err: anyerror,
    args: []const []const u8,
    stderr: *std.Io.Writer,
) !void {
    switch (err) {
        error.SemverDistTag => try stderr.print(
            "error: Tag name must not be a valid SemVer range: {s}\n",
            .{if (args.len > 0) args[args.len - 1] else ""},
        ),
        error.InvalidDistTag => try stderr.writeAll("error: invalid dist-tag name\n"),
        error.InvalidDistTagPackage => try stderr.writeAll("error: invalid package name for dist-tag\n"),
        error.InvalidDistTagVersion => try stderr.writeAll("error: invalid package version for dist-tag\n"),
        error.MissingDistTagVersion => try stderr.writeAll("error: dist-tag add requires a package with a version\n"),
        else => try stderr.writeAll(
            "error: Usage: bun pm dist-tag add <package@version> [tag] | rm <package> <tag> | ls [package]\n",
        ),
    }
    try stderr.flush();
}

fn runPmInfo(
    init: std.process.Init,
    options: Options,
    args: []const []const u8,
    stdout: *std.Io.Writer,
    stderr: *std.Io.Writer,
) !u8 {
    var manager_options = options;
    manager_options.command = .install;
    manager_options.positionals = &.{};
    var manager = Manager.init(init, manager_options, stdout, stderr);
    defer manager.deinit();

    manager.invocation_dir = try absolutePath(init.io, manager.allocator, ".");
    manager.root_dir = manager.invocation_dir;
    manager.invocation_package_dir = manager.invocation_dir;
    if (findInstallProject(init.io, manager.allocator, manager.invocation_dir)) |project| {
        manager.root_dir = project.root_dir;
        manager.invocation_package_dir = project.package_dir;
    } else |_| {}
    try manager.loadConfiguration();
    manager.client.initDefaultProxies(manager.allocator, manager.init_data.environ_map) catch {};

    var raw_spec = if (args.len > 0) args[0] else ".";
    if (raw_spec.len == 0 or std.mem.eql(u8, raw_spec, ".")) {
        raw_spec = try packageNameForInfo(
            init.io,
            manager.allocator,
            manager.invocation_package_dir,
            manager.invocation_dir,
        );
    }
    const parsed = splitPackageSpec(raw_spec);
    const package_name = parsed.name orelse raw_spec;
    const property_path = if (args.len > 1) args[1] else null;
    const encoded_name = try encodePackageName(manager.allocator, package_name);
    const url = try std.fmt.allocPrint(manager.allocator, "{s}{s}", .{ manager.registry, encoded_name });
    const source = (try manager.fetchInfoManifest(url)) orelse return 1;
    return PmInfo.render(
        manager.allocator,
        source,
        package_name,
        parsed.spec,
        property_path,
        options.json_output,
        stdout,
        stderr,
    );
}

fn packageNameForInfo(
    io: std.Io,
    allocator: std.mem.Allocator,
    package_dir: []const u8,
    fallback_dir: []const u8,
) ![]const u8 {
    const package_json_path = try std.fs.path.join(allocator, &.{ package_dir, "package.json" });
    if (try readOptionalFile(io, allocator, package_json_path, 4 * 1024 * 1024)) |source| {
        const package_json = PackageJSON.parsePackageJSON(allocator, package_json_path, source) catch null;
        if (package_json) |value| {
            if (jsonString(&value, "name")) |name| {
                if (name.len > 0) return name;
            }
        }
    }
    return std.fs.path.basename(fallback_dir);
}

fn runPmList(
    init: std.process.Init,
    options: Options,
    stdout: *std.Io.Writer,
    stderr: *std.Io.Writer,
) !u8 {
    const allocator = init.arena.allocator();
    const invocation_dir = try absolutePath(init.io, allocator, ".");
    const project = findInstallProject(init.io, allocator, invocation_dir) catch |err| {
        try stderr.print("error: unable to find package.json: {s}\n", .{@errorName(err)});
        try stderr.flush();
        return 1;
    };
    var graph = loadPmLockGraph(init.io, allocator, project.root_dir) catch |err| {
        try stderr.print("error: unable to load lockfile: {s}\n", .{@errorName(err)});
        try stderr.flush();
        return 1;
    };
    defer graph.deinit();

    const installed = try rootInstalledAliases(init.io, allocator, project.root_dir);
    const aliases = if (options.all)
        installed
    else
        try directDependencyAliases(allocator, graph.root_workspace, installed);

    if (aliases.len == 0) return 0;

    if (options.all) {
        try stdout.print("{s} node_modules\n", .{project.root_dir});
    } else {
        try stdout.print("{s} node_modules ({d})\n", .{ project.root_dir, installed.len });
    }
    for (aliases, 0..) |alias, index| {
        const connector = if (index + 1 == aliases.len) "└──" else "├──";
        const resolution = try pmDisplayResolution(init.io, allocator, project.root_dir, &graph, alias);
        try stdout.print("{s} {s}@{s}\n", .{ connector, alias, resolution });
    }
    try stdout.flush();
    return 0;
}

fn runPmMigrate(
    init: std.process.Init,
    options: Options,
    stdout: *std.Io.Writer,
    stderr: *std.Io.Writer,
) !u8 {
    const allocator = init.arena.allocator();
    const invocation_dir = try absolutePath(init.io, allocator, ".");
    const project = try findInstallProject(init.io, allocator, invocation_dir);
    const text_path = try std.fs.path.join(allocator, &.{ project.root_dir, "bun.lock" });
    const binary_path = try std.fs.path.join(allocator, &.{ project.root_dir, "bun.lockb" });
    if (!options.force and (fileExists(init.io, text_path) or fileExists(init.io, binary_path))) {
        try stderr.writeAll("error: bun.lock already exists\nrun with --force to overwrite\n");
        try stderr.flush();
        return 1;
    }
    if (options.force) {
        std.Io.Dir.cwd().deleteFile(init.io, text_path) catch {};
        std.Io.Dir.cwd().deleteFile(init.io, binary_path) catch {};
    }

    const package_json_path = try std.fs.path.join(allocator, &.{ project.root_dir, "package.json" });
    const package_source = try std.Io.Dir.cwd().readFileAlloc(
        init.io,
        package_json_path,
        allocator,
        .limited(64 * 1024 * 1024),
    );
    var root: Value = if (std.mem.trim(u8, package_source, " \t\r\n").len == 0)
        .{ .object = .empty }
    else
        try PackageJSON.parsePackageJSON(allocator, package_json_path, package_source);
    var install_options = options;
    install_options.command = .install;
    install_options.positionals = &.{};
    install_options.silent = true;
    install_options.no_summary = true;
    install_options.lockfile_only = true;
    install_options.force = false;
    var manager = Manager.init(init, install_options, stdout, stderr);
    defer manager.deinit();
    manager.omit_pnpm_workspace_versions = true;
    manager.invocation_dir = invocation_dir;
    manager.root_dir = project.root_dir;
    manager.invocation_package_dir = project.package_dir;
    if (!std.mem.eql(u8, invocation_dir, project.root_dir)) {
        try std.process.setCurrentPath(init.io, project.root_dir);
    }
    try manager.loadConfiguration();
    manager.root_package_json = &root;
    manager.manifest_policy = try Manifest.Policy.init(manager.allocator, &root);

    const npm_path = try std.fs.path.join(allocator, &.{ project.root_dir, LockfileMigration.Source.npm.filename() });
    if (try readOptionalFile(init.io, allocator, npm_path, 256 * 1024 * 1024)) |npm_source| {
        const binary = try BunLockfile.migrateNpmToBinary(allocator, npm_source, npm_path, manager.registry);
        try writeMigratedLockfile(&manager, text_path, binary_path, binary);
        try stderr.print("migrated lockfile from {s}\n", .{LockfileMigration.Source.npm.filename()});
        try stderr.flush();
        return 0;
    }

    const migration = switch (try LockfileMigration.detect(init.io, allocator, project.root_dir, &root)) {
        .migrated => |migration| migration,
        .not_found => {
            try stderr.writeAll("error: could not find any other lockfile\n");
            try stderr.flush();
            return 1;
        },
        .ignored => |ignored| {
            if (ignored.reason == .pnpm_lockfile_too_old) {
                try stderr.writeAll("error: pnpm-lock.yaml version is too old\nPlease upgrade using 'pnpm install' before migrating\n");
                try stderr.flush();
                return 1;
            }
            try stderr.print("error: unable to migrate {s}\n", .{ignored.source.filename()});
            try stderr.flush();
            return 1;
        },
    };

    manager.lockfile_config_version = migration.graph.config_version orelse .v0;
    manager.lock_graph = migration.graph;
    try manager.enrichMigratedLockMetadata();
    if (manager.lock_graph.?.provenance == .pnpm) {
        manager.manifest_policy.?.deinit();
        manager.manifest_policy = try Manifest.Policy.init(manager.allocator, &root);
        if (manager.lock_graph.?.package_json_changed) {
            try writePackageJSON(
                manager.init_data.io,
                manager.allocator,
                package_json_path,
                root,
                package_source.len > 0 and package_source[package_source.len - 1] == '\n',
            );
        }
    }
    try manager.discoverWorkspaces(&root);
    try manager.loadRecordsFromLockGraph();
    try manager.writeTextLockfile(&root, true);
    try stderr.print("migrated lockfile from {s}\n", .{migration.source.filename()});
    try stderr.flush();
    return 0;
}

fn writeMigratedLockfile(
    manager: *Manager,
    text_path: []const u8,
    binary_path: []const u8,
    binary: []const u8,
) !void {
    if (manager.shouldSaveTextLockfile()) {
        const text = try BunLockfile.binaryToText(manager.allocator, binary);
        try std.Io.Dir.cwd().writeFile(manager.init_data.io, .{ .sub_path = text_path, .data = text });
        std.Io.Dir.cwd().deleteFile(manager.init_data.io, binary_path) catch {};
        return;
    }

    try std.Io.Dir.cwd().writeFile(manager.init_data.io, .{ .sub_path = binary_path, .data = binary });
    if (builtin.os.tag != .windows) {
        const permissions: std.Io.File.Permissions = @enumFromInt(0o755);
        try std.Io.Dir.cwd().setFilePermissions(manager.init_data.io, binary_path, permissions, .{});
    }
    std.Io.Dir.cwd().deleteFile(manager.init_data.io, text_path) catch {};
}

fn runPmHash(init: std.process.Init, stdout: *std.Io.Writer, stderr: *std.Io.Writer) !u8 {
    const allocator = init.arena.allocator();
    const invocation_dir = try absolutePath(init.io, allocator, ".");
    const project = try findInstallProject(init.io, allocator, invocation_dir);
    const text_path = try std.fs.path.join(allocator, &.{ project.root_dir, "bun.lock" });
    if (try readOptionalFile(init.io, allocator, text_path, 256 * 1024 * 1024)) |text| {
        try BunLockfile.writeTextMetaHash(allocator, text, stdout);
        try stdout.flush();
        return 0;
    }

    const binary_path = try std.fs.path.join(allocator, &.{ project.root_dir, "bun.lockb" });
    if (try readOptionalFile(init.io, allocator, binary_path, 256 * 1024 * 1024)) |binary| {
        try BunLockfile.writeBinaryMetaHash(allocator, binary, stdout);
        try stdout.flush();
        return 0;
    }

    try stderr.writeAll("error: lockfile not found\n");
    try stderr.flush();
    return 1;
}

fn runPmHashString(
    init: std.process.Init,
    stdout: *std.Io.Writer,
    stderr: *std.Io.Writer,
) !u8 {
    const allocator = init.arena.allocator();
    const invocation_dir = try absolutePath(init.io, allocator, ".");
    const project = try findInstallProject(init.io, allocator, invocation_dir);
    const text_path = try std.fs.path.join(allocator, &.{ project.root_dir, "bun.lock" });
    if (try readOptionalFile(init.io, allocator, text_path, 256 * 1024 * 1024)) |text| {
        try BunLockfile.writeTextMetaHashString(allocator, text, stdout);
        try stdout.flush();
        return 0;
    }

    const binary_path = try std.fs.path.join(allocator, &.{ project.root_dir, "bun.lockb" });
    if (try readOptionalFile(init.io, allocator, binary_path, 256 * 1024 * 1024)) |binary| {
        try BunLockfile.writeBinaryMetaHashString(allocator, binary, stdout);
        try stdout.flush();
        return 0;
    }

    try stderr.writeAll("error: lockfile not found\n");
    try stderr.flush();
    return 1;
}

fn runPmWhoami(
    init: std.process.Init,
    options: Options,
    stdout: *std.Io.Writer,
    stderr: *std.Io.Writer,
) !u8 {
    var manager_options = options;
    manager_options.command = .install;
    manager_options.positionals = &.{};
    var manager = Manager.init(init, manager_options, stdout, stderr);
    defer manager.deinit();
    manager.invocation_dir = try absolutePath(init.io, manager.allocator, ".");
    manager.root_dir = manager.invocation_dir;
    manager.invocation_package_dir = manager.invocation_dir;
    try manager.loadConfiguration();
    manager.client.initDefaultProxies(manager.allocator, manager.init_data.environ_map) catch {};

    if (manager.registry_username) |username| {
        try stdout.print("{s}\n", .{username});
        try stdout.flush();
        return 0;
    }
    if (manager.registry_authorization == null) {
        try stderr.writeAll("error: missing authentication (run `bunx npm login`)\n");
        try stderr.flush();
        return 1;
    }
    const url = try std.fmt.allocPrint(manager.allocator, "{s}-/whoami", .{manager.registry});
    const response = manager.fetchBytes(url, false, 1024 * 1024) catch return 1;
    const value = std.json.parseFromSliceLeaky(Value, manager.allocator, response, .{}) catch {
        try stderr.writeAll("error: failed to parse '/-/whoami' response body as JSON\n");
        try stderr.flush();
        return 1;
    };
    const username = jsonString(&value, "username") orelse {
        try stderr.print("error: failed to authenticate with registry '{s}'\n", .{manager.registry});
        try stderr.flush();
        return 1;
    };
    try stdout.print("{s}\n", .{username});
    try stdout.flush();
    return 0;
}

fn loadPmLockGraph(io: std.Io, allocator: std.mem.Allocator, root_dir: []const u8) !Lockfile.Graph {
    const text_path = try std.fs.path.join(allocator, &.{ root_dir, "bun.lock" });
    if (try readOptionalFile(io, allocator, text_path, 256 * 1024 * 1024)) |text| {
        return Lockfile.parseText(allocator, text);
    }

    const binary_path = try std.fs.path.join(allocator, &.{ root_dir, "bun.lockb" });
    const binary = try std.Io.Dir.cwd().readFileAlloc(io, binary_path, allocator, .limited(256 * 1024 * 1024));
    return Lockfile.parseText(allocator, try BunLockfile.binaryToText(allocator, binary));
}

fn rootInstalledAliases(io: std.Io, allocator: std.mem.Allocator, root_dir: []const u8) ![]const []const u8 {
    const modules_path = try std.fs.path.join(allocator, &.{ root_dir, "node_modules" });
    var modules = std.Io.Dir.cwd().openDir(io, modules_path, .{ .iterate = true }) catch |err| switch (err) {
        error.FileNotFound => return &.{},
        else => return err,
    };
    defer modules.close(io);
    var aliases = std.array_list.Managed([]const u8).init(allocator);
    var iterator = modules.iterate();
    while (try iterator.next(io)) |entry| {
        if (entry.name.len == 0 or entry.name[0] == '.') continue;
        if (entry.name[0] != '@') {
            try aliases.append(try allocator.dupe(u8, entry.name));
            continue;
        }
        var scope = modules.openDir(io, entry.name, .{ .iterate = true }) catch continue;
        var scope_iterator = scope.iterate();
        while (try scope_iterator.next(io)) |child| {
            if (child.name.len == 0 or child.name[0] == '.') continue;
            try aliases.append(try std.fmt.allocPrint(allocator, "{s}/{s}", .{ entry.name, child.name }));
        }
        scope.close(io);
    }
    std.sort.pdq([]const u8, aliases.items, {}, lessString);
    return aliases.toOwnedSlice();
}

fn directDependencyAliases(
    allocator: std.mem.Allocator,
    workspace: *const Value,
    installed: []const []const u8,
) ![]const []const u8 {
    var aliases = std.array_list.Managed([]const u8).init(allocator);
    for (all_dependency_sections) |section_name| {
        if (workspace.* != .object) continue;
        const section = workspace.object.get(section_name) orelse continue;
        if (section != .object) continue;
        for (section.object.keys()) |alias| {
            if (!containsString(installed, alias) or containsString(aliases.items, alias)) continue;
            try aliases.append(alias);
        }
    }
    std.sort.pdq([]const u8, aliases.items, {}, lessString);
    return aliases.toOwnedSlice();
}

fn pmDisplayResolution(
    io: std.Io,
    allocator: std.mem.Allocator,
    root_dir: []const u8,
    graph: *const Lockfile.Graph,
    alias: []const u8,
) ![]const u8 {
    if (graph.get(alias)) |package| {
        const info_version = if (package.info) |info| jsonString(info, "version") else null;
        return switch (package.kind) {
            .npm => package.version,
            .folder, .symlink => if (package.source.len > 0) std.fs.path.basename(package.source) else package.name,
            .workspace => info_version orelse if (package.source.len > 0) std.fs.path.basename(package.source) else package.name,
            .local_tarball, .remote_tarball, .git, .github => info_version orelse package.source,
            .root => package.name,
        };
    }
    const package_json_path = try std.fs.path.join(allocator, &.{ root_dir, "node_modules", alias, "package.json" });
    const source = try std.Io.Dir.cwd().readFileAlloc(io, package_json_path, allocator, .limited(4 * 1024 * 1024));
    const package_json = try PackageJSON.parsePackageJSON(allocator, package_json_path, source);
    return jsonString(&package_json, "version") orelse jsonString(&package_json, "name") orelse "unknown";
}

fn lessString(_: void, left: []const u8, right: []const u8) bool {
    return std.mem.order(u8, left, right) == .lt;
}

fn packageFetchConcurrency() usize {
    return @min(@as(usize, 16), @max(@as(usize, 4), (std.Thread.getCpuCount() catch 2) * 2));
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

fn decodeConfigText(allocator: std.mem.Allocator, raw: []const u8) ![]const u8 {
    if (std.mem.startsWith(u8, raw, "\xef\xbb\xbf")) return raw[3..];
    const endian: ?std.builtin.Endian = if (std.mem.startsWith(u8, raw, "\xff\xfe"))
        .little
    else if (std.mem.startsWith(u8, raw, "\xfe\xff"))
        .big
    else
        null;
    if (endian) |byte_order| {
        const bytes = raw[2..];
        if (bytes.len % 2 != 0) return error.InvalidConfigEncoding;
        const units = try allocator.alloc(u16, bytes.len / 2);
        for (units, 0..) |*unit, index| {
            unit.* = std.mem.readInt(u16, bytes[index * 2 ..][0..2], byte_order);
        }
        return std.unicode.utf16LeToUtf8Alloc(allocator, units);
    }
    return raw;
}

fn normalizeRegistryUrl(allocator: std.mem.Allocator, url: []const u8) ![]const u8 {
    const without_trailing_slashes = std.mem.trimEnd(u8, url, "/");
    if (without_trailing_slashes.len == 0) return allocator.dupe(u8, "/");
    return std.fmt.allocPrint(allocator, "{s}/", .{without_trailing_slashes});
}

const RegistryJoinError = error{
    InvalidRegistryURL,
    UnsupportedRegistryScheme,
};

fn registryURLContainsForbiddenWhitespace(url: []const u8) bool {
    for (url) |byte| {
        if (byte <= ' ' or byte == 0x7f) return true;
    }
    return false;
}

fn validateRegistryPort(port: []const u8) RegistryJoinError!void {
    if (port.len == 0) return;
    for (port) |byte| if (!std.ascii.isDigit(byte)) return error.InvalidRegistryURL;
    const number = std.fmt.parseInt(u32, port, 10) catch return error.InvalidRegistryURL;
    if (number > std.math.maxInt(u16)) return error.InvalidRegistryURL;
}

fn validateRegistryURLForJoin(source_url: []const u8) RegistryJoinError!void {
    if (source_url.len == 0 or registryURLContainsForbiddenWhitespace(source_url)) {
        return error.InvalidRegistryURL;
    }

    const scheme_end = std.mem.indexOfScalar(u8, source_url, ':') orelse
        return error.InvalidRegistryURL;
    const scheme = source_url[0..scheme_end];
    const is_http = std.ascii.eqlIgnoreCase(scheme, "http");
    const is_https = std.ascii.eqlIgnoreCase(scheme, "https");
    if (!is_http and !is_https) {
        // WHATWG joining rejects opaque bases such as `c:a`, while `c:/`
        // joins and is then rejected by Bun's HTTP(S)-only registry check.
        if (scheme_end + 1 < source_url.len and source_url[scheme_end + 1] == '/') {
            return error.UnsupportedRegistryScheme;
        }
        return error.InvalidRegistryURL;
    }

    const suffix = source_url[scheme_end + 1 ..];
    if (!std.mem.startsWith(u8, suffix, "//")) return;
    const authority_start = scheme_end + 3;
    const authority_end = std.mem.indexOfAnyPos(u8, source_url, authority_start, "/?#") orelse source_url.len;
    const authority = source_url[authority_start..authority_end];
    if (authority.len == 0) return;

    const host_start = if (std.mem.lastIndexOfScalar(u8, authority, '@')) |at| at + 1 else 0;
    const host_and_port = authority[host_start..];
    if (host_and_port.len == 0) return error.InvalidRegistryURL;
    if (host_and_port[0] == '[') {
        const close = std.mem.indexOfScalar(u8, host_and_port, ']') orelse return error.InvalidRegistryURL;
        const literal = host_and_port[1..close];
        if (literal.len == 0 or std.mem.indexOfScalar(u8, literal, ':') == null) return error.InvalidRegistryURL;
        if (close + 1 < host_and_port.len) {
            if (host_and_port[close + 1] != ':') return error.InvalidRegistryURL;
            try validateRegistryPort(host_and_port[close + 2 ..]);
        }
        return;
    }
    if (std.mem.lastIndexOfScalar(u8, host_and_port, ':')) |colon| {
        try validateRegistryPort(host_and_port[colon + 1 ..]);
    }
}

fn joinRegistryPackageURL(
    allocator: std.mem.Allocator,
    registry: RegistryConfig,
    encoded_name: []const u8,
) (RegistryJoinError || std.mem.Allocator.Error)![]const u8 {
    try validateRegistryURLForJoin(registry.source_url orelse registry.url);
    return std.fmt.allocPrint(allocator, "{s}{s}", .{ registry.url, encoded_name });
}

fn resolveRegistryTarballURL(
    allocator: std.mem.Allocator,
    registry_url: []const u8,
    tarball_url: []const u8,
) ![]const u8 {
    if (std.mem.startsWith(u8, tarball_url, "http://") or
        std.mem.startsWith(u8, tarball_url, "https://")) return allocator.dupe(u8, tarball_url);

    const relative_tarball = if (std.mem.startsWith(u8, tarball_url, "./")) tarball_url[2..] else tarball_url;
    const scheme_end = std.mem.indexOf(u8, registry_url, "://") orelse
        return std.fmt.allocPrint(allocator, "{s}{s}", .{ registry_url, relative_tarball });
    if (std.mem.startsWith(u8, tarball_url, "//")) {
        return std.fmt.allocPrint(allocator, "{s}:{s}", .{ registry_url[0..scheme_end], tarball_url });
    }
    if (std.mem.startsWith(u8, tarball_url, "/")) {
        const authority_start = scheme_end + "://".len;
        const authority_end = std.mem.indexOfScalarPos(u8, registry_url, authority_start, '/') orelse registry_url.len;
        return std.fmt.allocPrint(allocator, "{s}{s}", .{ registry_url[0..authority_end], tarball_url });
    }
    return std.fmt.allocPrint(allocator, "{s}{s}", .{ registry_url, relative_tarball });
}

const SecurityPackage = struct {
    name: []const u8,
    version: []const u8,
    requestedRange: []const u8,
    tarball: []const u8,
};

const SecurityPackagePath = struct {
    name: []const u8,
    path: []const u8,
};

const SecurityMatrix = struct {
    packages: []const SecurityPackage,
    paths: []const SecurityPackagePath,
};

const SecurityRegistryManifest = struct {
    name: []const u8,
    manifest: Value,
};

const SecurityQueueItem = struct {
    record_index: usize,
    requested_range: []const u8,
    path: []const u8,
};

fn securityDependencyRequest(root: ?*const Value, name: []const u8) ?[]const u8 {
    const package_json = root orelse return null;
    if (package_json.* != .object) return null;
    for (all_dependency_sections) |section_name| {
        const section = package_json.object.get(section_name) orelse continue;
        if (section != .object) continue;
        const requested = section.object.get(name) orelse continue;
        if (requested == .string) return requested.string;
    }
    return null;
}

fn securityPackagePath(payload: *const Value, package_name: []const u8) ?[]const u8 {
    if (payload.* != .object) return null;
    const paths = payload.object.get("paths") orelse return null;
    if (paths != .array) return null;
    for (paths.array.items) |entry| {
        if (entry != .object) continue;
        const name = entry.object.get("name") orelse continue;
        const path = entry.object.get("path") orelse continue;
        if (name != .string or path != .string) continue;
        if (std.mem.eql(u8, name.string, package_name)) return path.string;
    }
    return null;
}

const security_scanner_runtime: [:0]const u8 =
    \\const [specifier, root, payloadPath, resultPath] = process.argv.slice(-4);
    \\const originalExit = process.exit;
    \\const scannerExit = Symbol("security scanner exit");
    \\
    \\try {
    \\  if (!specifier || !root || !payloadPath || !resultPath) {
    \\    throw new Error("incomplete security scanner invocation");
    \\  }
    \\  process.exit = code => {
    \\    const error = new Error("Security scanner exited before sending data");
    \\    error[scannerExit] = Number(code ?? 0);
    \\    throw error;
    \\  };
    \\  let resolved;
    \\  const absolutePath = specifier.startsWith("/") || specifier.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(specifier);
    \\  if (absolutePath || specifier.startsWith("./") || specifier.startsWith("../")) {
    \\    resolved = absolutePath ? specifier : `${root}/${specifier}`;
    \\    if (!(await Bun.file(resolved).exists())) {
    \\      throw new Error(`Security scanner '${specifier}' is configured in bunfig.toml but the file could not be found.\n  Please check that the file exists and the path is correct.`);
    \\    }
    \\    resolved = Bun.pathToFileURL(resolved).href;
    \\  } else {
    \\    try {
    \\      resolved = Bun.resolveSync(specifier, root);
    \\    } catch {
    \\      throw new Error(`Security scanner '${specifier}' is configured in bunfig.toml but the package could not be resolved.`);
    \\    }
    \\  }
    \\  const imported = await import(resolved);
    \\  const scanner = imported.scanner ?? imported.default?.scanner;
    \\  if (!scanner || !("version" in scanner)) {
    \\    throw new Error("Security scanner module must export a scanner with a version property");
    \\  }
    \\  if (scanner.version !== "1") throw new Error("Security scanner must be version 1");
    \\  if (typeof scanner.scan !== "function") throw new Error("scanner.scan is not a function");
    \\
    \\  const payload = await Bun.file(payloadPath).json();
    \\  const started = performance.now();
    \\  const advisories = await scanner.scan({ packages: payload.packages });
    \\  const elapsed = Math.max(0, Math.round(performance.now() - started));
    \\  if (elapsed >= 1000) {
    \\    console.error(`[${specifier}] Scanning ${payload.packages.length} package${payload.packages.length === 1 ? "" : "s"} took ${elapsed}ms`);
    \\  }
    \\  await Bun.write(resultPath, JSON.stringify({ ok: true, advisories }));
    \\} catch (error) {
    \\  const result = error?.[scannerExit] === undefined
    \\    ? { ok: false, error: String(error?.message ?? error) }
    \\    : { ok: false, exitCode: error[scannerExit] };
    \\  await Bun.write(resultPath, JSON.stringify(result));
    \\} finally {
    \\  process.exit = originalExit;
    \\}
;

const Manager = struct {
    init_data: std.process.Init,
    allocator: std.mem.Allocator,
    options: Options,
    stdout: *std.Io.Writer,
    stderr: *std.Io.Writer,
    root_dir: []const u8 = "",
    invocation_dir: []const u8 = "",
    invocation_package_dir: []const u8 = "",
    registry: []const u8 = default_registry,
    registry_source: []const u8 = default_registry,
    registry_authorization: ?[]const u8 = null,
    registry_username: ?[]const u8 = null,
    registry_scopes: std.StringHashMap(RegistryConfig),
    certificate_authorities: []const []const u8 = &.{},
    certificate_authority_file: ?[]const u8 = null,
    global_install_directory: ?[]const u8 = null,
    global_bin_directory: ?[]const u8 = null,
    cache_directory: ?[]const u8 = null,
    save_text_lockfile: bool = true,
    save_text_lockfile_configured: bool = false,
    loaded_text_lockfile: bool = false,
    loaded_binary_lockfile: bool = false,
    binary_lockfile_needs_migration: bool = false,
    binary_lockfile_trusted_dependency_hashes: ?[]const compiler.install.TruncatedPackageNameHash = null,
    lockfile_config_version: Lockfile.ConfigVersion = .current,
    linker_configured: bool = false,
    max_retry_count: u16 = 5,
    client: std.http.Client,
    records: std.array_list.Managed(PackageRecord),
    workspaces: std.StringHashMap(Workspace),
    root_versions: std.StringHashMap([]const u8),
    initial_root_versions: std.StringHashMap([]const u8),
    resolving: std.StringHashMap(void),
    expanded_lock_packages: std.StringHashMap(void),
    registry_manifests: std.StringHashMap(*Value),
    registry_manifest_failures: std.StringHashMap(void),
    registry_archives: std.StringHashMap([]const u8),
    installed_registry_packages: std.StringHashMap(void),
    linked_bins: std.StringHashMap(void),
    refreshed_update_manifests: std.StringHashMap(void),
    direct_bins: std.array_list.Managed([]const u8),
    explicit_adds: std.StringHashMap(void),
    trusted_additions: std.StringHashMap(void),
    direct_install_reports: std.array_list.Managed(DirectInstallReport),
    removed_materialized_names: std.array_list.Managed([]const u8),
    latest_versions: std.StringHashMap([]const u8),
    installed_workspaces: std.StringHashMap(void),
    filtered_workspaces: std.StringHashMap(void),
    resolution_only_records: std.StringHashMap(void),
    install_filter_active: bool = false,
    root_selected: bool = true,
    filter_resolution_only: bool = false,
    report_direct_installs: bool = false,
    refresh_direct_registry: bool = false,
    refresh_direct_source: bool = false,
    link_workspace_packages: bool = true,
    started_ns: i128,
    installed_count: usize = 0,
    removed_count: usize = 0,
    network_task_count: usize = 0,
    changed: bool = false,
    deferred_install_error: ?anyerror = null,
    update_package_json_changed: bool = false,
    interactive_update_prepared: bool = false,
    interactive_changed_manifests: std.ArrayList(InteractiveChangedManifest) = .empty,
    patch_policy_changed: bool = false,
    omit_pnpm_workspace_versions: bool = false,
    root_package_json: ?*Value = null,
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
    peer_conflict_warnings: std.StringHashMap(void),
    lock_graph: ?Lockfile.Graph = null,
    manifest_policy: ?Manifest.Policy = null,
    security_scanner: ?[]const u8 = null,
    minimum_release_age_excludes: []const []const u8 = &.{},
    script_queue: Scripts.Queue,
    blocked_scripts: usize = 0,
    started_wall_ms: f64,

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
            .certificate_authorities = options.ca,
            .certificate_authority_file = options.ca_file_name,
            .client = .{ .allocator = std.heap.smp_allocator, .io = init_data.io },
            .records = std.array_list.Managed(PackageRecord).init(allocator),
            .workspaces = std.StringHashMap(Workspace).init(allocator),
            .root_versions = std.StringHashMap([]const u8).init(allocator),
            .initial_root_versions = std.StringHashMap([]const u8).init(allocator),
            .resolving = std.StringHashMap(void).init(allocator),
            .expanded_lock_packages = std.StringHashMap(void).init(allocator),
            .registry_manifests = std.StringHashMap(*Value).init(allocator),
            .registry_manifest_failures = std.StringHashMap(void).init(allocator),
            .registry_archives = std.StringHashMap([]const u8).init(allocator),
            .installed_registry_packages = std.StringHashMap(void).init(allocator),
            .linked_bins = std.StringHashMap(void).init(allocator),
            .refreshed_update_manifests = std.StringHashMap(void).init(allocator),
            .registry_scopes = std.StringHashMap(RegistryConfig).init(allocator),
            .direct_bins = std.array_list.Managed([]const u8).init(allocator),
            .explicit_adds = std.StringHashMap(void).init(allocator),
            .trusted_additions = std.StringHashMap(void).init(allocator),
            .direct_install_reports = std.array_list.Managed(DirectInstallReport).init(allocator),
            .removed_materialized_names = std.array_list.Managed([]const u8).init(allocator),
            .latest_versions = std.StringHashMap([]const u8).init(allocator),
            .installed_workspaces = std.StringHashMap(void).init(allocator),
            .filtered_workspaces = std.StringHashMap(void).init(allocator),
            .resolution_only_records = std.StringHashMap(void).init(allocator),
            .isolated_parent_modules = std.StringHashMap([]const u8).init(allocator),
            .isolated_parent_keys = std.StringHashMap([]const u8).init(allocator),
            .isolated_package_metadata = std.StringHashMap(*const Value).init(allocator),
            .isolated_live_store_keys = std.StringHashMap(void).init(allocator),
            .isolated_live_links = std.StringHashMap(void).init(allocator),
            .isolated_managed_modules = std.StringHashMap(void).init(allocator),
            .isolated_hidden_hoists = std.StringHashMap(void).init(allocator),
            .isolated_public_hoists = std.StringHashMap(void).init(allocator),
            .peer_conflict_warnings = std.StringHashMap(void).init(allocator),
            .script_queue = Scripts.Queue.init(allocator),
            .started_ns = std.Io.Clock.awake.now(init_data.io).nanoseconds,
            .started_wall_ms = @floatFromInt(@divTrunc(
                std.Io.Clock.real.now(init_data.io).nanoseconds,
                std.time.ns_per_ms,
            )),
        };
    }

    fn deinit(manager: *Manager) void {
        manager.registry_scopes.deinit();
        manager.initial_root_versions.deinit();
        manager.refreshed_update_manifests.deinit();
        manager.linked_bins.deinit();
        manager.installed_registry_packages.deinit();
        manager.registry_archives.deinit();
        manager.registry_manifest_failures.deinit();
        manager.registry_manifests.deinit();
        manager.resolution_only_records.deinit();
        manager.filtered_workspaces.deinit();
        manager.installed_workspaces.deinit();
        manager.latest_versions.deinit();
        manager.removed_materialized_names.deinit();
        manager.direct_install_reports.deinit();
        manager.trusted_additions.deinit();
        manager.explicit_adds.deinit();
        manager.peer_conflict_warnings.deinit();
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
        const security_resolution_output = manager.init_data.environ_map.get(security_resolution_output_env);
        const internal_bunx_install = manager.init_data.environ_map.get("BUN_INTERNAL_BUNX_INSTALL") != null;
        if (security_resolution_output != null) {
            manager.options.dry_run = true;
            manager.options.no_save = true;
            manager.options.silent = true;
            manager.options.no_summary = true;
            manager.options.ignore_scripts = true;
        }
        // Bun treats `install <package>` as `add <package>` before it
        // initializes the package manager.
        if (manager.options.command == .install and manager.options.positionals.len > 0) {
            manager.options.command = .add;
        }
        manager.invocation_dir = try absolutePath(manager.init_data.io, manager.allocator, ".");
        if (manager.options.global) {
            if (manager.options.config_path) |config_path| {
                manager.options.config_path = try absolutePathFrom(manager.allocator, manager.invocation_dir, config_path);
            } else {
                const invocation_bunfig = try std.fs.path.join(manager.allocator, &.{ manager.invocation_dir, "bunfig.toml" });
                if (std.Io.Dir.cwd().access(manager.init_data.io, invocation_bunfig, .{})) |_| {
                    manager.options.config_path = invocation_bunfig;
                } else |_| {}
            }
            manager.root_dir = try manager.resolveGlobalInstallRoot();
            try std.Io.Dir.cwd().createDirPath(manager.init_data.io, manager.root_dir);
            manager.invocation_package_dir = manager.root_dir;
        } else if (manager.options.command == .patch or manager.options.command == .patch_commit) {
            manager.root_dir = try findPatchProjectRoot(manager.init_data.io, manager.allocator, manager.invocation_dir);
            manager.invocation_package_dir = manager.root_dir;
        } else {
            const project = try findInstallProject(manager.init_data.io, manager.allocator, manager.invocation_dir);
            manager.root_dir = project.root_dir;
            manager.invocation_package_dir = project.package_dir;
        }
        if (!std.mem.eql(u8, manager.invocation_dir, manager.root_dir)) {
            try std.process.setCurrentPath(manager.init_data.io, manager.root_dir);
        }
        try manager.loadConfiguration();
        manager.client.initDefaultProxies(manager.allocator, manager.init_data.environ_map) catch {};

        if (manager.options.command == .link and manager.options.positionals.len == 0) {
            return manager.registerGlobalLink();
        }
        if (manager.options.command == .unlink) {
            if (manager.options.positionals.len != 0) {
                try manager.stderr.writeAll("error: bun unlink <package> is not implemented by Bun\n");
                return error.PackageManagerErrorReported;
            }
            return manager.unregisterGlobalLink();
        }
        if (manager.options.command == .link) {
            manager.options.positionals = try manager.globalLinkPackageSpecs();
        }

        const install_header_printed = !manager.options.silent and
            !internal_bunx_install and
            manager.options.command == .install;
        if (install_header_printed) {
            try manager.stdout.print("bun install v{s} (cottontail v{s})\n\n", .{
                bun_compat_version,
                version,
            });
            try manager.stdout.flush();
        }

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
        var root: Value = if (std.mem.trim(u8, package_source, " \t\r\n").len == 0)
            .{ .object = .empty }
        else
            try PackageJSON.parseInstallPackageJSON(
                manager.allocator,
                package_json_path,
                package_source,
                manager.stderr,
            );
        if (root != .object) return error.InvalidPackageJSON;
        manager.root_package_json = &root;
        manager.manifest_policy = try Manifest.Policy.init(manager.allocator, &root);
        try manager.warnDuplicateDependencies(&root);

        if (manager.options.frozen_lockfile) {
            if (manager.options.command != .install) return error.FrozenLockfileChanged;
        }
        try manager.loadLockfile(&root);
        if (manager.options.command == .install) {
            if (manager.lock_graph) |*graph| {
                manager.removed_count = removedDependencyCount(graph.root_workspace, &root);
            }
        }
        if (manager.lock_graph) |*graph| {
            if (graph.provenance == .pnpm) {
                manager.manifest_policy.?.deinit();
                manager.manifest_policy = try Manifest.Policy.init(manager.allocator, &root);
                if (graph.package_json_changed and !manager.options.dry_run and !manager.options.no_save) {
                    try writePackageJSON(
                        manager.init_data.io,
                        manager.allocator,
                        package_json_path,
                        root,
                        had_trailing_newline,
                    );
                }
            }
        }

        try manager.discoverWorkspaces(&root);
        try manager.discoverExplicitWorkspaceDependencies(&root, manager.root_dir);
        var duplicate_warning_workspaces = manager.workspaces.iterator();
        while (duplicate_warning_workspaces.next()) |entry| {
            try manager.warnDuplicateDependencies(entry.value_ptr.package_json);
        }
        try manager.validateLockfileWorkspaces();
        try manager.configureInstallFilters(&root);
        if (security_resolution_output == null and
            manager.security_scanner != null and
            !manager.options.dry_run and
            !manager.options.lockfile_only and
            commandUsesSecurityScanner(manager.options.command))
        {
            try manager.runSecurityScannerPreflight(&root);
        }
        if (manager.options.command == .patch) return manager.preparePatchCommand();
        if (manager.options.command == .patch_commit) {
            return manager.commitPatchCommand(&root, package_json_path, had_trailing_newline);
        }
        const report_resolution = !manager.options.silent and
            !internal_bunx_install and
            manager.options.command == .install and
            ((manager.lock_graph == null and hasAnyDependencies(&root)) or
                manager.patch_policy_changed);
        if (!manager.options.silent and !internal_bunx_install) {
            if (!install_header_printed) {
                try manager.stdout.print("bun {s} v{s} (cottontail v{s})\n{s}", .{
                    @tagName(manager.options.command),
                    bun_compat_version,
                    version,
                    if (manager.options.command == .link or
                        manager.options.command == .remove or
                        manager.options.command == .outdated or
                        manager.rootLifecycleScriptsWillRun()) "" else "\n",
                });
                try manager.stdout.flush();
            }
            if (report_resolution) {
                try manager.stderr.writeAll("Resolving dependencies\n");
            }
        }

        var command_package_json = &root;
        var command_package_json_path = package_json_path;
        var command_package_json_had_trailing_newline = had_trailing_newline;
        if (!std.mem.eql(u8, manager.invocation_package_dir, manager.root_dir)) {
            const workspace = manager.workspaceForPath(manager.invocation_package_dir) orelse {
                try manager.stderr.print("error: Workspace not found \"{s}\"\n", .{manager.invocation_package_dir});
                return error.PackageManagerErrorReported;
            };
            command_package_json = workspace.package_json;
            command_package_json_path = try std.fs.path.join(manager.allocator, &.{ workspace.path, "package.json" });
            const command_source = try std.Io.Dir.cwd().readFileAlloc(
                manager.init_data.io,
                command_package_json_path,
                manager.allocator,
                .limited(64 * 1024 * 1024),
            );
            command_package_json_had_trailing_newline = command_source.len > 0 and command_source[command_source.len - 1] == '\n';
        }

        if (manager.options.command == .outdated) {
            return manager.printOutdated(command_package_json, manager.invocation_package_dir);
        }

        if (manager.options.command == .add and manager.options.analyze) {
            manager.options.positionals = try Analyzer.scan(
                manager.allocator,
                manager.init_data.io,
                manager.options.positionals,
                manager.invocation_package_dir,
                manager.stderr,
            );
            manager.options.only_missing = true;
        }

        if (manager.options.command == .update and manager.options.interactive) {
            if (!try manager.prepareInteractiveUpdate(&root, command_package_json, manager.invocation_package_dir)) return 0;
        }

        try manager.validateCatalogReferences(&root);
        try manager.captureInitialDirectVersions(command_package_json, manager.invocation_package_dir);
        try manager.prepareNodeModules();
        try manager.reserveWorkspaceRootVersions();
        if (manager.options.command == .install and manager.security_scanner == null) {
            // Network prefetch is opportunistic. The normal resolver remains the
            // source of diagnostics and retries if a speculative request fails.
            manager.prefetchInstallNetwork(&root) catch {};
            try manager.reserveDirectRootVersions(&root);
        }

        switch (manager.options.command) {
            .install => try manager.installRoot(&root, true),
            .add => try manager.addPackages(command_package_json, manager.invocation_package_dir),
            .remove => try manager.removePackages(command_package_json, manager.invocation_package_dir),
            .update => try manager.updatePackages(command_package_json, manager.invocation_package_dir),
            .link => try manager.addPackages(command_package_json, manager.invocation_package_dir),
            .unlink => unreachable,
            .patch, .patch_commit, .publish => unreachable,
            .audit, .outdated, .pm, .pm_list, .pm_info, .pm_whoami, .pm_why => unreachable,
        }
        if (report_resolution) {
            try manager.stderr.print("Resolved, downloaded and extracted [{d}]\n", .{manager.network_task_count});
        }

        if (manager.trusted_additions.count() > 0 and !manager.options.no_save) {
            try manager.persistTrustedAdditions(&root);
        }

        if (security_resolution_output) |output_path| {
            try manager.writeSecurityResolution(output_path, null);
            try manager.writeSecurityRegistryManifests(output_path);
            return 0;
        }

        try manager.reconcileIsolatedPeerGraph();
        try manager.finalizeIsolatedNodeModules();
        try manager.pruneStaleHoistedWorkspaceLinks();
        try manager.relinkNativeDependencyBins(&root);

        if ((manager.options.command == .add or manager.options.command == .remove or manager.options.command == .update or manager.options.command == .link) and
            !manager.options.production and !manager.options.no_save and !manager.options.dry_run and
            (manager.options.command != .update or manager.update_package_json_changed))
        {
            if (manager.interactive_update_prepared) {
                for (manager.interactive_changed_manifests.items) |manifest| {
                    try writePackageJSON(
                        manager.init_data.io,
                        manager.allocator,
                        manifest.path,
                        manifest.package_json.*,
                        manifest.had_trailing_newline,
                    );
                }
            } else {
                try writePackageJSON(
                    manager.init_data.io,
                    manager.allocator,
                    command_package_json_path,
                    command_package_json.*,
                    command_package_json_had_trailing_newline,
                );
                if (manager.options.trust and command_package_json != &root) {
                    try writePackageJSON(
                        manager.init_data.io,
                        manager.allocator,
                        package_json_path,
                        root,
                        had_trailing_newline,
                    );
                }
            }
        }

        if (manager.deferred_install_error == null and
            !manager.options.production and
            !manager.options.dry_run and
            !manager.options.no_save)
        {
            if (manager.records.items.len == 0 and !hasAnyDependencies(&root)) {
                const had_lockfile = manager.hasExistingLockfile();
                manager.deleteLockfiles();
                if (manager.options.command == .remove and manager.changed and had_lockfile and !manager.options.silent) {
                    try manager.stderr.writeAll("\npackage.json has no dependencies! Deleted empty lockfile\n");
                } else if (manager.options.command == .install and !manager.options.silent) {
                    try manager.stderr.writeAll("No packages! Deleted empty lockfile\n");
                }
            } else {
                const save_bun_lockfile = manager.changed or !manager.hasExistingLockfile() or manager.lockfileNeedsRewrite();
                if (save_bun_lockfile or manager.options.save_yarn_lockfile) {
                    try manager.writeTextLockfile(&root, save_bun_lockfile);
                }
            }
        }

        if (!manager.options.ignore_scripts and !manager.options.dry_run and !manager.options.lockfile_only) {
            try manager.script_queue.run(manager.init_data, manager.root_dir, manager.options.concurrent_scripts, manager.stderr);
            if (manager.deferred_install_error == null and manager.options.command == .install and manager.root_selected) {
                try Scripts.runRoot(manager.init_data, manager.root_dir, &root, manager.options.silent, manager.stderr);
            }
        }

        if (!manager.options.silent and manager.options.lockfile_only and !manager.options.no_save and !manager.options.dry_run) {
            try manager.stdout.print("Saved {s} ({d} packages)", .{
                if (manager.shouldSaveTextLockfile()) "bun.lock" else "bun.lockb",
                manager.lockfilePackageCount(),
            });
        } else if (!manager.options.silent and !manager.options.no_summary and
            !(manager.options.only_missing and manager.installed_count == 0))
        {
            const finished_ns = std.Io.Clock.awake.now(manager.init_data.io).nanoseconds;
            const elapsed_ms = @as(f64, @floatFromInt(finished_ns - manager.started_ns)) / std.time.ns_per_ms;
            const physical_installed_count = if (manager.options.command == .link)
                manager.options.positionals.len
            else
                manager.installed_count;
            const reported_installed_count = physical_installed_count -| manager.duplicateDirectInstallCount();
            if (manager.options.command == .install and manager.options.dry_run) {
                try manager.stdout.print("[{d:.2}ms] done\n", .{elapsed_ms});
            } else if (manager.options.command == .remove) {
                if (reported_installed_count > 0) {
                    const count = reported_installed_count;
                    try manager.stdout.print("\n{d} package{s} installed [{d:.2}ms]\nRemoved: {d}\n", .{
                        count,
                        if (count == 1) "" else "s",
                        elapsed_ms,
                        manager.removed_count,
                    });
                } else if (manager.removed_materialized_names.items.len > 0) {
                    for (manager.removed_materialized_names.items) |name| {
                        try manager.stdout.print("- {s}\n", .{name});
                    }
                    const count = manager.removed_materialized_names.items.len;
                    try manager.stdout.print("{d} package{s} removed [{d:.2}ms]\n", .{
                        count,
                        if (count == 1) "" else "s",
                        elapsed_ms,
                    });
                } else if (manager.removed_count > 0) {
                    try manager.stdout.print("[{d:.2}ms] done\n", .{elapsed_ms});
                }
            } else if (manager.options.command == .install and
                reported_installed_count == 0 and
                manager.removed_count > 0)
            {
                try manager.stdout.print("{d} package{s} removed [{d:.2}ms]\n", .{
                    manager.removed_count,
                    if (manager.removed_count == 1) "" else "s",
                    elapsed_ms,
                });
            } else if (manager.options.command == .install and
                reported_installed_count == 0 and
                manager.records.items.len == 0 and
                !hasAnyDependencies(&root))
            {
                try manager.stdout.print("{s}[{d:.2}ms] done\n", .{
                    manager.installSummarySeparator(),
                    elapsed_ms,
                });
            } else if (manager.options.command == .install and reported_installed_count == 0) {
                const checked_installs = manager.checkedInstallCount();
                if (checked_installs == 0) {
                    try manager.stdout.print("Done! Checked {d} packages (no changes) [{d:.2}ms]\n", .{ manager.lockfilePackageCount(), elapsed_ms });
                } else {
                    try manager.stdout.print("Checked {d} install{s} across {d} packages (no changes) [{d:.2}ms]\n", .{
                        checked_installs,
                        if (checked_installs == 1) "" else "s",
                        manager.lockfilePackageCount(),
                        elapsed_ms,
                    });
                }
            } else if (manager.options.command == .add and reported_installed_count == 0) {
                try manager.stdout.print("\n[{d:.2}ms] done\n", .{elapsed_ms});
            } else if (manager.options.command == .update and reported_installed_count == 0) {
                if (manager.options.positionals.len == 0) {
                    const checked_installs = manager.records.items.len;
                    try manager.stdout.print("Checked {d} install{s} across {d} packages (no changes) [{d:.2}ms]\n", .{
                        checked_installs,
                        if (checked_installs == 1) "" else "s",
                        manager.lockfilePackageCount(),
                        elapsed_ms,
                    });
                } else {
                    try manager.stdout.print("\n[{d:.2}ms] done\n", .{elapsed_ms});
                }
            } else if (reported_installed_count == 1) {
                try manager.stdout.print("{s}1 package installed [{d:.2}ms]\n", .{
                    manager.installSummarySeparator(),
                    elapsed_ms,
                });
            } else {
                try manager.stdout.print("{s}{d} packages installed [{d:.2}ms]\n", .{
                    manager.installSummarySeparator(),
                    reported_installed_count,
                    elapsed_ms,
                });
            }
        }
        if (!manager.options.silent and manager.blocked_scripts > 0) {
            try manager.stdout.print("\nBlocked {d} postinstall{s}. Run `bun pm untrusted` for details.\n", .{
                manager.blocked_scripts,
                if (manager.blocked_scripts == 1) "" else "s",
            });
        }
        try manager.stdout.flush();
        try manager.stderr.flush();
        if (manager.deferred_install_error) |err| return err;
        return 0;
    }

    fn executeSecurityScan(manager: *Manager) !u8 {
        manager.invocation_dir = try absolutePath(manager.init_data.io, manager.allocator, ".");
        const project = try findInstallProject(manager.init_data.io, manager.allocator, manager.invocation_dir);
        manager.root_dir = project.root_dir;
        manager.invocation_package_dir = project.package_dir;

        const package_json_path = try std.fs.path.join(manager.allocator, &.{ manager.root_dir, "package.json" });
        const package_source = std.Io.Dir.cwd().readFileAlloc(
            manager.init_data.io,
            package_json_path,
            manager.allocator,
            .limited(64 * 1024 * 1024),
        ) catch |err| switch (err) {
            error.FileNotFound => {
                try manager.stderr.writeAll("error: No package.json was found\n");
                return error.PackageManagerErrorReported;
            },
            else => return err,
        };
        var root = try PackageJSON.parsePackageJSON(manager.allocator, package_json_path, package_source);
        if (root != .object) return error.InvalidPackageJSON;
        manager.root_package_json = &root;
        manager.manifest_policy = try Manifest.Policy.init(manager.allocator, &root);

        if (!std.mem.eql(u8, manager.invocation_dir, manager.root_dir)) {
            try std.process.setCurrentPath(manager.init_data.io, manager.root_dir);
        }
        try manager.loadConfiguration();
        if (manager.security_scanner == null) {
            try manager.stderr.writeAll("error: no security scanner configured\n");
            return error.PackageManagerErrorReported;
        }

        try manager.loadLockfile(&root);
        if (manager.lock_graph == null) {
            try manager.stderr.writeAll("error: Lockfile not found. Run 'bun install' first.\n");
            return error.PackageManagerErrorReported;
        }
        try manager.discoverWorkspaces(&root);
        try manager.loadRecordsFromLockGraph();
        try manager.ensureSecurityScannerAvailable(&root);

        const payload_path = try manager.securityTempFile("json");
        defer std.Io.Dir.cwd().deleteFile(manager.init_data.io, payload_path) catch {};
        try manager.writeSecurityResolution(payload_path, &root);
        try manager.runSecurityScannerPayload(payload_path, "scan");
        return 0;
    }

    fn securityTempFile(manager: *Manager, suffix: []const u8) ![]const u8 {
        const environment = manager.init_data.environ_map;
        const temp_dir = environment.get("BUN_TMPDIR") orelse
            environment.get("TMPDIR") orelse
            environment.get("TEMP") orelse
            environment.get("TMP") orelse
            if (builtin.os.tag == .windows) "." else "/tmp";
        const nonce: u128 = @bitCast(manager.started_ns);
        return std.fmt.allocPrint(
            manager.allocator,
            "{s}/cottontail-security-{x}-{x}.{s}",
            .{ temp_dir, nonce, std.hash.Wyhash.hash(0, manager.root_dir), suffix },
        );
    }

    fn securityScannerRuntimePath(manager: *Manager) ![:0]const u8 {
        const environment = manager.init_data.environ_map;
        const temp_dir = environment.get("BUN_TMPDIR") orelse
            environment.get("TMPDIR") orelse
            environment.get("TEMP") orelse
            environment.get("TMP") orelse
            if (builtin.os.tag == .windows) "." else "/tmp";
        if (!manager.pathExists(temp_dir)) {
            try std.Io.Dir.cwd().createDirPath(manager.init_data.io, temp_dir);
        }
        const path = try std.fmt.allocPrint(
            manager.allocator,
            "{s}/cottontail-security-runtime-{x}-{x}.mjs",
            .{
                temp_dir,
                std.hash.Wyhash.hash(0, manager.root_dir),
                std.hash.Wyhash.hash(0, security_scanner_runtime),
            },
        );
        if (try readOptionalFile(manager.init_data.io, manager.allocator, path, 1024 * 1024)) |source| {
            if (std.mem.eql(u8, source, security_scanner_runtime)) return manager.allocator.dupeZ(u8, path);
            return error.InvalidSecurityScannerRuntime;
        }

        const temporary_path = try manager.securityTempFile("runtime.mjs");
        defer std.Io.Dir.cwd().deleteFile(manager.init_data.io, temporary_path) catch {};
        try std.Io.Dir.cwd().writeFile(manager.init_data.io, .{
            .sub_path = temporary_path,
            .data = security_scanner_runtime,
        });
        std.Io.Dir.cwd().rename(
            temporary_path,
            std.Io.Dir.cwd(),
            path,
            manager.init_data.io,
        ) catch {
            const source = (try readOptionalFile(manager.init_data.io, manager.allocator, path, 1024 * 1024)) orelse
                return error.InvalidSecurityScannerRuntime;
            if (!std.mem.eql(u8, source, security_scanner_runtime)) return error.InvalidSecurityScannerRuntime;
        };
        return manager.allocator.dupeZ(u8, path);
    }

    fn writeSecurityResolution(
        manager: *Manager,
        output_path: []const u8,
        root_override: ?*const Value,
    ) !void {
        const selected_root: ?*const Value = if (root_override) |root| root else manager.root_package_json;
        const root = selected_root orelse return error.InvalidSecurityScannerPayload;
        const selected_packages = try manager.securitySelectedPackages();
        const matrix = try manager.buildSecurityMatrix(root, selected_packages);
        const payload = .{
            .packages = matrix.packages,
            .paths = matrix.paths,
        };
        const json = try std.json.Stringify.valueAlloc(manager.allocator, payload, .{});
        try std.Io.Dir.cwd().writeFile(manager.init_data.io, .{ .sub_path = output_path, .data = json });
    }

    fn securityRegistryManifestsPath(manager: *Manager, output_path: []const u8) ![]const u8 {
        return std.fmt.allocPrint(manager.allocator, "{s}.manifests", .{output_path});
    }

    fn writeSecurityRegistryManifests(manager: *Manager, output_path: []const u8) !void {
        var manifests = std.array_list.Managed(SecurityRegistryManifest).init(manager.allocator);
        var iterator = manager.registry_manifests.iterator();
        while (iterator.next()) |entry| {
            try manifests.append(.{
                .name = entry.key_ptr.*,
                .manifest = entry.value_ptr.*.*,
            });
        }
        const json = try std.json.Stringify.valueAlloc(manager.allocator, manifests.items, .{});
        const path = try manager.securityRegistryManifestsPath(output_path);
        try std.Io.Dir.cwd().writeFile(manager.init_data.io, .{ .sub_path = path, .data = json });
    }

    fn loadSecurityRegistryManifests(manager: *Manager, output_path: []const u8) !void {
        const path = try manager.securityRegistryManifestsPath(output_path);
        const source = try std.Io.Dir.cwd().readFileAlloc(
            manager.init_data.io,
            path,
            manager.allocator,
            .limited(256 * 1024 * 1024),
        );
        const manifests = std.json.parseFromSliceLeaky(Value, manager.allocator, source, .{}) catch
            return error.InvalidSecurityScannerPayload;
        if (manifests != .array) return error.InvalidSecurityScannerPayload;
        for (manifests.array.items) |*entry| {
            if (entry.* != .object) return error.InvalidSecurityScannerPayload;
            const name = entry.object.get("name") orelse return error.InvalidSecurityScannerPayload;
            const manifest = entry.object.getPtr("manifest") orelse return error.InvalidSecurityScannerPayload;
            if (name != .string or manifest.* != .object) return error.InvalidSecurityScannerPayload;
            const owned_name = try manager.allocator.dupe(u8, name.string);
            try manager.registry_manifests.put(
                owned_name,
                manifest,
            );
            if (manager.options.command == .update) {
                try manager.refreshed_update_manifests.put(
                    owned_name,
                    {},
                );
            }
        }
    }

    fn securitySelectedPackages(manager: *Manager) ![]const []const u8 {
        var selected = std.array_list.Managed([]const u8).init(manager.allocator);
        if (manager.options.positionals.len == 0) return selected.toOwnedSlice();
        switch (manager.options.command) {
            .update => try selected.appendSlice(manager.options.positionals),
            .add, .link => for (manager.options.positionals) |raw_spec| {
                const parsed = splitPackageSpec(raw_spec);
                try selected.append(parsed.name orelse raw_spec);
            },
            else => {},
        }
        return selected.toOwnedSlice();
    }

    fn isSecurityResolution(manager: *const Manager) bool {
        return manager.init_data.environ_map.get(security_resolution_output_env) != null;
    }

    fn shouldRefreshInstalledSecurityRoot(
        manager: *const Manager,
        parent_dir: []const u8,
        direct: bool,
    ) bool {
        // COTTONTAIL-COMPAT: Bun resolves every root manifest for an update
        // without a lockfile, even when the package is already materialized.
        // The scanner payload still reuses the installed archive afterwards.
        return manager.isSecurityResolution() and
            manager.options.command == .update and
            manager.lock_graph == null and
            direct and
            std.mem.eql(u8, parent_dir, manager.root_dir);
    }

    fn shouldTraverseInstalledSecurityDependencies(manager: *const Manager) bool {
        // COTTONTAIL-COMPAT: without a lockfile, Bun's scanner-backed remove
        // reuses the materialized hoisted roots without treating dependency
        // fields from packed package.json files as registry graph metadata.
        return !(manager.security_scanner != null and
            manager.options.command == .remove and
            manager.lock_graph == null);
    }

    fn buildSecurityMatrix(
        manager: *Manager,
        root: *const Value,
        selected_packages: []const []const u8,
    ) !SecurityMatrix {
        var packages = std.array_list.Managed(SecurityPackage).init(manager.allocator);
        var paths = std.array_list.Managed(SecurityPackagePath).init(manager.allocator);
        var queue = std.array_list.Managed(SecurityQueueItem).init(manager.allocator);
        var record_indices = std.StringHashMap(usize).init(manager.allocator);
        defer record_indices.deinit();
        var emitted_packages = std.StringHashMap(void).init(manager.allocator);
        defer emitted_packages.deinit();

        for (manager.records.items, 0..) |record, index| {
            try record_indices.put(recordLogicalKey(record), index);
        }

        try manager.appendSecurityManifestRoots(
            root,
            "",
            jsonString(root, "name") orelse "root",
            selected_packages,
            &record_indices,
            &queue,
        );
        var workspace_iterator = manager.workspaces.iterator();
        while (workspace_iterator.next()) |entry| {
            const workspace = entry.value_ptr.*;
            try manager.appendSecurityManifestRoots(
                workspace.package_json,
                workspace.name,
                workspace.name,
                selected_packages,
                &record_indices,
                &queue,
            );
        }

        const visited = try manager.allocator.alloc(bool, manager.records.items.len);
        @memset(visited, false);
        var cursor: usize = 0;
        while (cursor < queue.items.len) : (cursor += 1) {
            const item = queue.items[cursor];
            if (visited[item.record_index]) continue;
            visited[item.record_index] = true;

            const record = manager.records.items[item.record_index];
            if (record.kind != .npm or record.name.len == 0 or record.version.len == 0) continue;
            const identity = try std.fmt.allocPrint(manager.allocator, "{s}@{s}", .{ record.name, record.version });
            const emitted = try emitted_packages.getOrPut(identity);
            if (!emitted.found_existing) {
                const tarball = if (record.tarball.len > 0)
                    record.tarball
                else
                    try manager.defaultTarballURL(record.name, record.version);
                try packages.append(.{
                    .name = record.name,
                    .version = record.version,
                    .requestedRange = item.requested_range,
                    .tarball = tarball,
                });
                try paths.append(.{ .name = record.name, .path = item.path });
            }

            const metadata = record.metadata orelse continue;
            if (metadata.* != .object) continue;
            for ([_][]const u8{ "dependencies", "optionalDependencies", "peerDependencies" }) |section_name| {
                const section = metadata.object.get(section_name) orelse continue;
                if (section != .object) continue;
                for (section.object.keys(), section.object.values()) |alias, spec| {
                    if (spec != .string) continue;
                    const child_index = manager.providerRecordIndex(
                        &record_indices,
                        recordLogicalKey(record),
                        alias,
                        spec.string,
                    ) orelse continue;
                    if (manager.records.items[child_index].kind != .npm) continue;
                    try queue.append(.{
                        .record_index = child_index,
                        .requested_range = spec.string,
                        .path = try std.fmt.allocPrint(
                            manager.allocator,
                            "{s} \u{203a} {s}",
                            .{ item.path, alias },
                        ),
                    });
                }
            }
        }
        return .{
            .packages = try packages.toOwnedSlice(),
            .paths = try paths.toOwnedSlice(),
        };
    }

    fn appendSecurityManifestRoots(
        manager: *Manager,
        manifest: *const Value,
        importer_key: []const u8,
        owner_name: []const u8,
        selected_packages: []const []const u8,
        record_indices: *const std.StringHashMap(usize),
        queue: *std.array_list.Managed(SecurityQueueItem),
    ) !void {
        if (manifest.* != .object) return;
        for (all_dependency_sections) |section_name| {
            const section = manifest.object.get(section_name) orelse continue;
            if (section != .object) continue;
            for (section.object.keys(), section.object.values()) |alias, spec| {
                if (spec != .string) continue;
                if (selected_packages.len > 0 and !containsString(selected_packages, alias)) continue;
                const record_index = manager.providerRecordIndex(
                    record_indices,
                    importer_key,
                    alias,
                    spec.string,
                ) orelse continue;
                if (manager.records.items[record_index].kind != .npm) continue;
                try queue.append(.{
                    .record_index = record_index,
                    .requested_range = spec.string,
                    .path = try std.fmt.allocPrint(
                        manager.allocator,
                        "{s} \u{203a} {s}",
                        .{ owner_name, alias },
                    ),
                });
            }
        }
    }

    fn ensureSecurityScannerAvailable(manager: *Manager, root: *const Value) !void {
        const scanner = manager.security_scanner orelse return;
        if (std.fs.path.isAbsolute(scanner) or
            std.mem.startsWith(u8, scanner, "./") or
            std.mem.startsWith(u8, scanner, "../")) return;

        var workspace_iterator = manager.workspaces.iterator();
        while (workspace_iterator.next()) |entry| {
            const workspace = entry.value_ptr.*;
            for (all_dependency_sections) |section_name| {
                const section = workspace.package_json.object.get(section_name) orelse continue;
                if (section != .object or section.object.get(scanner) == null) continue;
                try manager.stderr.print(
                    "Security scanner '{s}' cannot be a dependency of a workspace package. It must be a direct dependency of the root package.\n",
                    .{scanner},
                );
                return error.PackageManagerErrorReported;
            }
        }

        const destination = try packageDestination(manager.allocator, manager.root_dir, scanner);
        const installed_manifest = try std.fs.path.join(manager.allocator, &.{ destination, "package.json" });
        if (manager.pathExists(installed_manifest)) return;

        const requested = securityDependencyRequest(root, scanner) orelse {
            try manager.stderr.print(
                "Security scanner '{s}' is configured in bunfig.toml but is not installed.\n  To install it, run: bun add --dev {s}\n",
                .{ scanner, scanner },
            );
            return error.PackageManagerErrorReported;
        };
        if (isLocalSpec(requested) or
            isGitSpec(requested) or
            isTarballSpec(requested) or
            std.mem.startsWith(u8, requested, "workspace:"))
        {
            try manager.stderr.print(
                "Security scanner '{s}' is configured in bunfig.toml but is not installed.\n  To install it, run: bun add --dev {s}\n",
                .{ scanner, scanner },
            );
            return error.PackageManagerErrorReported;
        }

        try manager.stdout.writeAll("Attempting to install security scanner from npm...\n");
        try manager.stdout.flush();
        try manager.prepareNodeModules();
        try manager.reserveWorkspaceRootVersions();

        var installed_from_lock = false;
        if (try manager.findLockedSelection(scanner, manager.root_dir)) |selection| {
            if (selection.package.kind == .npm and
                try manager.lockedPackageMatches(selection.package, scanner, requested, manager.root_dir))
            {
                const cycle_key = try std.fmt.allocPrint(manager.allocator, "lock:{s}", .{selection.package.key});
                try manager.resolving.put(cycle_key, {});
                defer _ = manager.resolving.remove(cycle_key);
                _ = try manager.installLockedPackage(selection, scanner, manager.root_dir, true, false, &.{});
                installed_from_lock = true;
            }
        }
        if (!installed_from_lock) {
            _ = try manager.installDependency(scanner, requested, manager.root_dir, true, false, false);
        }

        if (!manager.pathExists(installed_manifest)) {
            try manager.stderr.print(
                "Security scanner '{s}' could not be found after installation attempt.\n  If this is a local file, please check that the file exists and the path is correct.\n",
                .{scanner},
            );
            return error.PackageManagerErrorReported;
        }
        try manager.stdout.writeAll("Security scanner installed successfully.\n");
        try manager.stdout.flush();
    }

    fn runSecurityScannerPreflight(manager: *Manager, root: *const Value) !void {
        const payload_path = try manager.securityTempFile("json");
        defer std.Io.Dir.cwd().deleteFile(manager.init_data.io, payload_path) catch {};
        const manifests_path = try manager.securityRegistryManifestsPath(payload_path);
        defer std.Io.Dir.cwd().deleteFile(manager.init_data.io, manifests_path) catch {};

        var resolver_environment = try manager.init_data.environ_map.clone(manager.allocator);
        defer resolver_environment.deinit();
        try resolver_environment.put(security_resolution_output_env, payload_path);

        const original_args = manager.options.original_args;
        const resolver_args = try manager.allocator.alloc([]const u8, original_args.len + 3);
        for (original_args, 0..) |arg, index| resolver_args[index] = arg;
        resolver_args[original_args.len] = "--dry-run";
        resolver_args[original_args.len + 1] = "--silent";
        resolver_args[original_args.len + 2] = "--no-summary";

        var resolver = try std.process.spawn(manager.init_data.io, .{
            .argv = resolver_args,
            .cwd = .{ .path = manager.invocation_dir },
            .environ_map = &resolver_environment,
            .stdin = .ignore,
            .stdout = .ignore,
            .stderr = .inherit,
            .create_no_window = true,
        });
        defer resolver.kill(manager.init_data.io);
        const resolver_result = try resolver.wait(manager.init_data.io);
        if (packageManagerChildExitCode(resolver_result) != 0) return error.PackageManagerErrorReported;
        try manager.loadSecurityRegistryManifests(payload_path);

        const resolved_payload = try std.Io.Dir.cwd().readFileAlloc(
            manager.init_data.io,
            payload_path,
            manager.allocator,
            .limited(64 * 1024 * 1024),
        );
        const parsed_payload = std.json.parseFromSliceLeaky(
            Value,
            manager.allocator,
            resolved_payload,
            .{},
        ) catch return error.InvalidSecurityScannerPayload;
        const resolved_packages = if (parsed_payload == .object)
            parsed_payload.object.get("packages")
        else
            null;
        if (resolved_packages == null or
            resolved_packages.? != .array or
            resolved_packages.?.array.items.len == 0)
        {
            try manager.writeSecurityResolution(payload_path, root);
        }

        try manager.ensureSecurityScannerAvailable(root);
        try manager.runSecurityScannerPayload(payload_path, "install");
    }

    fn runSecurityScannerPayload(manager: *Manager, payload_path: []const u8, mode: []const u8) !void {
        const scanner = manager.security_scanner orelse return;
        const result_path = try manager.securityTempFile("result.json");
        defer std.Io.Dir.cwd().deleteFile(manager.init_data.io, result_path) catch {};
        const scanner_args = [_][:0]const u8{
            try manager.allocator.dupeZ(u8, scanner),
            try manager.allocator.dupeZ(u8, manager.root_dir),
            try manager.allocator.dupeZ(u8, payload_path),
            try manager.allocator.dupeZ(u8, result_path),
        };
        const runtime_path = try manager.securityScannerRuntimePath();
        const scanner_exit_code = ScriptRunner.run(
            manager.init_data,
            runtime_path,
            &scanner_args,
        ) catch |err| {
            try manager.stderr.print("Security scanner failed: {s}\n", .{@errorName(err)});
            return error.PackageManagerErrorReported;
        };
        const result_source = std.Io.Dir.cwd().readFileAlloc(
            manager.init_data.io,
            result_path,
            manager.allocator,
            .limited(64 * 1024 * 1024),
        ) catch |err| {
            if (scanner_exit_code != 0) {
                try manager.stderr.print(
                    "Security scanner exited with code {d} without sending data\n",
                    .{scanner_exit_code},
                );
            } else {
                try manager.stderr.print("Security scanner failed: {s}\n", .{@errorName(err)});
            }
            return error.PackageManagerErrorReported;
        };
        if (scanner_exit_code != 0) {
            try manager.stderr.print(
                "Security scanner exited with code {d} without sending data\n",
                .{scanner_exit_code},
            );
            return error.PackageManagerErrorReported;
        }
        const result = std.json.parseFromSliceLeaky(Value, manager.allocator, result_source, .{}) catch {
            return manager.failSecurityScanner("returned invalid JSON");
        };
        try manager.handleSecurityScannerResult(payload_path, mode, &result);
    }

    fn handleSecurityScannerResult(
        manager: *Manager,
        payload_path: []const u8,
        mode: []const u8,
        result: *const Value,
    ) !void {
        if (result.* != .object) return manager.failSecurityScanner("returned an invalid result envelope");
        const ok = result.object.get("ok") orelse return manager.failSecurityScanner("returned an invalid result envelope");
        if (ok != .bool) return manager.failSecurityScanner("returned an invalid result envelope");
        if (!ok.bool) {
            if (result.object.get("exitCode")) |exit_code| {
                if (exit_code == .integer) {
                    try manager.stderr.print(
                        "Security scanner exited with code {d} without sending data\n",
                        .{exit_code.integer},
                    );
                    try manager.stderr.flush();
                    return error.PackageManagerErrorReported;
                }
            }
            const message = result.object.get("error") orelse return manager.failSecurityScanner("failed without an error message");
            if (message != .string) return manager.failSecurityScanner("failed without an error message");
            return manager.failSecurityScanner(message.string);
        }

        const advisories = result.object.get("advisories") orelse
            return manager.failSecurityScanner("Security scanner must return an array of advisories");
        if (advisories != .array) return manager.failSecurityScanner("Security scanner must return an array of advisories");
        for (advisories.array.items, 0..) |*advisory, index| {
            try manager.validateSecurityAdvisory(advisory, index);
        }

        const payload_source = try std.Io.Dir.cwd().readFileAlloc(
            manager.init_data.io,
            payload_path,
            manager.allocator,
            .limited(64 * 1024 * 1024),
        );
        const payload = std.json.parseFromSliceLeaky(Value, manager.allocator, payload_source, .{}) catch
            return error.InvalidSecurityScannerPayload;

        var fatal: usize = 0;
        var warnings: usize = 0;
        for (advisories.array.items) |advisory| {
            const package_name = advisory.object.get("package").?.string;
            const level = advisory.object.get("level").?.string;
            if (std.mem.eql(u8, level, "fatal")) fatal += 1 else warnings += 1;
            try manager.stdout.print("{s}: {s}\n", .{
                if (std.mem.eql(u8, level, "fatal")) "FATAL" else "WARNING",
                package_name,
            });
            if (securityPackagePath(&payload, package_name)) |package_path| {
                try manager.stdout.print("via {s}\n", .{package_path});
            }
            if (advisory.object.get("description")) |description| {
                if (description == .string and description.string.len > 0) {
                    try manager.stdout.print("{s}\n", .{description.string});
                }
            }
            if (advisory.object.get("url")) |url| {
                if (url == .string and url.string.len > 0) try manager.stdout.print("{s}\n", .{url.string});
            }
        }

        if (advisories.array.items.len == 0) {
            if (std.mem.eql(u8, mode, "scan")) try manager.stdout.writeAll("No advisories found\n");
            try manager.stdout.flush();
            return;
        }
        try manager.stdout.print("{d} advisor{s} (", .{
            advisories.array.items.len,
            if (advisories.array.items.len == 1) "y" else "ies",
        });
        if (fatal > 0) try manager.stdout.print("{d} fatal", .{fatal});
        if (fatal > 0 and warnings > 0) try manager.stdout.writeAll(", ");
        if (warnings > 0) try manager.stdout.print("{d} warning{s}", .{
            warnings,
            if (warnings == 1) "" else "s",
        });
        try manager.stdout.writeAll(")\n");
        if (std.mem.eql(u8, mode, "scan")) {
            try manager.stdout.flush();
            return error.PackageManagerErrorReported;
        }
        if (fatal > 0) {
            try manager.stdout.writeAll("Installation aborted due to fatal security advisories\n");
            try manager.stdout.flush();
            return error.PackageManagerErrorReported;
        }
        if (try manager.promptForSecurityWarnings()) {
            try manager.stdout.flush();
            return;
        }
        try manager.stdout.flush();
        return error.PackageManagerErrorReported;
    }

    fn promptForSecurityWarnings(manager: *Manager) !bool {
        if (!(std.Io.File.stdin().isTty(manager.init_data.io) catch false)) {
            try manager.stdout.writeAll(
                "\nSecurity warnings found. Cannot prompt for confirmation (no TTY).\n" ++
                    "Installation cancelled.\n",
            );
            return false;
        }

        try manager.stdout.writeAll("\nSecurity warnings found. Continue anyway? [y/N] ");
        try manager.stdout.flush();

        var input_buffer: [1024]u8 = undefined;
        var stdin_reader = std.Io.File.stdin().readerStreaming(manager.init_data.io, &input_buffer);
        const line = (stdin_reader.interface.takeDelimiter('\n') catch null) orelse {
            try manager.stdout.writeAll("\nInstallation cancelled.\n");
            return false;
        };
        const response = std.mem.trim(u8, line, " \t\r");
        if (!std.mem.eql(u8, response, "y") and !std.mem.eql(u8, response, "Y")) {
            try manager.stdout.writeAll("\nInstallation cancelled.\n");
            return false;
        }

        try manager.stdout.writeAll("\nContinuing with installation...\n\n");
        return true;
    }

    fn validateSecurityAdvisory(manager: *Manager, advisory: *const Value, index: usize) !void {
        if (advisory.* != .object) {
            const message = try std.fmt.allocPrint(manager.allocator, "Security advisory at index {d} must be an object", .{index});
            return manager.failSecurityScanner(message);
        }
        const package_name = advisory.object.get("package") orelse {
            const message = try std.fmt.allocPrint(manager.allocator, "Security advisory at index {d} missing required 'package' field", .{index});
            return manager.failSecurityScanner(message);
        };
        if (package_name != .string) {
            const message = try std.fmt.allocPrint(manager.allocator, "Security advisory at index {d} 'package' field must be a string", .{index});
            return manager.failSecurityScanner(message);
        }
        if (package_name.string.len == 0) {
            const message = try std.fmt.allocPrint(manager.allocator, "Security advisory at index {d} 'package' field cannot be empty", .{index});
            return manager.failSecurityScanner(message);
        }
        for ([_][]const u8{ "description", "url" }) |field_name| {
            const field = advisory.object.get(field_name) orelse continue;
            if (field != .string and field != .null) {
                const message = try std.fmt.allocPrint(
                    manager.allocator,
                    "Security advisory at index {d} '{s}' field must be a string or null",
                    .{ index, field_name },
                );
                return manager.failSecurityScanner(message);
            }
        }
        const level = advisory.object.get("level") orelse {
            const message = try std.fmt.allocPrint(manager.allocator, "Security advisory at index {d} missing required 'level' field", .{index});
            return manager.failSecurityScanner(message);
        };
        if (level != .string) {
            const message = try std.fmt.allocPrint(manager.allocator, "Security advisory at index {d} 'level' field must be a string", .{index});
            return manager.failSecurityScanner(message);
        }
        if (!std.mem.eql(u8, level.string, "fatal") and !std.mem.eql(u8, level.string, "warn")) {
            const message = try std.fmt.allocPrint(
                manager.allocator,
                "Security advisory at index {d} 'level' field must be 'fatal' or 'warn'",
                .{index},
            );
            return manager.failSecurityScanner(message);
        }
    }

    fn failSecurityScanner(manager: *Manager, message: []const u8) error{PackageManagerErrorReported} {
        manager.stderr.print("Security scanner failed: {s}\n", .{message}) catch {};
        manager.stderr.flush() catch {};
        return error.PackageManagerErrorReported;
    }

    fn globalLinkPackageSpecs(manager: *Manager) ![]const []const u8 {
        const specs = try manager.allocator.alloc([]const u8, manager.options.positionals.len);
        for (manager.options.positionals, specs) |name, *spec| {
            if (!isValidGlobalLinkName(name)) {
                try manager.stderr.print("error: Invalid package name \"{s}\"\n", .{name});
                return error.PackageManagerErrorReported;
            }
            spec.* = try std.fmt.allocPrint(manager.allocator, "{s}@link:{s}", .{ name, name });
        }
        return specs;
    }

    fn registerGlobalLink(manager: *Manager) !u8 {
        const package_json = try manager.readLinkPackageJSON();
        const name = jsonString(package_json, "name") orelse {
            try manager.stderr.writeAll("error: package.json missing \"name\"\n");
            return error.PackageManagerErrorReported;
        };
        if (!isValidGlobalLinkName(name)) {
            try manager.stderr.print("error: invalid package.json name \"{s}\"\n", .{name});
            return error.PackageManagerErrorReported;
        }

        if (!manager.options.silent) {
            try manager.stdout.print("bun link v{s} (cottontail v{s})\n\n", .{ bun_compat_version, version });
        }
        if (!manager.options.dry_run) {
            const node_modules = try globalLinkNodeModulesPath(manager.init_data, manager.allocator);
            try std.Io.Dir.cwd().createDirPath(manager.init_data.io, node_modules);
            const destination = try std.fs.path.join(manager.allocator, &.{ node_modules, name });
            try manager.linkDirectoryAt(destination, manager.invocation_package_dir);

            const bin_dir = try globalBinPath(manager.init_data, manager.allocator);
            try manager.linkBinsInDirectory(name, manager.invocation_package_dir, package_json, false, bin_dir);
        }

        if (!manager.options.silent) {
            try manager.stdout.print(
                "Success! Registered \"{s}\"\n\nTo use {s} in a project, run:\n  bun link {s}\n\nOr add it in dependencies in your package.json file:\n  \"{s}\": \"link:{s}\"\n",
                .{ name, name, name, name, name },
            );
            try manager.stdout.flush();
        }
        return 0;
    }

    fn unregisterGlobalLink(manager: *Manager) !u8 {
        const package_json = try manager.readLinkPackageJSON();
        const name = jsonString(package_json, "name") orelse {
            try manager.stderr.writeAll("error: package.json missing \"name\"\n");
            return error.PackageManagerErrorReported;
        };
        if (!isValidGlobalLinkName(name)) {
            try manager.stderr.print("error: invalid package.json name \"{s}\"\n", .{name});
            return error.PackageManagerErrorReported;
        }

        if (!manager.options.silent) {
            try manager.stdout.print("bun unlink v{s} (cottontail v{s})\n\n", .{ bun_compat_version, version });
        }
        const node_modules = try globalLinkNodeModulesPath(manager.init_data, manager.allocator);
        const destination = try std.fs.path.join(manager.allocator, &.{ node_modules, name });
        const linked = std.Io.Dir.cwd().statFile(manager.init_data.io, destination, .{ .follow_symlinks = false }) catch null;
        if (linked == null or linked.?.kind != .sym_link) {
            if (!manager.options.silent) {
                try manager.stdout.print("success: package \"{s}\" is not globally linked, so there's nothing to do.\n", .{name});
                try manager.stdout.flush();
            }
            return 0;
        }

        if (!manager.options.dry_run) {
            deletePath(manager.init_data.io, destination);
            const bin_dir = try globalBinPath(manager.init_data, manager.allocator);
            try manager.unlinkBinsInDirectory(name, package_json, bin_dir);
        }
        if (!manager.options.silent) {
            try manager.stdout.print("success: unlinked package \"{s}\"\n", .{name});
            try manager.stdout.flush();
        }
        return 0;
    }

    fn readLinkPackageJSON(manager: *Manager) !*Value {
        const path = try std.fs.path.join(manager.allocator, &.{ manager.invocation_package_dir, "package.json" });
        const source = std.Io.Dir.cwd().readFileAlloc(
            manager.init_data.io,
            path,
            manager.allocator,
            .limited(16 * 1024 * 1024),
        ) catch |err| {
            try manager.stderr.print("error: failed to read \"{s}\" for linking: {s}\n", .{ path, @errorName(err) });
            return error.PackageManagerErrorReported;
        };
        const package_json = try manager.allocator.create(Value);
        package_json.* = PackageJSON.parsePackageJSON(manager.allocator, path, source) catch {
            try manager.stderr.print("error: invalid package.json in \"{s}\"\n", .{manager.invocation_package_dir});
            return error.PackageManagerErrorReported;
        };
        if (package_json.* != .object) return error.InvalidPackageJSON;
        return package_json;
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
        try manager.reconcileIsolatedPeerGraph();
        try manager.finalizeIsolatedNodeModules();
        try manager.writeTextLockfile(root, true);
        if (!manager.options.ignore_scripts and !manager.options.dry_run and !manager.options.lockfile_only) {
            try manager.script_queue.run(manager.init_data, manager.root_dir, manager.options.concurrent_scripts, manager.stderr);
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
            const destination = manager.patchDestinationForKey(package.key) catch |err| {
                if (manager.init_data.environ_map.get("COTTONTAIL_PM_ERROR_TRACE") != null) {
                    try manager.stderr.print("patch target skipped {s}: {s}\n", .{ package.key, @errorName(err) });
                }
                continue;
            };
            const identity = manager.readInstalledPackageJSON(destination) catch |err| {
                if (manager.init_data.environ_map.get("COTTONTAIL_PM_ERROR_TRACE") != null) {
                    try manager.stderr.print("patch target missing {s} at {s}: {s}\n", .{ package.key, destination, @errorName(err) });
                }
                continue;
            };
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
            const public_destination = try Patch.Spec.destinationForLockKey(manager.allocator, manager.root_dir, key);
            const public_manifest = try std.fs.path.join(manager.allocator, &.{ public_destination, "package.json" });
            if (manager.pathExists(public_manifest)) return public_destination;

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
        if (manager.cache_directory) |install_cache| {
            try std.Io.Dir.cwd().createDirPath(manager.init_data.io, install_cache);
        }
        const node_modules = try std.fs.path.join(manager.allocator, &.{ manager.root_dir, "node_modules" });
        const node_modules_existed = manager.pathExists(node_modules);
        const uses_explicit_install_cache = manager.init_data.environ_map.get("BUN_INSTALL_CACHE_DIR") != null;
        if (manager.node_linker == .isolated) {
            // Bun establishes the project cache before converting an add to
            // isolated layout. Preserve that ordering so the migration leaves
            // the same .old_modules-* holding directory on a first add.
            if (!uses_explicit_install_cache and manager.options.command == .add and !manager.pathExists(node_modules)) {
                const initial_cache = try std.fs.path.join(manager.allocator, &.{ node_modules, ".cache" });
                try std.Io.Dir.cwd().createDirPath(manager.init_data.io, initial_cache);
            }
            try manager.isolated_managed_modules.put(try manager.allocator.dupe(u8, node_modules), {});
            const hidden_modules = try std.fs.path.join(manager.allocator, &.{ node_modules, ".bun", "node_modules" });
            try manager.isolated_managed_modules.put(try manager.allocator.dupe(u8, hidden_modules), {});
            try manager.prepareIsolatedNodeModules(node_modules);
        } else {
            try std.Io.Dir.cwd().createDirPath(manager.init_data.io, node_modules);
        }
        const install_reuses_lockfile = manager.options.command == .install and manager.lock_graph != null;
        const create_project_cache = if (manager.node_linker == .isolated)
            manager.options.command == .add
        else
            !install_reuses_lockfile and
                (manager.lock_graph == null or !node_modules_existed) and
                (manager.options.command == .add or manager.options.command == .install or manager.options.command == .update or
                    manager.options.cpu_overridden or manager.options.os_overridden);
        if (!uses_explicit_install_cache and create_project_cache) {
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
            const path = try std.fs.path.join(manager.allocator, &.{ store, entry.name });
            if (manager.isManagedDirectoryLink(path, entry.kind)) {
                try manager.removeManagedDirectoryLink(path);
            } else {
                deletePath(manager.init_data.io, path);
            }
        }

        // Bun intentionally preserves the migration holding directory. Apart
        // from matching its observable layout, this leaves a recoverable copy
        // of packages displaced while converting a hoisted tree to isolated.
    }

    fn pruneManagedModuleLinks(manager: *Manager, modules_dir: []const u8) !void {
        try manager.pruneManagedBinLinks(try std.fs.path.join(manager.allocator, &.{ modules_dir, ".bin" }));
        var directory = std.Io.Dir.cwd().openDir(manager.init_data.io, modules_dir, .{ .iterate = true }) catch return;
        defer directory.close(manager.init_data.io);
        var iterator = directory.iterate();
        while (try iterator.next(manager.init_data.io)) |entry| {
            if (entry.name.len == 0 or entry.name[0] == '.') continue;
            const path = try std.fs.path.join(manager.allocator, &.{ modules_dir, entry.name });
            if (manager.isManagedDirectoryLink(path, entry.kind)) {
                if (!manager.isolated_live_links.contains(path)) {
                    if (manager.init_data.environ_map.get("COTTONTAIL_PM_ERROR_TRACE") != null) {
                        try manager.stderr.print("isolated prune: {s}\n", .{path});
                    }
                    try manager.removeManagedDirectoryLink(path);
                }
                continue;
            }
            if (entry.kind != .directory or entry.name[0] != '@') continue;
            try manager.pruneManagedScopeLinks(path);
            std.Io.Dir.cwd().deleteDir(manager.init_data.io, path) catch {};
        }
    }

    fn pruneManagedBinLinks(manager: *Manager, bin_dir: []const u8) !void {
        var directory = std.Io.Dir.cwd().openDir(manager.init_data.io, bin_dir, .{ .iterate = true }) catch return;
        defer directory.close(manager.init_data.io);
        var iterator = directory.iterate();
        while (try iterator.next(manager.init_data.io)) |entry| {
            if (entry.name.len == 0 or entry.name[0] == '.') continue;
            const path = try std.fs.path.join(manager.allocator, &.{ bin_dir, entry.name });
            if (manager.isolated_live_links.contains(path)) continue;
            if (manager.isManagedDirectoryLink(path, entry.kind)) {
                try manager.removeManagedDirectoryLink(path);
            } else {
                deletePath(manager.init_data.io, path);
            }
        }
    }

    fn pruneManagedScopeLinks(manager: *Manager, scope_dir: []const u8) !void {
        var directory = std.Io.Dir.cwd().openDir(manager.init_data.io, scope_dir, .{ .iterate = true }) catch return;
        defer directory.close(manager.init_data.io);
        var iterator = directory.iterate();
        while (try iterator.next(manager.init_data.io)) |entry| {
            if (entry.name.len == 0 or entry.name[0] == '.') continue;
            const path = try std.fs.path.join(manager.allocator, &.{ scope_dir, entry.name });
            if (manager.isManagedDirectoryLink(path, entry.kind) and !manager.isolated_live_links.contains(path)) {
                if (manager.init_data.environ_map.get("COTTONTAIL_PM_ERROR_TRACE") != null) {
                    try manager.stderr.print("isolated prune: {s}\n", .{path});
                }
                try manager.removeManagedDirectoryLink(path);
            }
        }
    }

    fn isManagedDirectoryLink(manager: *Manager, path: []const u8, kind_hint: std.Io.File.Kind) bool {
        if (kind_hint == .sym_link) return true;
        const stat = std.Io.Dir.cwd().statFile(manager.init_data.io, path, .{ .follow_symlinks = false }) catch return false;
        return stat.kind == .sym_link;
    }

    fn removeManagedDirectoryLink(manager: *Manager, path: []const u8) !void {
        std.Io.Dir.cwd().deleteDir(manager.init_data.io, path) catch {
            std.Io.Dir.cwd().deleteFile(manager.init_data.io, path) catch |err| switch (err) {
                error.FileNotFound => {},
                else => return err,
            };
        };
    }

    const CertificateFileStatus = enum { valid, missing, invalid };

    fn inspectCertificateFile(manager: *Manager, path: []const u8) !CertificateFileStatus {
        const source = std.Io.Dir.cwd().readFileAlloc(
            manager.init_data.io,
            path,
            manager.allocator,
            .limited(16 * 1024 * 1024),
        ) catch |err| switch (err) {
            error.FileNotFound => return .missing,
            error.OutOfMemory => return err,
            else => return .invalid,
        };
        if (std.mem.findPos(u8, source, 0, "-----BEGIN CERTIFICATE-----") == null) return .invalid;

        var bundle: std.crypto.Certificate.Bundle = .empty;
        defer bundle.deinit(manager.client.allocator);
        const now = std.Io.Clock.real.now(manager.init_data.io);
        bundle.addCertsFromFilePathAbsolute(
            manager.client.allocator,
            manager.init_data.io,
            now,
            path,
        ) catch |err| switch (err) {
            error.FileNotFound => return .missing,
            error.OutOfMemory => return err,
            else => return .invalid,
        };
        return .valid;
    }

    fn certificateAuthorityTempFile(manager: *Manager, index: usize) ![]const u8 {
        const environment = manager.init_data.environ_map;
        const temp_dir = environment.get("BUN_TMPDIR") orelse
            environment.get("TMPDIR") orelse
            environment.get("TEMP") orelse
            environment.get("TMP") orelse
            if (builtin.os.tag == .windows) "." else "/tmp";
        if (!manager.pathExists(temp_dir)) {
            try std.Io.Dir.cwd().createDirPath(manager.init_data.io, temp_dir);
        }
        const nonce: u128 = @bitCast(manager.started_ns);
        const path = try std.fmt.allocPrint(
            manager.allocator,
            "{s}/cottontail-ca-{x}-{x}-{d}.pem",
            .{ temp_dir, nonce, std.hash.Wyhash.hash(0, manager.root_dir), index },
        );
        return absolutePathFrom(manager.allocator, manager.invocation_dir, path);
    }

    fn reportCertificateFileError(manager: *Manager, status: CertificateFileStatus, path: []const u8) !void {
        switch (status) {
            .missing => try manager.stderr.print("HTTPThread: could not find CA file: '{s}'\n", .{path}),
            .invalid => try manager.stderr.print("HTTPThread: invalid CA file: '{s}'\n", .{path}),
            .valid => unreachable,
        }
    }

    fn configureCertificateAuthorities(manager: *Manager) !void {
        if (manager.certificate_authorities.len == 0 and manager.certificate_authority_file == null) return;

        const ca_file_path = if (manager.certificate_authority_file) |path|
            try absolutePathFrom(manager.allocator, manager.invocation_dir, path)
        else
            null;
        if (ca_file_path) |path| {
            const status = try manager.inspectCertificateFile(path);
            if (status != .valid) {
                try manager.reportCertificateFileError(status, path);
                return error.PackageManagerErrorReported;
            }
        }

        var temporary_files = std.array_list.Managed([]const u8).init(manager.allocator);
        defer {
            for (temporary_files.items) |path| {
                std.Io.Dir.cwd().deleteFile(manager.init_data.io, path) catch {};
            }
            temporary_files.deinit();
        }
        for (manager.certificate_authorities, 0..) |certificate, index| {
            const path = try manager.certificateAuthorityTempFile(index);
            try std.Io.Dir.cwd().writeFile(manager.init_data.io, .{ .sub_path = path, .data = certificate });
            try temporary_files.append(path);
            if (try manager.inspectCertificateFile(path) != .valid) {
                try manager.stderr.writeAll("HTTPThread: the CA is invalid\n");
                return error.PackageManagerErrorReported;
            }
        }

        const now = std.Io.Clock.real.now(manager.init_data.io);
        try manager.client.ca_bundle.rescan(manager.client.allocator, manager.init_data.io, now);
        if (ca_file_path) |path| {
            manager.client.ca_bundle.addCertsFromFilePathAbsolute(
                manager.client.allocator,
                manager.init_data.io,
                now,
                path,
            ) catch {
                try manager.stderr.print("HTTPThread: invalid CA file: '{s}'\n", .{path});
                return error.PackageManagerErrorReported;
            };
        }
        for (temporary_files.items) |path| {
            manager.client.ca_bundle.addCertsFromFilePathAbsolute(
                manager.client.allocator,
                manager.init_data.io,
                now,
                path,
            ) catch {
                try manager.stderr.writeAll("HTTPThread: the CA is invalid\n");
                return error.PackageManagerErrorReported;
            };
        }
        manager.client.now = now;
    }

    fn globalDirectoryFromBunfig(manager: *Manager, path: []const u8) !?[]const u8 {
        const source_text = (try readOptionalFile(manager.init_data.io, manager.allocator, path, 1024 * 1024)) orelse return null;
        var ast_memory_allocator: compiler.ast.ASTMemoryAllocator = undefined;
        var ast_scope = ast_memory_allocator.enter(manager.allocator);
        defer ast_scope.exit();

        var log = compiler.logger.Log.init(manager.allocator);
        defer log.deinit();
        const source = compiler.logger.Source.initPathString(path, source_text);
        const root = compiler.interchange.toml.TOML.parse(&source, &log, manager.allocator, true) catch return null;
        if (log.hasErrors()) return null;
        const install = root.get("install") orelse return null;
        const global_dir = install.get("globalDir") orelse return null;
        return global_dir.asString(manager.allocator);
    }

    fn resolveGlobalInstallRoot(manager: *Manager) ![]const u8 {
        if (manager.init_data.environ_map.get("BUN_INSTALL_GLOBAL_DIR")) |path| {
            return absolutePathFrom(manager.allocator, manager.invocation_dir, path);
        }

        var configured: ?[]const u8 = null;
        if (manager.init_data.environ_map.get("XDG_CONFIG_HOME") orelse manager.init_data.environ_map.get("HOME")) |home| {
            const global_bunfig = try std.fs.path.join(manager.allocator, &.{ home, ".bunfig.toml" });
            configured = try manager.globalDirectoryFromBunfig(global_bunfig);
        }
        if (manager.options.config_path) |config_path| {
            configured = (try manager.globalDirectoryFromBunfig(config_path)) orelse configured;
        }
        if (configured) |path| return absolutePathFrom(manager.allocator, manager.invocation_dir, path);

        if (manager.init_data.environ_map.get("BUN_INSTALL")) |home| {
            return std.fs.path.join(manager.allocator, &.{ home, "install", "global" });
        }
        if (manager.init_data.environ_map.get("XDG_CACHE_HOME") orelse manager.init_data.environ_map.get("HOME")) |home| {
            return std.fs.path.join(manager.allocator, &.{ home, ".bun", "install", "global" });
        }
        if (manager.init_data.environ_map.get("USERPROFILE")) |home| {
            return std.fs.path.join(manager.allocator, &.{ home, ".bun", "install", "global" });
        }
        return error.MissingGlobalInstallDirectory;
    }

    fn loadConfiguration(manager: *Manager) !void {
        var registry = manager.options.registry;
        var configured_linker = manager.options.linker;
        if (registry == null) registry = manager.init_data.environ_map.get("BUN_CONFIG_REGISTRY");
        if (registry == null) registry = manager.init_data.environ_map.get("npm_config_registry");
        if (registry == null) registry = manager.init_data.environ_map.get("NPM_CONFIG_REGISTRY");
        const registry_explicit = registry != null;
        const linker_explicit = configured_linker != null;
        if (manager.init_data.environ_map.get("BUN_CONFIG_HTTP_RETRY_COUNT")) |value| {
            manager.max_retry_count = std.fmt.parseInt(u16, value, 10) catch manager.max_retry_count;
        }
        if (manager.init_data.environ_map.get("BUN_CONFIG_TOKEN") orelse
            manager.init_data.environ_map.get("NPM_CONFIG_TOKEN")) |token|
        {
            manager.registry_authorization = try std.fmt.allocPrint(manager.allocator, "Bearer {s}", .{token});
        } else if (manager.init_data.environ_map.get("BUN_CONFIG_USERNAME")) |username| {
            if (manager.init_data.environ_map.get("BUN_CONFIG_PASSWORD")) |password| {
                manager.registry_username = username;
                const credentials = try std.fmt.allocPrint(manager.allocator, "{s}:{s}", .{ username, password });
                const encoded_len = std.base64.standard.Encoder.calcSize(credentials.len);
                const encoded = try manager.allocator.alloc(u8, encoded_len);
                _ = std.base64.standard.Encoder.encode(encoded, credentials);
                manager.registry_authorization = try std.fmt.allocPrint(manager.allocator, "Basic {s}", .{encoded});
            }
        }

        const authorization_explicit = manager.registry_authorization != null;
        try manager.loadGlobalBunfigInstallConfiguration(
            &registry,
            &configured_linker,
            registry_explicit,
            linker_explicit,
        );

        const bunfig_path = manager.options.config_path orelse
            try std.fs.path.join(manager.allocator, &.{ manager.root_dir, "bunfig.toml" });
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
            try manager.validateBunfigSyntax(bunfig_path, source);
            if (try manager.loadBunfigInstallConfiguration(bunfig_path, source)) |configured| {
                if (!registry_explicit) registry = configured.url;
                if (!authorization_explicit) manager.registry_authorization = configured.authorization;
            }
            if (!registry_explicit) {
                if (parseTomlString(source, "registry")) |value| registry = value;
            }
            if (!linker_explicit) {
                if (parseTomlString(source, "linker")) |value| {
                    configured_linker = Isolated.Linker.parse(value) orelse return error.UnsupportedPackageManagerLinker;
                }
            }
            if (parseTomlBool(source, "saveTextLockfile")) |value| {
                manager.save_text_lockfile = value;
                manager.save_text_lockfile_configured = true;
            }
            if (parseTomlBool(source, "exact")) |value| manager.options.exact = value;
            if (parseTomlBool(source, "frozenLockfile")) |value| manager.options.frozen_lockfile = value;
            if (parseTomlBool(source, "dev")) |value| {
                if (!value) manager.options.omit_dev = true;
            }
            if (parseTomlBool(source, "optional")) |value| {
                if (!value) manager.options.omit_optional = true;
            }
            if (parseTomlBool(source, "peer")) |value| {
                if (!value) manager.options.omit_peer = true;
            }
            if (parseTomlBool(source, "linkWorkspacePackages")) |value| manager.link_workspace_packages = value;
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
        if (manager.options.save_text_lockfile) {
            manager.save_text_lockfile = true;
            manager.save_text_lockfile_configured = true;
        }

        try manager.loadNpmrcConfiguration(&registry);
        if (manager.init_data.environ_map.get("BUN_INSTALL_CACHE_DIR")) |directory| {
            manager.options.no_cache = false;
            manager.cache_directory = try manager.allocator.dupe(u8, directory);
        }
        if (!manager.options.no_cache and manager.cache_directory == null) {
            manager.cache_directory = try packageCachePath(manager.init_data, manager.allocator);
        }

        manager.linker_configured = configured_linker != null;
        manager.node_linker = configured_linker orelse try manager.inferUnconfiguredLinker();

        manager.registry_source = try manager.allocator.dupe(u8, registry orelse default_registry);
        manager.registry = try normalizeRegistryUrl(manager.allocator, manager.registry_source);
        if (manager.options.global) {
            const configured_bin = if (manager.init_data.environ_map.get("BUN_INSTALL_BIN") != null)
                null
            else
                manager.global_bin_directory;
            const bin_path = configured_bin orelse try globalBinPath(manager.init_data, manager.allocator);
            manager.global_bin_directory = try absolutePathFrom(manager.allocator, manager.root_dir, bin_path);
        }
        try manager.configureCertificateAuthorities();
    }

    fn loadGlobalBunfigInstallConfiguration(
        manager: *Manager,
        registry: *?[]const u8,
        configured_linker: *?Isolated.Linker,
        registry_explicit: bool,
        linker_explicit: bool,
    ) !void {
        const config_home = manager.init_data.environ_map.get("XDG_CONFIG_HOME") orelse
            manager.init_data.environ_map.get("HOME") orelse
            return;
        const path = try std.fs.path.join(manager.allocator, &.{ config_home, ".bunfig.toml" });
        const source = (try readOptionalFile(manager.init_data.io, manager.allocator, path, 1024 * 1024)) orelse return;
        try manager.validateBunfigSyntax(path, source);
        if (try manager.loadBunfigInstallConfiguration(path, source)) |configured| {
            if (!registry_explicit) registry.* = configured.url;
            if (manager.registry_authorization == null) manager.registry_authorization = configured.authorization;
        }
        if (!registry_explicit) {
            if (parseTomlString(source, "registry")) |value| registry.* = value;
        }
        if (!linker_explicit) {
            if (parseTomlString(source, "linker")) |value| {
                configured_linker.* = Isolated.Linker.parse(value) orelse return error.UnsupportedPackageManagerLinker;
            }
        }
    }

    fn validateBunfigSyntax(manager: *Manager, path: []const u8, source_text: []const u8) !void {
        var ast_memory_allocator: compiler.ast.ASTMemoryAllocator = undefined;
        var ast_scope = ast_memory_allocator.enter(manager.allocator);
        defer ast_scope.exit();

        var log = compiler.logger.Log.init(manager.allocator);
        defer log.deinit();
        const source = compiler.logger.Source.initPathString(path, source_text);
        _ = compiler.interchange.toml.TOML.parse(&source, &log, manager.allocator, true) catch {
            if (!log.hasErrors()) {
                try log.addErrorOpts("Failed to parse bunfig.toml", .{
                    .source = &source,
                    .redact_sensitive_information = true,
                });
            }
            try log.print(manager.stderr);
            return error.PackageManagerErrorReported;
        };
        if (log.hasErrors()) {
            try log.print(manager.stderr);
            return error.PackageManagerErrorReported;
        }
    }

    fn loadBunfigInstallConfiguration(manager: *Manager, path: []const u8, source_text: []const u8) !?RegistryConfig {
        var ast_memory_allocator: compiler.ast.ASTMemoryAllocator = undefined;
        var ast_scope = ast_memory_allocator.enter(manager.allocator);
        defer ast_scope.exit();

        var log = compiler.logger.Log.init(manager.allocator);
        defer log.deinit();
        const source = compiler.logger.Source.initPathString(path, source_text);
        const root = try compiler.interchange.toml.TOML.parse(&source, &log, manager.allocator, true);
        const install = root.get("install") orelse return null;
        var default_registry_config: ?RegistryConfig = null;
        if (install.get("globalDir")) |global_dir| {
            if (global_dir.asString(manager.allocator)) |value| manager.global_install_directory = value;
        }
        if (install.get("globalBinDir")) |global_bin_dir| {
            if (global_bin_dir.asString(manager.allocator)) |value| manager.global_bin_directory = value;
        }
        if (install.get("cafile")) |cafile| {
            const value = cafile.asString(manager.allocator) orelse {
                try manager.stderr.print("{s}: Invalid cafile. Expected a string.\n", .{path});
                return error.PackageManagerErrorReported;
            };
            if (manager.options.ca_file_name == null) manager.certificate_authority_file = value;
        }
        if (install.get("ca")) |ca| {
            const configured: []const []const u8 = switch (ca.data) {
                .e_string => blk: {
                    const values = try manager.allocator.alloc([]const u8, 1);
                    values[0] = ca.asString(manager.allocator) orelse unreachable;
                    break :blk values;
                },
                .e_array => |array| blk: {
                    const items = array.items.slice();
                    const values = try manager.allocator.alloc([]const u8, items.len);
                    for (items, 0..) |item, index| {
                        values[index] = item.asString(manager.allocator) orelse {
                            try manager.stderr.print("{s}: Invalid CA. Expected a string.\n", .{path});
                            return error.PackageManagerErrorReported;
                        };
                    }
                    break :blk values;
                },
                else => {
                    try manager.stderr.print("{s}: Invalid CA. Expected a string or an array of strings.\n", .{path});
                    return error.PackageManagerErrorReported;
                },
            };
            if (manager.options.ca.len == 0) manager.certificate_authorities = configured;
        }
        if (install.get("registry")) |registry_value| {
            var configured = std.mem.zeroes(compiler.schema.api.NpmRegistry);
            switch (registry_value.data) {
                .e_string => configured.url = registry_value.asString(manager.allocator) orelse "",
                .e_object => {
                    if (registry_value.get("url")) |field| configured.url = field.asString(manager.allocator) orelse "";
                    if (registry_value.get("token")) |field| configured.token = field.asString(manager.allocator) orelse "";
                    if (registry_value.get("username")) |field| configured.username = field.asString(manager.allocator) orelse "";
                    if (registry_value.get("password")) |field| configured.password = field.asString(manager.allocator) orelse "";
                },
                else => {},
            }
            if (configured.url.len > 0) {
                if (configured.username.len > 0) manager.registry_username = configured.username;
                default_registry_config = .{
                    .url = configured.url,
                    .source_url = configured.url,
                    .authorization = try manager.authorizationForRegistry(configured),
                };
            }
        }
        if (install.get("minimumReleaseAge")) |minimum_age| {
            switch (minimum_age.data) {
                .e_number => |seconds| {
                    const milliseconds = seconds.value * std.time.ms_per_s;
                    if (!std.math.isFinite(seconds.value) or seconds.value < 0 or !std.math.isFinite(milliseconds)) {
                        try manager.stderr.print("{s}: Expected positive number of seconds for minimumReleaseAge\n", .{path});
                        return error.PackageManagerErrorReported;
                    }
                    if (!manager.options.minimum_release_age_cli) {
                        manager.options.minimum_release_age_ms = milliseconds;
                    }
                },
                else => {
                    try manager.stderr.print("{s}: Expected number of seconds for minimumReleaseAge\n", .{path});
                    return error.PackageManagerErrorReported;
                },
            }
        }
        if (install.get("concurrentScripts")) |configured_concurrency| {
            if (configured_concurrency.data == .e_number and !manager.options.concurrent_scripts_cli) {
                const jobs = configured_concurrency.data.e_number.value;
                if (std.math.isFinite(jobs) and jobs > 0 and jobs <= @as(f64, @floatFromInt(std.math.maxInt(usize)))) {
                    manager.options.concurrent_scripts = @intFromFloat(jobs);
                }
            }
        }
        if (install.get("minimumReleaseAgeExcludes")) |exclusions| {
            switch (exclusions.data) {
                .e_array => |array| {
                    const raw = array.items.slice();
                    const values = try manager.allocator.alloc([]const u8, raw.len);
                    for (raw, 0..) |item, index| {
                        values[index] = item.asString(manager.allocator) orelse {
                            try manager.stderr.print("{s}: Expected strings in minimumReleaseAgeExcludes\n", .{path});
                            return error.PackageManagerErrorReported;
                        };
                    }
                    manager.minimum_release_age_excludes = values;
                },
                else => {
                    try manager.stderr.print("{s}: Expected array for minimumReleaseAgeExcludes\n", .{path});
                    return error.PackageManagerErrorReported;
                },
            }
        }
        if (install.get("cache")) |cache| {
            if (cache.asBool()) |enabled| {
                if (!enabled) {
                    manager.options.no_cache = true;
                    manager.cache_directory = null;
                }
            } else if (cache.asString(manager.allocator)) |directory| {
                manager.cache_directory = directory;
            } else if (cache.data == .e_object) {
                if (cache.get("disable")) |disable| {
                    if (disable.asBool()) |disabled| manager.options.no_cache = disabled;
                }
                if (cache.get("dir")) |directory| {
                    if (directory.asString(manager.allocator)) |value| manager.cache_directory = value;
                }
            }
        }
        if (install.get("optional")) |optional| {
            if (optional.asBool()) |enabled| {
                if (!enabled) manager.options.omit_optional = true;
            }
        }
        if (install.get("security")) |security| {
            if (security.get("scanner")) |scanner| {
                if (scanner.asString(manager.allocator)) |value| {
                    if (value.len > 0) manager.security_scanner = value;
                }
            }
        }
        const scopes = install.get("scopes") orelse return default_registry_config;
        if (scopes.data != .e_object) return default_registry_config;

        for (scopes.data.e_object.properties.slice()) |property| {
            const raw_name = property.key.?.asString(manager.allocator) orelse continue;
            if (raw_name.len == 0) continue;
            const name = if (raw_name[0] == '@') raw_name[1..] else raw_name;
            const value = property.value orelse continue;
            var configured = std.mem.zeroes(compiler.schema.api.NpmRegistry);
            switch (value.data) {
                .e_string => configured.url = value.asString(manager.allocator) orelse continue,
                .e_object => {
                    if (value.get("url")) |field| configured.url = field.asString(manager.allocator) orelse "";
                    if (value.get("token")) |field| configured.token = field.asString(manager.allocator) orelse "";
                    if (value.get("username")) |field| configured.username = field.asString(manager.allocator) orelse "";
                    if (value.get("password")) |field| configured.password = field.asString(manager.allocator) orelse "";
                },
                else => continue,
            }
            if (configured.url.len == 0) continue;
            try manager.registry_scopes.put(try manager.allocator.dupe(u8, name), .{
                .url = try normalizeRegistryUrl(manager.allocator, configured.url),
                .source_url = configured.url,
                .authorization = try manager.authorizationForRegistry(configured),
            });
        }
        return default_registry_config;
    }

    fn loadNpmrcConfiguration(manager: *Manager, registry: *?[]const u8) !void {
        var ast_memory_allocator: compiler.ast.ASTMemoryAllocator = undefined;
        var ast_scope = ast_memory_allocator.enter(manager.allocator);
        defer ast_scope.exit();

        var env_map = compiler.DotEnv.Map.init(manager.allocator);
        var env = compiler.DotEnv.Loader.init(&env_map, manager.allocator);
        try env.loadProcess();
        if (try readOptionalFile(manager.init_data.io, manager.allocator, ".env", 1024 * 1024)) |raw_env| {
            const env_text = try decodeConfigText(manager.allocator, raw_env);
            try env.loadFromString(env_text, false, true);
        }

        var install = std.mem.zeroes(compiler.schema.api.BunInstall);
        if (registry.*) |url| {
            install.default_registry = .{
                .url = url,
                .username = "",
                .password = "",
                .token = "",
                .email = "",
            };
        }

        var configs = std.array_list.Managed(compiler.ini.ConfigIterator.Item).init(manager.allocator);
        defer {
            for (configs.items) |*item| item.deinit(manager.allocator);
            configs.deinit();
        }

        if (manager.init_data.environ_map.get("XDG_CONFIG_HOME") orelse manager.init_data.environ_map.get("HOME")) |home| {
            const home_npmrc = try std.fs.path.join(manager.allocator, &.{ home, ".npmrc" });
            try manager.loadNpmrcFile(&install, &env, &configs, home_npmrc, false);
        }
        try manager.loadNpmrcFile(&install, &env, &configs, ".npmrc", true);

        if (install.default_registry) |configured| {
            if (registry.* == null) registry.* = configured.url;
            if (configured.username.len > 0) manager.registry_username = configured.username;
            if (manager.registry_authorization == null) {
                manager.registry_authorization = try manager.authorizationForRegistry(configured);
            }
        }
        if (install.disable_cache orelse false) {
            manager.options.no_cache = true;
            manager.cache_directory = null;
        } else if (!manager.options.no_cache) {
            if (install.cache_directory) |directory| manager.cache_directory = directory;
        }
        if (install.link_workspace_packages) |value| manager.link_workspace_packages = value;
        if (install.exact) |value| manager.options.exact = value;
        if (install.ignore_scripts) |value| manager.options.ignore_scripts = value;
        if (install.concurrent_scripts) |value| {
            if (!manager.options.concurrent_scripts_cli and value > 0) manager.options.concurrent_scripts = @intCast(value);
        }

        if (install.scoped) |scoped| {
            for (scoped.scopes.keys(), scoped.scopes.values()) |scope, configured| {
                const url = try normalizeRegistryUrl(manager.allocator, configured.url);
                try manager.registry_scopes.put(try manager.allocator.dupe(u8, scope), .{
                    .url = url,
                    .source_url = configured.url,
                    .authorization = try manager.authorizationForRegistry(configured),
                });
            }
        }
    }

    fn loadNpmrcFile(
        manager: *Manager,
        install: *compiler.schema.api.BunInstall,
        env: *compiler.DotEnv.Loader,
        configs: *std.array_list.Managed(compiler.ini.ConfigIterator.Item),
        path: []const u8,
        apply_compat_options: bool,
    ) !void {
        const raw = (try readOptionalFile(manager.init_data.io, manager.allocator, path, 1024 * 1024)) orelse return;
        const source_text = try decodeConfigText(manager.allocator, raw);
        const source = compiler.logger.Source.initPathString(path, source_text);
        const path_z = try manager.allocator.dupeZ(u8, path);

        var log = compiler.logger.Log.init(manager.allocator);
        defer log.deinit();
        try compiler.ini.loadNpmrcWithoutMatchers(manager.allocator, install, env, path_z, &log, &source, configs);
        if (log.hasErrors()) {
            try manager.stderr.print("warn: Encountered {s} while reading {s}:\n\n", .{
                if (log.errors == 1) "an error" else "errors",
                path,
            });
            try log.print(manager.stderr);
        }

        if (!apply_compat_options) return;
        if (parseNpmrcValue(source_text, "link-workspace-packages")) |value| {
            if (std.ascii.eqlIgnoreCase(value, "true")) manager.link_workspace_packages = true;
            if (std.ascii.eqlIgnoreCase(value, "false")) manager.link_workspace_packages = false;
        }
        if (manager.public_hoist_pattern == null) {
            if (try parseNpmrcStringList(manager.allocator, source_text, "public-hoist-pattern")) |patterns| {
                manager.public_hoist_pattern = try Isolated.HoistPattern.init(manager.allocator, patterns);
            }
        }
        if (manager.hidden_hoist_pattern == null) {
            if (try parseNpmrcStringList(manager.allocator, source_text, "hoist-pattern")) |patterns| {
                manager.hidden_hoist_pattern = try Isolated.HoistPattern.init(manager.allocator, patterns);
            }
        }
        if (parseNpmrcValue(source_text, "omit")) |value| {
            var omitted = std.mem.tokenizeAny(u8, value, ", \t");
            while (omitted.next()) |dependency_type| try applyOmit(&manager.options, dependency_type);
        }
    }

    fn authorizationForRegistry(manager: *Manager, configured: compiler.schema.api.NpmRegistry) !?[]const u8 {
        if (configured.token.len > 0) {
            return try std.fmt.allocPrint(manager.allocator, "Bearer {s}", .{configured.token});
        }
        if (configured.username.len == 0 or configured.password.len == 0) return null;
        const credentials = try std.fmt.allocPrint(manager.allocator, "{s}:{s}", .{ configured.username, configured.password });
        const encoded_len = std.base64.standard.Encoder.calcSize(credentials.len);
        const encoded = try manager.allocator.alloc(u8, encoded_len);
        _ = std.base64.standard.Encoder.encode(encoded, credentials);
        return try std.fmt.allocPrint(manager.allocator, "Basic {s}", .{encoded});
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
        ) catch |err| switch (err) {
            error.FileNotFound => null,
            else => return err,
        };

        if (source) |text| {
            manager.loaded_text_lockfile = true;
            manager.lock_graph = try Lockfile.parseText(manager.allocator, text);
            manager.lockfile_config_version = manager.lock_graph.?.config_version orelse .v0;
            if (manager.lock_graph.?.config_version == null) manager.changed = true;
            manager.patch_policy_changed = !manager.manifest_policy.?.patchesMatchLockDocument(&manager.lock_graph.?.document);
            if (!manager.lock_graph.?.rootMatchesPackageJSON(root) or
                !manager.manifest_policy.?.matchesLockDocument(&manager.lock_graph.?.document))
            {
                if (manager.options.frozen_lockfile) return error.FrozenLockfileChanged;
                manager.changed = true;
            }
            try manager.selectAutomaticLinker(root);
            return;
        }

        const binary_path = try std.fs.path.join(manager.allocator, &.{ manager.root_dir, "bun.lockb" });
        const binary = std.Io.Dir.cwd().readFileAlloc(
            manager.init_data.io,
            binary_path,
            manager.allocator,
            .limited(256 * 1024 * 1024),
        ) catch |err| switch (err) {
            error.FileNotFound => null,
            else => return err,
        };
        if (binary) |bytes| {
            const converted = try BunLockfile.binaryToTextWithMetadata(manager.allocator, bytes);
            manager.loaded_binary_lockfile = true;
            manager.binary_lockfile_needs_migration = converted.migrated_from_v2;
            manager.binary_lockfile_trusted_dependency_hashes = converted.trusted_dependency_hashes;
            manager.lock_graph = try Lockfile.parseText(manager.allocator, converted.text);
            manager.lockfile_config_version = manager.lock_graph.?.config_version orelse .v0;
            if (manager.lock_graph.?.config_version == null) manager.changed = true;
            manager.patch_policy_changed = !manager.manifest_policy.?.patchesMatchLockDocument(&manager.lock_graph.?.document);
            if (!manager.lock_graph.?.rootMatchesPackageJSON(root) or
                !manager.manifest_policy.?.matchesLockDocumentWithoutTrustedDependencies(&manager.lock_graph.?.document) or
                !manager.manifest_policy.?.matchesTrustedDependencyHashes(converted.trusted_dependency_hashes))
            {
                if (manager.options.frozen_lockfile) return error.FrozenLockfileChanged;
                manager.changed = true;
            }
            try manager.selectAutomaticLinker(root);
            return;
        }

        const detection = try LockfileMigration.detect(
            manager.init_data.io,
            manager.allocator,
            manager.root_dir,
            root,
        );
        switch (detection) {
            .not_found => {
                if (manager.options.frozen_lockfile) return error.FrozenLockfileNotFound;
                manager.lockfile_config_version = .current;
            },
            .migrated => |migration| {
                manager.lock_graph = migration.graph;
                manager.lockfile_config_version = migration.graph.config_version orelse .v0;
                try manager.enrichMigratedLockMetadata();
                manager.changed = true;
                if (!manager.options.silent) {
                    try manager.stderr.print("migrated lockfile from {s}\n", .{migration.source.filename()});
                }
            },
            .ignored => |ignored| {
                if (manager.options.frozen_lockfile) return error.FrozenLockfileNotFound;
                manager.lockfile_config_version = .current;
                if (!manager.options.silent and ignored.reason == .pnpm_lockfile_too_old) {
                    try manager.stderr.writeAll("warning: pnpm-lock.yaml version is too old (< v7); continuing with a fresh install\n");
                }
            },
        }
        try manager.selectAutomaticLinker(root);
    }

    fn inferUnconfiguredLinker(manager: *Manager) !Isolated.Linker {
        const store = try std.fs.path.join(manager.allocator, &.{ manager.root_dir, "node_modules", ".bun" });
        return if (manager.pathExists(store)) .isolated else .hoisted;
    }

    fn selectAutomaticLinker(manager: *Manager, root: *const Value) !void {
        if (manager.linker_configured) return;
        if (try manager.inferUnconfiguredLinker() == .isolated) {
            manager.node_linker = .isolated;
            return;
        }
        const npm_migration = if (manager.lock_graph) |*graph| graph.provenance == .npm else false;
        manager.node_linker = if (manager.lockfile_config_version == .v1 and
            !npm_migration and packageJSONHasWorkspaces(root))
            .isolated
        else
            .hoisted;
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

    fn filterPatternMatches(
        manager: *Manager,
        raw_pattern: []const u8,
        name: []const u8,
        relative_path: []const u8,
    ) !bool {
        var pattern = std.mem.trim(u8, raw_pattern, " \t\r\n");
        if (pattern.len > 0 and pattern[0] == '!') pattern = pattern[1..];
        pattern = std.mem.trim(u8, pattern, " \t\r\n");

        if (std.mem.startsWith(u8, pattern, "./") or std.mem.eql(u8, pattern, ".")) {
            while (std.mem.startsWith(u8, pattern, "./")) pattern = pattern[2..];
            while (pattern.len > 0 and (pattern[pattern.len - 1] == '/' or pattern[pattern.len - 1] == '\\')) {
                pattern = pattern[0 .. pattern.len - 1];
            }
            const normalized = try manager.allocator.dupe(u8, pattern);
            std.mem.replaceScalar(u8, normalized, '\\', '/');
            return Workspaces.globMatch(normalized, relative_path);
        }
        return Workspaces.globMatch(pattern, name);
    }

    fn filterSelects(
        manager: *Manager,
        name: []const u8,
        relative_path: []const u8,
    ) !bool {
        var has_positive = false;
        for (manager.options.filters) |raw_pattern| {
            const pattern = std.mem.trim(u8, raw_pattern, " \t\r\n");
            if (pattern.len == 0 or pattern[0] != '!') has_positive = true;
        }

        var selected = !has_positive;
        for (manager.options.filters) |raw_pattern| {
            const pattern = std.mem.trim(u8, raw_pattern, " \t\r\n");
            if (pattern.len == 0) continue;
            if (try manager.filterPatternMatches(pattern, name, relative_path)) {
                selected = pattern[0] != '!';
            }
        }
        return selected;
    }

    fn includeWorkspaceFilterClosure(
        manager: *Manager,
        package_json: *const Value,
        parent_dir: []const u8,
    ) !void {
        if (package_json.* != .object) return;
        for (all_dependency_sections) |section_name| {
            const section = package_json.object.get(section_name) orelse continue;
            if (section != .object) continue;
            for (section.object.keys(), section.object.values()) |alias, spec_value| {
                if (spec_value != .string or !manager.isWorkspaceDependency(alias, spec_value.string)) continue;
                const workspace = try manager.resolveWorkspaceDependency(alias, spec_value.string, parent_dir);
                const entry = try manager.filtered_workspaces.getOrPut(workspace.name);
                if (!entry.found_existing) {
                    try manager.includeWorkspaceFilterClosure(workspace.package_json, workspace.path);
                }
            }
        }
    }

    fn configureInstallFilters(manager: *Manager, root: *const Value) !void {
        const filters_apply = manager.options.command == .install or
            manager.options.command == .outdated or
            (manager.options.command == .update and manager.options.interactive);
        if (!filters_apply or manager.options.filters.len == 0) return;
        manager.install_filter_active = true;
        const root_name = jsonString(root, "name") orelse "";
        if (manager.options.command == .outdated) {
            manager.root_selected = try manager.outdatedFilterSelects(root_name, manager.root_dir);

            var outdated_workspaces = manager.workspaces.iterator();
            while (outdated_workspaces.next()) |entry| {
                const workspace = entry.value_ptr.*;
                if (try manager.outdatedFilterSelects(workspace.name, workspace.path)) {
                    try manager.filtered_workspaces.put(workspace.name, {});
                }
            }
            return;
        }

        manager.root_selected = try manager.filterSelects(root_name, "");

        var workspaces = manager.workspaces.iterator();
        while (workspaces.next()) |entry| {
            const workspace = entry.value_ptr.*;
            if (try manager.filterSelects(workspace.name, workspace.relative_path)) {
                const selected = try manager.filtered_workspaces.getOrPut(workspace.name);
                if (!selected.found_existing) {
                    try manager.includeWorkspaceFilterClosure(workspace.package_json, workspace.path);
                }
            }
        }

        if (manager.root_selected) try manager.includeWorkspaceFilterClosure(root, manager.root_dir);
    }

    fn outdatedFilterSelects(manager: *Manager, name: []const u8, path: []const u8) !bool {
        var has_positive = false;
        for (manager.options.filters) |raw_pattern| {
            const pattern = std.mem.trim(u8, raw_pattern, " \t\r\n");
            if (pattern.len > 0 and pattern[0] != '!') has_positive = true;
        }

        var selected = !has_positive;
        for (manager.options.filters) |raw_pattern| {
            var pattern = std.mem.trim(u8, raw_pattern, " \t\r\n");
            if (pattern.len == 0) continue;
            const include = pattern[0] != '!';
            if (!include) pattern = std.mem.trim(u8, pattern[1..], " \t\r\n");
            if (pattern.len == 0) continue;

            const path_pattern = std.mem.startsWith(u8, pattern, ".") or std.fs.path.isAbsolute(pattern);
            const matches = if (!path_pattern and (std.mem.eql(u8, pattern, "*") or std.mem.eql(u8, pattern, "**")))
                true
            else if (path_pattern) blk: {
                const absolute_pattern = try absolutePathFrom(manager.allocator, manager.invocation_dir, pattern);
                const normalized_pattern = try manager.allocator.dupe(u8, absolute_pattern);
                const normalized_path = try manager.allocator.dupe(u8, path);
                std.mem.replaceScalar(u8, normalized_pattern, '\\', '/');
                std.mem.replaceScalar(u8, normalized_path, '\\', '/');
                break :blk Workspaces.globMatch(normalized_pattern, normalized_path);
            } else Workspaces.globMatch(pattern, name);
            if (matches) selected = include;
        }
        return selected;
    }

    fn workspaceSelected(manager: *const Manager, workspace: Workspace) bool {
        return !manager.install_filter_active or manager.filtered_workspaces.contains(workspace.name);
    }

    fn validateCatalogReferences(manager: *Manager, root: *const Value) !void {
        var failed = false;
        try manager.validateManifestCatalogReferences(root, &failed);
        var workspaces = manager.workspaces.iterator();
        while (workspaces.next()) |entry| {
            try manager.validateManifestCatalogReferences(entry.value_ptr.package_json, &failed);
        }
        if (failed) return error.PackageManagerErrorReported;
    }

    fn warnDuplicateDependencies(manager: *Manager, package_json: *const Value) !void {
        if (manager.options.silent or package_json.* != .object) return;
        const dependencies = package_json.object.get("dependencies") orelse return;
        const dev_dependencies = package_json.object.get("devDependencies") orelse return;
        if (dependencies != .object or dev_dependencies != .object) return;

        for (dev_dependencies.object.keys()) |name| {
            if (dependencies.object.get(name) == null) continue;
            try manager.stderr.print(
                "warn: Duplicate dependency: \"{s}\" specified in package.json\n",
                .{name},
            );
        }
    }

    fn validateManifestCatalogReferences(
        manager: *Manager,
        package_json: *const Value,
        failed: *bool,
    ) !void {
        if (package_json.* != .object) return;
        for (all_dependency_sections) |section_name| {
            const section = package_json.object.get(section_name) orelse continue;
            if (section != .object) continue;
            for (section.object.keys(), section.object.values()) |alias, spec| {
                if (spec != .string) continue;
                const workspace_package = manager.isWorkspaceDependency(alias, spec.string);
                _ = manager.manifest_policy.?.resolveDependency(alias, spec.string, workspace_package) catch |err| {
                    if (err != error.CatalogDependencyNotFound and err != error.InvalidCatalogDependency) return err;
                    try manager.stderr.print("error: {s}@{s} failed to resolve\n", .{ alias, spec.string });
                    failed.* = true;
                    continue;
                };
            }
        }
    }

    fn installImporterDependencies(
        manager: *Manager,
        package_json: *Value,
        parent_dir: []const u8,
        direct: bool,
    ) !void {
        try manager.installDependencyObject(package_json, "dependencies", parent_dir, direct, false);
        try manager.installOptionalDependencies(package_json, parent_dir, direct);
        if (manager.options.production or manager.options.omit_dev) {
            try manager.resolveOmittedDependencyObject(package_json, "devDependencies", parent_dir, direct, false);
        } else {
            try manager.installDependencyObject(package_json, "devDependencies", parent_dir, direct, false);
        }
        if (manager.options.omit_peer) {
            try manager.resolveOmittedDependencyObject(package_json, "peerDependencies", parent_dir, direct, false);
        } else {
            try manager.installDependencyObject(package_json, "peerDependencies", parent_dir, direct, false);
        }
    }

    fn installOptionalDependencies(
        manager: *Manager,
        package_json: *Value,
        parent_dir: []const u8,
        direct: bool,
    ) !void {
        if (!manager.options.omit_optional) {
            return manager.installDependencyObject(package_json, "optionalDependencies", parent_dir, direct, true);
        }

        return manager.resolveOmittedDependencyObject(package_json, "optionalDependencies", parent_dir, direct, true);
    }

    fn resolveOmittedDependencyObject(
        manager: *Manager,
        package_json: *Value,
        key: []const u8,
        parent_dir: []const u8,
        direct: bool,
        optional: bool,
    ) !void {
        const previous_report_direct = manager.report_direct_installs;
        manager.report_direct_installs = false;
        defer manager.report_direct_installs = previous_report_direct;
        const previous_resolution_only = manager.setResolutionOnly(true);
        defer manager.restoreResolutionOnly(previous_resolution_only);
        try manager.installDependencyObject(package_json, key, parent_dir, direct, optional);
    }

    fn setResolutionOnly(manager: *Manager, enabled: bool) struct { bool, bool } {
        const previous = .{ manager.options.lockfile_only, manager.filter_resolution_only };
        manager.options.lockfile_only = manager.options.lockfile_only or enabled;
        manager.filter_resolution_only = manager.filter_resolution_only or enabled;
        return previous;
    }

    fn restoreResolutionOnly(manager: *Manager, previous: struct { bool, bool }) void {
        manager.options.lockfile_only = previous[0];
        manager.filter_resolution_only = previous[1];
    }

    fn installRoot(manager: *Manager, root: *Value, report_direct: bool) !void {
        const previous_report_direct = manager.report_direct_installs;
        manager.report_direct_installs = report_direct and
            manager.root_selected and
            (manager.options.command == .install or manager.options.command == .add or manager.options.command == .remove) and
            !manager.options.lockfile_only;
        defer manager.report_direct_installs = previous_report_direct;
        if (manager.root_selected) {
            try manager.installImporterDependencies(root, manager.root_dir, true);
        } else {
            const previous = manager.setResolutionOnly(true);
            defer manager.restoreResolutionOnly(previous);
            try manager.installImporterDependencies(root, manager.root_dir, true);
        }
        try manager.installWorkspaceDependencies();
        try manager.emitDirectInstallReports();
    }

    fn addPackages(manager: *Manager, package_json: *Value, parent_dir: []const u8) !void {
        if (manager.options.positionals.len == 0) return error.MissingPackageName;
        if (manager.options.production) {
            try manager.validateProductionInstallRequests();
            return manager.installRoot(manager.root_package_json.?, true);
        }
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
                const git = try manager.installGit(alias, requested, parent_dir, true, false, null, &.{});
                alias = git.alias;
                resolved_version = git.version;
                display_resolution = try displayGitResolution(manager.allocator, git.source);
            } else if (isTarballSpec(requested)) {
                const tarball = try manager.installTarball(alias, requested, parent_dir, true, false, &.{});
                alias = tarball.alias;
                resolved_version = tarball.version;
                display_resolution = requested;
            } else if (isLocalSpec(requested)) {
                const local = manager.resolveLocalPackage(requested, parent_dir) catch |err| {
                    if (err == error.MissingPackageJSON and isGlobalLinkSpec(requested) and manager.options.command == .link) {
                        try manager.stderr.print("error: Package \"{s}\" is not linked\n", .{localSpecPath(requested)});
                        return error.PackageManagerErrorReported;
                    }
                    try manager.stderr.print("note: error occurred while resolving {s}\n", .{requested});
                    return err;
                };
                alias = alias orelse local.name;
                display_resolution = localSpecPath(try manager.normalizeLocalSpec(requested, local.path));
                requested = try manager.normalizeLocalSpecFrom(requested, local.path, parent_dir);
                if (isGlobalLinkSpec(requested)) display_resolution = requested;
            } else if (alias == null) {
                return error.InvalidPackageName;
            }
            const name = alias.?;
            try manager.explicit_adds.put(try manager.allocator.dupe(u8, name), {});
            const target_section = manager.sectionForAdd(package_json, name);
            const section = try ensureObjectProperty(manager.allocator, &package_json.object, target_section.key());

            // COTTONTAIL-COMPAT: an implicit scanner-backed add must install
            // the manifest range approved by preflight, rather than resolving
            // the default tag again after the scan has completed.
            if ((manager.isSecurityResolution() or manager.security_scanner != null) and
                !packageSpecHasExplicitSpecifier(raw_spec))
            {
                if (section.get(name)) |current| {
                    if (current == .string) requested = current.string;
                }
            }

            if (manager.options.only_missing and section.get(name) != null) continue;
            if (!isTarballSpec(requested) and !isGitSpec(requested)) {
                resolved_version = manager.installDependency(name, requested, parent_dir, true, false, false) catch |err| {
                    if (std.mem.startsWith(u8, requested, "npm:")) {
                        try manager.stderr.print("error: {s} failed to resolve\n", .{raw_spec});
                        return error.PackageManagerErrorReported;
                    }
                    return err;
                };
                if (!isLocalSpec(requested)) {
                    display_resolution = (try manager.workspaceDisplayResolution(name, requested, parent_dir)) orelse resolved_version;
                }
            }
            const saved_spec = if (isTarballSpec(requested) or isGitSpec(requested) or isLocalSpec(requested) or std.mem.startsWith(u8, requested, "workspace:"))
                requested
            else if (hasExplicitRange(raw_spec))
                requested
            else if (manager.options.exact)
                resolved_version
            else
                try std.fmt.allocPrint(manager.allocator, "^{s}", .{resolved_version});
            manager.removeDependencyFromOtherSections(package_json, name, target_section);
            try section.put(manager.allocator, try manager.allocator.dupe(u8, name), .{ .string = try manager.allocator.dupe(u8, saved_spec) });
            manager.changed = true;
            if (!manager.options.silent and !manager.options.no_summary) {
                if (manager.direct_bins.items.len == 0) {
                    try added_output.writer.print("installed {s}@{s}\n", .{ name, display_resolution });
                } else {
                    try added_output.writer.print("installed {s}@{s} with binaries:\n", .{ name, display_resolution });
                    for (manager.direct_bins.items) |bin_name| try added_output.writer.print(" - {s}\n", .{bin_name});
                }
            }
        }
        try manager.installRoot(manager.root_package_json.?, true);
        if (!manager.options.silent and !manager.options.no_summary) {
            if ((manager.options.command == .link or manager.direct_install_reports.items.len > 0) and
                added_output.written().len > 0)
            {
                try manager.stdout.writeByte('\n');
            }
            try manager.stdout.writeAll(added_output.written());
        }
    }

    fn validateProductionInstallRequests(manager: *Manager) !void {
        for (manager.options.positionals) |raw_spec| {
            const parsed = splitPackageSpec(raw_spec);
            const alias = parsed.name orelse {
                try manager.stderr.print("error: Failed to resolve root prod dependency '{s}'\n", .{raw_spec});
                return error.PackageManagerErrorReported;
            };
            const declared_spec = manager.rootDependencySpec(alias) orelse {
                try manager.stderr.print("error: Failed to resolve root prod dependency '{s}'\n", .{alias});
                return error.PackageManagerErrorReported;
            };
            if (!packageSpecHasExplicitSpecifier(raw_spec)) continue;

            const workspace_package = manager.isWorkspaceDependency(alias, declared_spec);
            const effective_declared = manager.manifest_policy.?.resolveDependency(alias, declared_spec, workspace_package) catch declared_spec;
            if (isGitSpec(effective_declared) or isTarballSpec(effective_declared) or isLocalSpec(effective_declared) or
                std.mem.startsWith(u8, effective_declared, "workspace:"))
            {
                if (std.mem.eql(u8, effective_declared, parsed.spec)) continue;
            } else if (!isGitSpec(parsed.spec) and !isTarballSpec(parsed.spec) and !isLocalSpec(parsed.spec) and
                !std.mem.startsWith(u8, parsed.spec, "workspace:"))
            {
                const declared_name, const declared_range = parseNpmAlias(alias, effective_declared);
                const requested_name, const requested_range = parseNpmAlias(alias, parsed.spec);
                if (std.mem.eql(u8, declared_name, requested_name)) {
                    const requested = manager.resolveRegistryPackage(requested_name, requested_range) catch null;
                    if (requested) |resolved| {
                        if (semverSatisfies(manager.allocator, declared_range, resolved.version)) continue;
                    }
                }
            }

            try manager.stderr.print("error: Failed to resolve root prod dependency '{s}'\n", .{alias});
            return error.PackageManagerErrorReported;
        }
    }

    fn sectionForAdd(manager: *Manager, root: *Value, name: []const u8) DependencySection {
        const candidates = [_]DependencySection{ .dependencies, .devDependencies, .optionalDependencies, .peerDependencies };
        for (candidates) |candidate| {
            const section = root.object.get(candidate.key()) orelse continue;
            if (section == .object and section.object.get(name) != null) return candidate;
        }
        return manager.options.section;
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

    fn securityFinalGraphUsesPath(manager: *const Manager, path: []const u8) bool {
        for (manager.records.items) |record| {
            if (record.install_dir.len > 0 and std.mem.eql(u8, record.install_dir, path)) return true;
        }
        return false;
    }

    fn removePackages(manager: *Manager, package_json: *Value, parent_dir: []const u8) !void {
        if (manager.options.positionals.len == 0) return error.MissingPackageName;
        if (!hasAnyDependencies(package_json)) {
            manager.options.no_summary = true;
            if (!manager.options.silent) {
                try manager.stderr.writeAll("package.json doesn't have dependencies, there's nothing to remove!\n");
            }
            return;
        }
        if (!manager.options.silent) try manager.stdout.writeByte('\n');

        const defer_hoisted_security_removal = manager.security_scanner != null and
            manager.node_linker == .hoisted and
            !manager.options.dry_run;
        var removed: usize = 0;
        for (manager.options.positionals) |name| {
            var name_removed = false;
            for (all_dependency_sections) |section_name| {
                if (package_json.object.getPtr(section_name)) |section| {
                    if (section.* == .object and section.object.orderedRemove(name)) {
                        name_removed = true;
                        manager.changed = true;
                    }
                    if (section.* == .object and section.object.count() == 0) {
                        _ = package_json.object.orderedRemove(section_name);
                    }
                }
            }
            const path = if (manager.node_linker == .isolated)
                try std.fs.path.join(manager.allocator, &.{ try manager.isolatedConsumerModules(parent_dir), name })
            else
                try packageDestination(manager.allocator, manager.root_dir, name);
            if (name_removed) {
                removed += 1;
                if (manager.pathExists(path)) {
                    try manager.removed_materialized_names.append(try manager.allocator.dupe(u8, name));
                }
            }
            if (!manager.options.dry_run and !defer_hoisted_security_removal) {
                deletePath(manager.init_data.io, path);
            }
        }
        manager.removed_count += removed;
        try manager.installRoot(manager.root_package_json.?, true);
        if (defer_hoisted_security_removal) {
            // COTTONTAIL-COMPAT: resolve the surviving hoisted graph before
            // removing direct entries. A removed direct package may still be
            // the valid materialization of a transitive dependency.
            for (manager.options.positionals) |name| {
                const path = try packageDestination(manager.allocator, manager.root_dir, name);
                if (!manager.securityFinalGraphUsesPath(path)) deletePath(manager.init_data.io, path);
            }
        }
    }

    fn printOutdated(manager: *Manager, package_json: *Value, parent_dir: []const u8) !u8 {
        if (manager.lock_graph == null) {
            try manager.stderr.writeAll("error: missing lockfile, nothing outdated\n");
            try manager.stderr.flush();
            return 1;
        }

        var packages = std.array_list.Managed(OutdatedPackage).init(manager.allocator);
        defer packages.deinit();

        const previous_refresh = manager.refresh_direct_registry;
        manager.refresh_direct_registry = true;
        defer manager.refresh_direct_registry = previous_refresh;

        if (manager.install_filter_active) {
            if (manager.root_selected) {
                try manager.collectOutdatedPackages(manager.root_package_json.?, manager.root_dir, &packages);
            }
            var workspaces = manager.workspaces.iterator();
            while (workspaces.next()) |entry| {
                if (manager.filtered_workspaces.contains(entry.value_ptr.name)) {
                    try manager.collectOutdatedPackages(entry.value_ptr.package_json, entry.value_ptr.path, &packages);
                }
            }
        } else if (manager.options.recursive) {
            try manager.collectOutdatedPackages(manager.root_package_json.?, manager.root_dir, &packages);
            var workspaces = manager.workspaces.iterator();
            while (workspaces.next()) |entry| {
                try manager.collectOutdatedPackages(entry.value_ptr.package_json, entry.value_ptr.path, &packages);
            }
        } else {
            try manager.collectOutdatedPackages(package_json, parent_dir, &packages);
        }

        std.sort.pdq(OutdatedPackage, packages.items, {}, struct {
            fn lessThan(_: void, left: OutdatedPackage, right: OutdatedPackage) bool {
                const alias_order = std.mem.order(u8, left.alias, right.alias);
                if (alias_order != .eq) return alias_order == .lt;
                return interactiveDependencyPriority(left.dependency_type) < interactiveDependencyPriority(right.dependency_type);
            }
        }.lessThan);

        return manager.printOutdatedTable(&packages);
    }

    fn collectOutdatedPackages(
        manager: *Manager,
        package_json: *Value,
        parent_dir: []const u8,
        packages: *std.array_list.Managed(OutdatedPackage),
    ) !void {
        var seen = std.StringHashMap(void).init(manager.allocator);
        defer seen.deinit();

        for (update_dependency_sections) |dependency_section| {
            if (std.mem.eql(u8, dependency_section.name, "devDependencies") and
                (manager.options.production or manager.options.omit_dev)) continue;
            if (std.mem.eql(u8, dependency_section.name, "optionalDependencies") and manager.options.omit_optional) continue;
            if (std.mem.eql(u8, dependency_section.name, "peerDependencies") and manager.options.omit_peer) continue;

            const section = package_json.object.get(dependency_section.name) orelse continue;
            if (section != .object) continue;
            for (section.object.keys(), section.object.values()) |alias, spec_value| {
                if (seen.contains(alias) or spec_value != .string) continue;
                try seen.put(alias, {});
                if (manager.options.positionals.len > 0 and !outdatedRequestContains(manager.options.positionals, alias)) continue;

                const original_spec = spec_value.string;
                if (manager.isWorkspaceDependency(alias, original_spec)) continue;
                const effective_spec = manager.manifest_policy.?.resolveDependency(alias, original_spec, false) catch |err| switch (err) {
                    error.CatalogDependencyNotFound, error.InvalidCatalogDependency => continue,
                };
                if (!isRegistryUpdateSpecifier(effective_spec)) continue;

                const selection = try manager.findLockedSelection(alias, parent_dir) orelse continue;
                if (selection.package.kind != .npm) continue;
                const registry_name, const registry_spec = parseNpmAlias(alias, effective_spec);
                const latest = manager.resolveRegistryPackage(registry_name, "latest") catch |err| switch (err) {
                    error.NoMatchingVersion, error.PackageNotFound, error.TooRecentVersion, error.AllVersionsTooRecent => continue,
                    else => return err,
                };
                const actual_latest = latest.latest_version orelse latest.version;
                if (!semverVersionLessThan(selection.package.version, actual_latest)) continue;

                const target = manager.resolveRegistryPackage(registry_name, registry_spec) catch |err| switch (err) {
                    error.NoMatchingVersion, error.PackageNotFound, error.TooRecentVersion, error.AllVersionsTooRecent => null,
                    else => return err,
                };
                try packages.append(.{
                    .alias = alias,
                    .current_version = selection.package.version,
                    .update_version = if (target) |resolved| resolved.version else selection.package.version,
                    .latest_version = latest.version,
                    .dependency_type = dependency_section.name,
                    .workspace_name = jsonString(package_json, "name") orelse "",
                    .catalog_name = if (std.mem.startsWith(u8, original_spec, "catalog:")) original_spec["catalog:".len..] else null,
                    .update_filtered = if (target) |resolved| resolved.age_filtered else false,
                    .latest_filtered = latest.age_filtered,
                });
            }
        }
    }

    fn printOutdatedTable(
        manager: *Manager,
        packages: *std.array_list.Managed(OutdatedPackage),
    ) !u8 {
        if (packages.items.len == 0) {
            try manager.stdout.flush();
            return 0;
        }

        var rendered = std.array_list.Managed(RenderedOutdatedPackage).init(manager.allocator);
        defer rendered.deinit();
        var has_catalog = false;
        for (packages.items) |package| {
            if (package.catalog_name) |catalog_name| {
                has_catalog = true;
                var already_grouped = false;
                for (rendered.items) |existing| {
                    if (sameOutdatedCatalog(existing.package, package)) {
                        already_grouped = true;
                        break;
                    }
                }
                if (already_grouped) continue;

                var workspace_names: std.Io.Writer.Allocating = .init(manager.allocator);
                try workspace_names.writer.writeAll("catalog");
                if (catalog_name.len > 0) try workspace_names.writer.print(":{s}", .{catalog_name});
                try workspace_names.writer.writeAll(" (");
                var first = true;
                for (packages.items) |candidate| {
                    if (!sameOutdatedCatalog(package, candidate)) continue;
                    if (!first) try workspace_names.writer.writeAll(", ");
                    try workspace_names.writer.writeAll(candidate.workspace_name);
                    first = false;
                }
                try workspace_names.writer.writeByte(')');
                try rendered.append(.{
                    .package = package,
                    .workspace_display = workspace_names.written(),
                });
            } else {
                try rendered.append(.{
                    .package = package,
                    .workspace_display = package.workspace_name,
                });
            }
        }

        const show_workspace = manager.install_filter_active or manager.options.recursive or has_catalog;
        var widths = [_]usize{ "Packages".len, "Current".len, "Update".len, "Latest".len, "Workspace".len };
        var has_filtered_versions = false;
        for (rendered.items) |item| {
            const package = item.package;
            widths[0] = @max(widths[0], package.alias.len + outdatedDependencySuffix(package.dependency_type).len);
            widths[1] = @max(widths[1], package.current_version.len);
            widths[2] = @max(widths[2], package.update_version.len + @as(usize, if (package.update_filtered) 2 else 0));
            widths[3] = @max(widths[3], package.latest_version.len + @as(usize, if (package.latest_filtered) 2 else 0));
            widths[4] = @max(widths[4], item.workspace_display.len);
            has_filtered_versions = has_filtered_versions or package.update_filtered or package.latest_filtered;
        }

        const force_color = manager.init_data.environ_map.get("FORCE_COLOR");
        const ansi = if (force_color) |value|
            !std.mem.eql(u8, value, "0")
        else
            false;
        const column_count: usize = if (show_workspace) 5 else 4;
        const active_widths = widths[0..column_count];
        const labels = [_][]const u8{ "Package", "Current", "Update", "Latest", "Workspace" };

        try writeOutdatedBorder(manager.stdout, active_widths, ansi, .top);
        for (labels[0..column_count], active_widths) |label, width| {
            try writeOutdatedCellStart(manager.stdout, ansi);
            if (ansi) try manager.stdout.writeAll("\x1b[1m\x1b[34m");
            try manager.stdout.writeAll(label);
            if (ansi) try manager.stdout.writeAll("\x1b[0m");
            try manager.stdout.splatByteAll(' ', width - label.len + 1);
        }
        try writeOutdatedRowEnd(manager.stdout, ansi);

        for (rendered.items) |item| {
            const package = item.package;
            try writeOutdatedBorder(manager.stdout, active_widths, ansi, .middle);

            const dependency_suffix = outdatedDependencySuffix(package.dependency_type);
            try writeOutdatedCellStart(manager.stdout, ansi);
            try manager.stdout.writeAll(package.alias);
            if (ansi) try manager.stdout.writeAll("\x1b[2m");
            try manager.stdout.writeAll(dependency_suffix);
            if (ansi) try manager.stdout.writeAll("\x1b[0m");
            try manager.stdout.splatByteAll(' ', widths[0] - package.alias.len - dependency_suffix.len + 1);

            try writeOutdatedCellStart(manager.stdout, ansi);
            try manager.stdout.writeAll(package.current_version);
            try manager.stdout.splatByteAll(' ', widths[1] - package.current_version.len + 1);

            try writeOutdatedCellStart(manager.stdout, ansi);
            try writeOutdatedVersion(
                manager.stdout,
                package.current_version,
                package.update_version,
                package.update_filtered,
                ansi,
            );
            const update_len = package.update_version.len + @as(usize, if (package.update_filtered) 2 else 0);
            try manager.stdout.splatByteAll(' ', widths[2] - update_len + 1);

            try writeOutdatedCellStart(manager.stdout, ansi);
            try writeOutdatedVersion(
                manager.stdout,
                package.current_version,
                package.latest_version,
                package.latest_filtered,
                ansi,
            );
            const latest_len = package.latest_version.len + @as(usize, if (package.latest_filtered) 2 else 0);
            try manager.stdout.splatByteAll(' ', widths[3] - latest_len + 1);

            if (show_workspace) {
                try writeOutdatedCellStart(manager.stdout, ansi);
                try manager.stdout.writeAll(item.workspace_display);
                try manager.stdout.splatByteAll(' ', widths[4] - item.workspace_display.len + 1);
            }
            try writeOutdatedRowEnd(manager.stdout, ansi);
        }
        try writeOutdatedBorder(manager.stdout, active_widths, ansi, .bottom);
        if (has_filtered_versions) {
            try manager.stdout.writeAll("Note: The * indicates that version isn't true latest due to minimum release age\n");
        }
        try manager.stdout.flush();
        return 0;
    }

    fn interactiveCatalogValue(root: *Value, alias: []const u8, reference: []const u8) ?*Value {
        if (root.* != .object or !std.mem.startsWith(u8, reference, "catalog:")) return null;
        var source = root;
        if (root.object.getPtr("workspaces")) |workspaces| {
            if (workspaces.* == .object and
                (workspaces.object.get("catalog") != null or workspaces.object.get("catalogs") != null))
            {
                source = workspaces;
            }
        }
        if (source.* != .object) return null;

        const catalog_name = std.mem.trim(u8, reference["catalog:".len..], " \t\r\n");
        const catalog = if (catalog_name.len == 0) blk: {
            const value = source.object.getPtr("catalog") orelse return null;
            if (value.* != .object) return null;
            break :blk value;
        } else blk: {
            const catalogs = source.object.getPtr("catalogs") orelse return null;
            if (catalogs.* != .object) return null;
            const value = catalogs.object.getPtr(catalog_name) orelse return null;
            if (value.* != .object) return null;
            break :blk value;
        };
        const value = catalog.object.getPtr(alias) orelse return null;
        return if (value.* == .string) value else null;
    }

    fn appendInteractiveUpdateCandidate(
        manager: *Manager,
        packages: *std.array_list.Managed(InteractiveUpdatePackage),
        alias: []const u8,
        effective_spec: []const u8,
        dependency_type: []const u8,
        resolution_dir: []const u8,
        spec_value: *Value,
        manifest: *Value,
        manifest_dir: []const u8,
    ) !void {
        for (packages.items) |existing| {
            if (existing.spec_value == spec_value) return;
        }

        const selection = try manager.findLockedSelection(alias, resolution_dir) orelse return;
        if (selection.package.kind != .npm) return;
        const registry_name, const registry_spec = parseNpmAlias(alias, effective_spec);
        const target = manager.resolveRegistryPackage(registry_name, registry_spec) catch |err| switch (err) {
            error.NoMatchingVersion, error.PackageNotFound, error.TooRecentVersion, error.AllVersionsTooRecent => return,
            else => return err,
        };
        const latest = manager.resolveRegistryPackage(registry_name, "latest") catch |err| switch (err) {
            error.NoMatchingVersion, error.PackageNotFound, error.TooRecentVersion, error.AllVersionsTooRecent => return,
            else => return err,
        };
        const current_version = selection.package.version;
        const latest_version = latest.latest_version orelse latest.version;
        if (std.mem.eql(u8, current_version, target.version) and
            std.mem.eql(u8, current_version, latest_version)) return;

        try packages.append(.{
            .alias = try manager.allocator.dupe(u8, alias),
            .current_version = try manager.allocator.dupe(u8, current_version),
            .target_version = try manager.allocator.dupe(u8, target.version),
            .latest_version = try manager.allocator.dupe(u8, latest_version),
            .dependency_type = dependency_type,
            .spec_value = spec_value,
            .manifest = manifest,
            .manifest_dir = manifest_dir,
            .use_latest = manager.options.latest,
        });
    }

    fn collectInteractiveUpdateCandidates(
        manager: *Manager,
        root: *Value,
        package_json: *Value,
        parent_dir: []const u8,
        packages: *std.array_list.Managed(InteractiveUpdatePackage),
    ) !void {
        if (package_json.* != .object) return;
        var seen = std.StringHashMap(void).init(manager.allocator);
        defer seen.deinit();

        for (update_dependency_sections) |dependency_section| {
            if (std.mem.eql(u8, dependency_section.name, "devDependencies") and
                (manager.options.production or manager.options.omit_dev)) continue;
            if (std.mem.eql(u8, dependency_section.name, "optionalDependencies") and manager.options.omit_optional) continue;
            if (std.mem.eql(u8, dependency_section.name, "peerDependencies") and manager.options.omit_peer) continue;

            const section = package_json.object.getPtr(dependency_section.name) orelse continue;
            if (section.* != .object) continue;
            for (section.object.keys(), section.object.values()) |alias, *spec_value| {
                if (spec_value.* != .string) continue;
                if (manager.options.positionals.len > 0 and !interactiveRequestContains(manager.options.positionals, alias)) continue;

                const original_spec = spec_value.string;
                const is_catalog = std.mem.startsWith(u8, original_spec, "catalog:");
                if (!is_catalog) {
                    if (seen.contains(alias)) continue;
                    try seen.put(try manager.allocator.dupe(u8, alias), {});
                    if (manager.isWorkspaceDependency(alias, original_spec)) continue;
                }

                const effective_spec = manager.manifest_policy.?.resolveDependency(alias, original_spec, false) catch |err| switch (err) {
                    error.CatalogDependencyNotFound, error.InvalidCatalogDependency => continue,
                };
                if (!isRegistryUpdateSpecifier(effective_spec)) continue;

                if (is_catalog) {
                    const catalog_value = interactiveCatalogValue(root, alias, original_spec) orelse continue;
                    try manager.appendInteractiveUpdateCandidate(
                        packages,
                        alias,
                        effective_spec,
                        dependency_section.name,
                        parent_dir,
                        catalog_value,
                        root,
                        manager.root_dir,
                    );
                } else {
                    try manager.appendInteractiveUpdateCandidate(
                        packages,
                        alias,
                        effective_spec,
                        dependency_section.name,
                        parent_dir,
                        spec_value,
                        package_json,
                        parent_dir,
                    );
                }
            }
        }
    }

    fn preserveInteractiveVersionSpec(
        manager: *Manager,
        original_spec: []const u8,
        target_version: []const u8,
    ) ![]const u8 {
        var range = original_spec;
        const alias_prefix = npmAliasPrefix(original_spec);
        if (alias_prefix) |prefix| {
            if (original_spec.len > prefix.len and original_spec[prefix.len] == '@') {
                range = original_spec[prefix.len + 1 ..];
            }
        }

        var operator: []const u8 = "";
        if (range.len > 0 and (range[0] == '^' or range[0] == '~' or range[0] == '>' or range[0] == '<' or range[0] == '=')) {
            const operator_len: usize = if (range.len > 1 and
                (range[0] == '>' or range[0] == '<') and range[1] == '=') 2 else 1;
            operator = range[0..operator_len];
        }
        const version_spec = try std.fmt.allocPrint(manager.allocator, "{s}{s}", .{ operator, target_version });
        if (alias_prefix) |prefix| {
            return std.fmt.allocPrint(manager.allocator, "{s}@{s}", .{ prefix, version_spec });
        }
        return version_spec;
    }

    fn recordInteractiveChangedManifest(manager: *Manager, package_json: *Value, parent_dir: []const u8) !void {
        for (manager.interactive_changed_manifests.items) |manifest| {
            if (manifest.package_json == package_json) return;
        }
        const path = try std.fs.path.join(manager.allocator, &.{ parent_dir, "package.json" });
        const source = try std.Io.Dir.cwd().readFileAlloc(
            manager.init_data.io,
            path,
            manager.allocator,
            .limited(64 * 1024 * 1024),
        );
        try manager.interactive_changed_manifests.append(manager.allocator, .{
            .package_json = package_json,
            .path = path,
            .had_trailing_newline = source.len > 0 and source[source.len - 1] == '\n',
        });
    }

    fn prepareInteractiveUpdate(manager: *Manager, root: *Value, package_json: *Value, parent_dir: []const u8) !bool {
        if (manager.lock_graph == null) {
            try manager.stderr.writeAll("error: missing lockfile, nothing outdated\n");
            return error.PackageManagerErrorReported;
        }

        var packages = std.array_list.Managed(InteractiveUpdatePackage).init(manager.allocator);
        defer packages.deinit();

        const previous_refresh = manager.refresh_direct_registry;
        manager.refresh_direct_registry = true;
        defer manager.refresh_direct_registry = previous_refresh;

        if (manager.options.filters.len > 0) {
            if (manager.root_selected) try manager.collectInteractiveUpdateCandidates(root, root, manager.root_dir, &packages);
            var workspaces = manager.workspaces.iterator();
            while (workspaces.next()) |entry| {
                const workspace = entry.value_ptr.*;
                if (!manager.workspaceSelected(workspace)) continue;
                try manager.collectInteractiveUpdateCandidates(root, workspace.package_json, workspace.path, &packages);
            }
        } else if (manager.options.recursive) {
            try manager.collectInteractiveUpdateCandidates(root, root, manager.root_dir, &packages);
            var workspaces = manager.workspaces.iterator();
            while (workspaces.next()) |entry| {
                const workspace = entry.value_ptr.*;
                try manager.collectInteractiveUpdateCandidates(root, workspace.package_json, workspace.path, &packages);
            }
        } else {
            try manager.collectInteractiveUpdateCandidates(root, package_json, parent_dir, &packages);
        }

        std.sort.pdq(InteractiveUpdatePackage, packages.items, {}, struct {
            fn lessThan(_: void, left: InteractiveUpdatePackage, right: InteractiveUpdatePackage) bool {
                const left_priority = interactiveDependencyPriority(left.dependency_type);
                const right_priority = interactiveDependencyPriority(right.dependency_type);
                if (left_priority != right_priority) return left_priority < right_priority;
                const alias_order = std.mem.order(u8, left.alias, right.alias);
                if (alias_order != .eq) return alias_order == .lt;
                return std.mem.order(u8, left.manifest_dir, right.manifest_dir) == .lt;
            }
        }.lessThan);

        if (packages.items.len == 0) {
            try manager.stdout.writeAll("All packages are up to date!\n");
            try manager.stdout.flush();
            return false;
        }
        switch (try manager.promptInteractiveUpdates(packages.items)) {
            .cancelled => {
                try manager.stdout.writeAll("Cancelled\n");
                try manager.stdout.flush();
                return false;
            },
            .empty => {
                try manager.stdout.writeAll("No packages selected for update\n");
                try manager.stdout.flush();
                return false;
            },
            .selected => {},
        }

        var selected_count: usize = 0;
        for (packages.items) |package| selected_count += @intFromBool(package.selected);
        try manager.stdout.print("Selected {d} package{s} to update\n", .{
            selected_count,
            if (selected_count == 1) "" else "s",
        });
        if (manager.options.dry_run) {
            try manager.stdout.writeAll("Dry run complete - no changes made\n");
            try manager.stdout.flush();
            return false;
        }

        try manager.stdout.writeAll("\nInstalling updates...\n");
        for (packages.items) |package| {
            if (!package.selected) continue;
            const target_version = if (package.use_latest) package.latest_version else package.target_version;
            if (std.mem.eql(u8, package.current_version, target_version)) continue;
            const original_spec = package.spec_value.string;
            const updated_spec = try manager.preserveInteractiveVersionSpec(original_spec, target_version);
            if (std.mem.eql(u8, original_spec, updated_spec)) continue;
            package.spec_value.* = .{ .string = updated_spec };
            try manager.recordInteractiveChangedManifest(package.manifest, package.manifest_dir);
        }
        if (manager.interactive_changed_manifests.items.len == 0) return false;

        if (manager.manifest_policy) |*policy| policy.deinit();
        manager.manifest_policy = try Manifest.Policy.init(manager.allocator, root);
        manager.interactive_update_prepared = true;
        manager.update_package_json_changed = true;
        manager.changed = true;
        try manager.stdout.flush();
        return true;
    }

    fn promptInteractiveUpdates(manager: *Manager, packages: []InteractiveUpdatePackage) !InteractivePromptResult {
        var cursor: usize = 0;
        var toggle_all = false;
        const terminal_mode = InteractiveTerminalMode.enter();
        defer terminal_mode.restore();

        var reader_buffer: [1]u8 = undefined;
        var reader_file = std.Io.File.stdin().readerStreaming(manager.init_data.io, &reader_buffer);
        const reader = &reader_file.interface;
        while (true) {
            try manager.renderInteractiveUpdates(packages, cursor, terminal_mode.is_tty);
            const byte = reader.takeByte() catch return .cancelled;
            switch (byte) {
                '\n', '\r', 'y', 'Y' => {
                    for (packages) |package| if (package.selected) return .selected;
                    return .empty;
                },
                3, 4, 'q', 'Q' => return .cancelled,
                ' ' => {
                    packages[cursor].selected = !packages[cursor].selected;
                    if (std.mem.eql(u8, packages[cursor].current_version, packages[cursor].target_version)) {
                        packages[cursor].use_latest = true;
                    }
                    toggle_all = false;
                },
                'a', 'A' => {
                    for (packages) |*package| {
                        package.selected = true;
                        if (std.mem.eql(u8, package.current_version, package.target_version)) package.use_latest = true;
                    }
                    toggle_all = true;
                },
                'n', 'N' => {
                    for (packages) |*package| package.selected = false;
                    toggle_all = false;
                },
                'i', 'I' => {
                    for (packages) |*package| package.selected = !package.selected;
                    toggle_all = false;
                },
                'l', 'L' => {
                    if (toggle_all) {
                        const use_latest = !packages[cursor].use_latest;
                        for (packages) |*package| {
                            if (package.selected) package.use_latest = use_latest;
                        }
                    } else {
                        packages[cursor].use_latest = !packages[cursor].use_latest;
                        packages[cursor].selected = true;
                    }
                },
                'j' => {
                    cursor = if (cursor + 1 < packages.len) cursor + 1 else 0;
                    toggle_all = false;
                },
                'k' => {
                    cursor = if (cursor > 0) cursor - 1 else packages.len - 1;
                    toggle_all = false;
                },
                27 => {
                    const bracket = reader.takeByte() catch return .cancelled;
                    if (bracket != '[') continue;
                    const arrow = reader.takeByte() catch return .cancelled;
                    switch (arrow) {
                        'A' => cursor = if (cursor > 0) cursor - 1 else packages.len - 1,
                        'B' => cursor = if (cursor + 1 < packages.len) cursor + 1 else 0,
                        'C' => {
                            packages[cursor].use_latest = true;
                            packages[cursor].selected = true;
                        },
                        'D' => {
                            packages[cursor].use_latest = false;
                            packages[cursor].selected = true;
                        },
                        else => {},
                    }
                    toggle_all = false;
                },
                else => {},
            }
        }
    }

    fn renderInteractiveUpdates(
        manager: *Manager,
        packages: []const InteractiveUpdatePackage,
        cursor: usize,
        clear_terminal: bool,
    ) !void {
        if (clear_terminal) try manager.stdout.writeAll("\x1b[2J\x1b[H");
        try manager.stdout.writeAll("Select packages to update (space: select, l: latest, enter: confirm)\n\n");
        var current_section: ?[]const u8 = null;
        for (packages, 0..) |package, index| {
            if (current_section == null or !std.mem.eql(u8, current_section.?, package.dependency_type)) {
                current_section = package.dependency_type;
                try manager.stdout.print("{s}\n", .{package.dependency_type});
            }
            try manager.stdout.print("{s} [{c}] {s}: {s} -> {s} (latest {s})\n", .{
                if (index == cursor) ">" else " ",
                if (package.selected) @as(u8, 'x') else @as(u8, ' '),
                package.alias,
                package.current_version,
                if (package.use_latest) package.latest_version else package.target_version,
                package.latest_version,
            });
        }
        try manager.stdout.flush();
    }

    fn updatePackages(manager: *Manager, package_json: *Value, parent_dir: []const u8) !void {
        if (manager.interactive_update_prepared) {
            try manager.installRoot(manager.root_package_json.?, true);
            return;
        }
        const requests = try manager.parseUpdateRequests();
        var handled = std.StringHashMap(void).init(manager.allocator);
        defer handled.deinit();
        var update_output: std.Io.Writer.Allocating = .init(manager.allocator);
        var reinstalled_output: std.Io.Writer.Allocating = .init(manager.allocator);

        for (update_dependency_sections) |dependency_section| {
            const section_value = package_json.object.getPtr(dependency_section.name) orelse continue;
            if (section_value.* != .object) continue;
            for (section_value.object.keys(), section_value.object.values()) |name, *spec_value| {
                const request = findUpdateRequest(requests, name);
                if (requests.len > 0 and request == null) continue;
                if (spec_value.* != .string) {
                    if (request != null) try handled.put(name, {});
                    continue;
                }

                const original_spec = spec_value.string;
                const source_update = request != null and blk: {
                    if (request.?.spec) |requested_spec| break :blk isNativeSourceSpecifier(requested_spec);
                    break :blk isNativeSourceSpecifier(original_spec);
                };
                if (!source_update and !shouldUpdateRegistrySpec(original_spec, request != null, manager.options.latest, request)) {
                    if (request != null) try handled.put(name, {});
                    continue;
                }
                const handled_entry = try handled.getOrPut(name);
                if (handled_entry.found_existing) continue;
                const previous_changed = manager.changed;
                const previous_installed_count = manager.installed_count;
                const result = if (source_update)
                    try manager.resolveUpdatedSourceDependency(
                        name,
                        if (request.?.spec) |requested_spec| requested_spec else original_spec,
                        parent_dir,
                        dependency_section.optional,
                    )
                else
                    try manager.resolveUpdatedDependency(
                        name,
                        if (isRegistryUpdateSpecifier(original_spec)) original_spec else null,
                        request,
                        parent_dir,
                        dependency_section.optional,
                    );
                const manifest_changed = !std.mem.eql(u8, original_spec, result.saved_spec);
                if (manifest_changed) {
                    spec_value.* = .{ .string = try manager.allocator.dupe(u8, result.saved_spec) };
                    manager.update_package_json_changed = true;
                    manager.changed = true;
                } else if (result.previous_version) |previous_version| {
                    if (std.mem.eql(u8, previous_version, result.resolved_version) and
                        manager.installed_count == previous_installed_count)
                    {
                        manager.changed = previous_changed;
                    }
                }
                const was_reinstalled = manager.installed_count > previous_installed_count and
                    result.previous_version != null and
                    std.mem.eql(u8, result.previous_version.?, result.resolved_version);
                if (request == null and was_reinstalled) {
                    try reinstalled_output.writer.print("+ {s}@{s}\n", .{ name, result.resolved_version });
                } else {
                    try manager.appendUpdateOutput(&update_output.writer, name, result, request != null);
                }
            }
        }

        if (requests.len > 0) {
            for (requests) |*request| {
                if (request.alias) |alias| {
                    if (handled.contains(alias)) continue;
                }
                const requested_spec = request.spec orelse "latest";
                const result = if (isNativeSourceSpecifier(requested_spec))
                    try manager.resolveUpdatedSourceDependency(
                        request.alias,
                        requested_spec,
                        parent_dir,
                        manager.options.section == .optionalDependencies,
                    )
                else if (request.alias) |alias|
                    try manager.resolveUpdatedDependency(
                        alias,
                        null,
                        request,
                        parent_dir,
                        manager.options.section == .optionalDependencies,
                    )
                else {
                    try manager.stderr.print("error: unrecognised dependency format: {s}\n", .{requested_spec});
                    return error.PackageManagerErrorReported;
                };
                if (handled.contains(result.alias)) continue;
                const target_section = manager.sectionForAdd(package_json, result.alias);
                const section = try ensureObjectProperty(manager.allocator, &package_json.object, target_section.key());
                manager.removeDependencyFromOtherSections(package_json, result.alias, target_section);
                try section.put(
                    manager.allocator,
                    try manager.allocator.dupe(u8, result.alias),
                    .{ .string = try manager.allocator.dupe(u8, result.saved_spec) },
                );
                manager.update_package_json_changed = true;
                manager.changed = true;
                try manager.appendUpdateOutput(&update_output.writer, result.alias, result, true);
                try handled.put(result.alias, {});
            }
        }

        try manager.installRoot(manager.root_package_json.?, true);
        if (!manager.options.silent) {
            try manager.stdout.writeAll(update_output.written());
            if (update_output.written().len > 0 and reinstalled_output.written().len > 0) {
                try manager.stdout.writeByte('\n');
            }
            try manager.stdout.writeAll(reinstalled_output.written());
        }
    }

    fn parseUpdateRequests(manager: *Manager) ![]const UpdateRequest {
        var requests = std.array_list.Managed(UpdateRequest).init(manager.allocator);
        var seen = std.StringHashMap(void).init(manager.allocator);
        defer seen.deinit();

        for (manager.options.positionals) |raw_positional| {
            const positional = std.mem.trim(u8, raw_positional, " \t\r\n");
            if (positional.len == 0 or hasUnknownURLScheme(positional)) {
                try manager.stderr.print("error: unrecognised dependency format: {s}\n", .{raw_positional});
                return error.PackageManagerErrorReported;
            }
            const parsed = splitPackageSpec(positional);
            const alias = parsed.name;
            const explicit_spec = alias == null or packageSpecHasExplicitSpecifier(positional);
            if (alias) |name| {
                if (!compiler.strings.isNPMPackageName(name)) {
                    try manager.stderr.print("error: unrecognised dependency format: {s}\n", .{raw_positional});
                    return error.PackageManagerErrorReported;
                }
            }
            if (alias == null and !isNativeSourceSpecifier(parsed.spec)) {
                try manager.stderr.print("error: unrecognised dependency format: {s}\n", .{raw_positional});
                return error.PackageManagerErrorReported;
            }
            if (explicit_spec and !isNativeSourceSpecifier(parsed.spec) and !isRegistryUpdateSpecifier(parsed.spec)) {
                try manager.stderr.print("error: unrecognised dependency format: {s}\n", .{raw_positional});
                return error.PackageManagerErrorReported;
            }
            const entry = try seen.getOrPut(alias orelse positional);
            if (entry.found_existing) continue;
            try requests.append(.{
                .alias = alias,
                .spec = if (explicit_spec) parsed.spec else null,
            });
        }
        return requests.toOwnedSlice();
    }

    fn resolveUpdatedDependency(
        manager: *Manager,
        alias: []const u8,
        original_spec: ?[]const u8,
        request: ?*const UpdateRequest,
        parent_dir: []const u8,
        optional: bool,
    ) !UpdateResult {
        const previous_version = if (try manager.findLockedSelection(alias, parent_dir)) |selection|
            selection.package.version
        else
            null;
        const resolution_spec = try updateResolutionSpec(
            manager.allocator,
            original_spec,
            request,
            manager.options.latest,
        );
        manager.direct_bins.clearRetainingCapacity();
        const resolved_version = blk: {
            const previous_refresh = manager.refresh_direct_registry;
            manager.refresh_direct_registry = true;
            defer manager.refresh_direct_registry = previous_refresh;
            break :blk try manager.installDependency(alias, resolution_spec, parent_dir, true, optional, false);
        };
        return .{
            .alias = alias,
            .resolved_version = resolved_version,
            .saved_spec = try formatUpdatedRegistrySpec(
                manager.allocator,
                alias,
                original_spec,
                resolution_spec,
                resolved_version,
                if (request) |value| value.spec != null else false,
                manager.options.exact,
            ),
            .previous_version = previous_version,
        };
    }

    fn resolveUpdatedSourceDependency(
        manager: *Manager,
        alias_hint: ?[]const u8,
        requested_spec: []const u8,
        parent_dir: []const u8,
        optional: bool,
    ) !UpdateResult {
        var alias = alias_hint;
        var saved_spec = requested_spec;
        if (isLocalSpec(requested_spec) and !isTarballSpec(requested_spec)) {
            const local = manager.resolveLocalPackage(requested_spec, parent_dir) catch |err| {
                try manager.stderr.print("note: error occurred while resolving {s}\n", .{requested_spec});
                return err;
            };
            alias = alias orelse local.name;
            saved_spec = try manager.normalizeLocalSpecFrom(requested_spec, local.path, parent_dir);
        }

        const previous_version = if (alias) |name|
            if (try manager.findLockedSelection(name, parent_dir)) |selection| selection.package.version else null
        else
            null;
        manager.direct_bins.clearRetainingCapacity();

        var resolved_version: []const u8 = undefined;
        if (alias) |name| {
            const previous_refresh = manager.refresh_direct_source;
            manager.refresh_direct_source = true;
            defer manager.refresh_direct_source = previous_refresh;
            resolved_version = try manager.installDependency(name, saved_spec, parent_dir, true, optional, false);
        } else if (isGitSpec(requested_spec)) {
            const git = try manager.installGit(null, requested_spec, parent_dir, true, optional, null, &.{});
            alias = git.alias;
            resolved_version = git.version;
        } else if (isTarballSpec(requested_spec)) {
            const tarball = try manager.installTarball(null, requested_spec, parent_dir, true, optional, &.{});
            alias = tarball.alias;
            resolved_version = tarball.version;
        } else {
            return error.InvalidPackageName;
        }
        manager.changed = true;

        return .{
            .alias = alias.?,
            .resolved_version = resolved_version,
            .saved_spec = saved_spec,
            .previous_version = previous_version,
        };
    }

    fn appendUpdateOutput(
        manager: *Manager,
        writer: *std.Io.Writer,
        alias: []const u8,
        result: UpdateResult,
        requested: bool,
    ) !void {
        if (manager.options.silent or manager.options.no_summary) return;
        if (requested) {
            if (manager.direct_bins.items.len == 0) {
                try writer.print("installed {s}@{s}\n", .{ alias, result.resolved_version });
            } else {
                try writer.print("installed {s}@{s} with binaries:\n", .{ alias, result.resolved_version });
                for (manager.direct_bins.items) |bin_name| try writer.print(" - {s}\n", .{bin_name});
            }
            return;
        }
        if (result.previous_version) |previous| {
            if (!std.mem.eql(u8, previous, result.resolved_version)) {
                try writer.print("^ {s} {s} -> {s}\n", .{ alias, previous, result.resolved_version });
            }
        } else {
            try writer.print("+ {s}@{s}\n", .{ alias, result.resolved_version });
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
        const aliases = try manager.allocator.dupe([]const u8, dependencies.object.keys());
        std.mem.sort([]const u8, aliases, {}, lessString);
        for (aliases) |alias| {
            const spec_value = dependencies.object.get(alias) orelse continue;
            if (spec_value != .string) continue;
            if (std.mem.eql(u8, key, "dependencies") and objectSectionContains(package_json, "optionalDependencies", alias)) continue;
            if (std.mem.eql(u8, key, "dependencies") and direct and
                !manager.options.production and !manager.options.omit_dev and
                objectSectionContains(package_json, "devDependencies", alias)) continue;
            if (std.mem.eql(u8, key, "dependencies") and
                !std.mem.eql(u8, parent_dir, manager.root_dir) and
                !manager.pathIsWorkspace(parent_dir) and
                packageDependencyIsBundled(package_json, alias)) continue;
            if (std.mem.eql(u8, key, "peerDependencies") and
                (objectSectionContains(package_json, "dependencies", alias) or
                    objectSectionContains(package_json, "optionalDependencies", alias) or
                    (direct and !manager.options.production and !manager.options.omit_dev and
                        objectSectionContains(package_json, "devDependencies", alias)))) continue;
            const optional_peer = std.mem.eql(u8, key, "peerDependencies") and peerDependencyIsOptional(package_json, alias);
            if (optional_peer) continue;
            const edge_optional = optional;
            const edge_peer = std.mem.eql(u8, key, "peerDependencies");
            const resolved_version = manager.installDependency(alias, spec_value.string, parent_dir, direct, edge_optional, edge_peer) catch |err| {
                if (manager.options.command == .link and !direct and err == error.MissingPackageJSON) continue;
                // COTTONTAIL-COMPAT: Bun resolves peer edges after required
                // dependencies and leaves an unresolved peer non-fatal.
                if (edge_peer and err != error.OutOfMemory) continue;
                if (edge_optional) continue;
                if (direct and manager.options.command == .install and err == error.PackageManagerErrorReported) {
                    if (manager.deferred_install_error == null) manager.deferred_install_error = err;
                    continue;
                }
                return err;
            };
            const workspace_display = if (manager.report_direct_installs)
                try manager.workspaceDisplayResolution(alias, spec_value.string, parent_dir)
            else
                null;
            const should_report = manager.report_direct_installs and
                std.mem.eql(u8, parent_dir, manager.invocation_package_dir) and
                !manager.explicit_adds.contains(alias);
            if (should_report and
                (manager.options.dry_run or
                    manager.directDependencyChanged(alias, resolved_version) or
                    manager.options.command == .remove or
                    (workspace_display != null and manager.lock_graph == null)) and
                !manager.options.silent)
            {
                const display = if (isTarballSpec(spec_value.string))
                    spec_value.string
                else if (isGitSpec(spec_value.string))
                    try manager.directGitDisplay(alias, spec_value.string)
                else if (isLocalSpec(spec_value.string))
                    if (isGlobalLinkSpec(spec_value.string)) spec_value.string else directLocalDisplay(spec_value.string)
                else
                    workspace_display orelse resolved_version;
                try manager.direct_install_reports.append(.{
                    .alias = alias,
                    .display = display,
                    .latest_version = manager.latest_versions.get(alias),
                    .section_priority = directInstallSectionPriority(key),
                    .sequence = manager.direct_install_reports.items.len,
                });
            }
        }
    }

    fn emitDirectInstallReports(manager: *Manager) !void {
        if (manager.direct_install_reports.items.len == 0) return;
        std.sort.pdq(DirectInstallReport, manager.direct_install_reports.items, {}, struct {
            fn lessThan(_: void, left: DirectInstallReport, right: DirectInstallReport) bool {
                if (left.section_priority != right.section_priority) return left.section_priority < right.section_priority;
                const alias_order = std.mem.order(u8, left.alias, right.alias);
                if (alias_order != .eq) return alias_order == .lt;
                return left.sequence < right.sequence;
            }
        }.lessThan);
        for (manager.direct_install_reports.items) |report| {
            if (manager.options.dry_run) {
                try manager.stdout.print(" {s}@{s}", .{ report.alias, report.display });
            } else {
                try manager.stdout.print("+ {s}@{s}", .{ report.alias, report.display });
                if (report.latest_version) |latest| {
                    const record = manager.directRecord(report.alias);
                    const is_alias = if (record) |resolved| !std.mem.eql(u8, report.alias, resolved.name) else false;
                    const is_prerelease = std.mem.indexOfScalar(u8, report.display, '-') != null;
                    if (!is_alias and !is_prerelease and semverVersionLessThan(report.display, latest)) {
                        try manager.stdout.print(" (v{s} available)", .{latest});
                    }
                }
            }
            try manager.stdout.writeByte('\n');
        }
    }

    fn rootLifecycleScriptsWillRun(manager: *const Manager) bool {
        return manager.options.command == .install and
            manager.root_selected and
            !manager.options.ignore_scripts and
            !manager.options.lockfile_only and
            !manager.options.dry_run and
            Scripts.rootHasLifecycleScripts(manager.init_data.io, manager.root_dir, manager.root_package_json.?);
    }

    fn installSummarySeparator(manager: *const Manager) []const u8 {
        if (manager.options.command == .install and
            manager.direct_install_reports.items.len == 0 and
            !manager.rootLifecycleScriptsWillRun()) return "";
        return "\n";
    }

    fn directGitDisplay(manager: *Manager, alias: []const u8, fallback: []const u8) ![]const u8 {
        var index = manager.records.items.len;
        while (index > 0) {
            index -= 1;
            const record = manager.records.items[index];
            if (!std.mem.eql(u8, record.alias, alias) or
                (record.kind != .git and record.kind != .github)) continue;
            return displayGitResolution(manager.allocator, record.resolution);
        }
        return displayGitResolution(manager.allocator, fallback);
    }

    fn duplicateDirectInstallCount(manager: *const Manager) usize {
        var duplicates: usize = 0;
        for (manager.direct_install_reports.items, 0..) |report, index| {
            const record = manager.directRecord(report.alias) orelse continue;
            for (manager.direct_install_reports.items[0..index]) |previous_report| {
                const previous = manager.directRecord(previous_report.alias) orelse continue;
                if (record.kind != .npm and packageRecordsHaveSameIdentity(record, previous)) {
                    duplicates += 1;
                    break;
                }
            }
        }
        return duplicates;
    }

    fn directRecord(manager: *const Manager, alias: []const u8) ?PackageRecord {
        for (manager.records.items) |record| {
            if (std.mem.eql(u8, record.alias, alias) and
                (std.mem.eql(u8, record.key, alias) or isTopLevelDestination(manager.root_dir, record.install_dir, alias)))
            {
                return record;
            }
        }
        return null;
    }

    fn packageWasTrustedInLoadedLock(manager: *const Manager, package_name: []const u8, npm_package: bool) bool {
        const graph = if (manager.lock_graph) |*value| value else return false;
        // An explicit trustedDependencies list replaces the default list. When
        // that mode changes, packages named explicitly must run their scripts
        // again even if they were previously covered by Bun's defaults.
        const loaded_defaults_apply = npm_package and manager.manifest_policy.?.trusted_dependencies == null;
        if (manager.loaded_binary_lockfile) {
            return Manifest.Policy.wasTrustedInLockHashes(
                manager.binary_lockfile_trusted_dependency_hashes,
                package_name,
                loaded_defaults_apply,
            );
        }
        return Manifest.Policy.wasTrustedInLock(&graph.document, package_name, loaded_defaults_apply);
    }

    fn directDependencyWasAdded(manager: *const Manager, alias: []const u8) bool {
        const graph = if (manager.lock_graph) |*value| value else return true;
        return graph.rootDependencySpec(alias) == null;
    }

    fn directDependencyChanged(manager: *const Manager, alias: []const u8, resolved_version: []const u8) bool {
        if (manager.directDependencyWasAdded(alias)) return true;
        const initial = manager.initial_root_versions.get(alias) orelse return true;
        return !std.mem.eql(u8, initial, resolved_version);
    }

    fn installDependency(
        manager: *Manager,
        alias: []const u8,
        spec: []const u8,
        parent_dir: []const u8,
        direct: bool,
        optional: bool,
        peer: bool,
    ) anyerror![]const u8 {
        var workspace_package = manager.isWorkspaceDependency(alias, spec);
        const effective_spec = manager.manifest_policy.?.resolveDependency(alias, spec, workspace_package) catch |err| {
            if (err == error.CatalogDependencyNotFound or err == error.InvalidCatalogDependency) {
                if (peer) return err;
                try manager.stderr.print("error: {s}@{s} failed to resolve\n", .{ alias, spec });
                return error.PackageManagerErrorReported;
            }
            return err;
        };
        if (!workspace_package) workspace_package = manager.isWorkspaceDependency(alias, effective_spec);
        var protocol_patch_paths: []const []const u8 = &.{};
        const resolution_spec = if (try Patch.Spec.parseProtocol(manager.allocator, alias, effective_spec)) |protocol| blk: {
            protocol_patch_paths = protocol.patch_paths;
            break :blk protocol.base_spec;
        } else effective_spec;

        const explicit_global_link = manager.options.command == .link and direct;
        // COTTONTAIL-COMPAT: scanner preflight has already resolved selected
        // add roots. Reuse that result so an installed root is not fetched a
        // second time while materializing newly approved dependencies.
        const refresh_unscanned_add = manager.options.command == .add and
            manager.security_scanner == null and
            !manager.report_direct_installs and
            !manager.isSecurityResolution();
        const refresh_missing_scanned_lock_root = blk: {
            if (manager.options.command != .add or
                manager.security_scanner == null or
                manager.lock_graph == null or
                manager.report_direct_installs or
                manager.isSecurityResolution()) break :blk false;
            const locked = (try manager.findLockedSelection(alias, parent_dir)) orelse break :blk false;
            // COTTONTAIL-COMPAT: Bun refreshes a selected locked root when its
            // materialization is missing, while new roots reuse the manifests
            // already fetched by scanner preflight.
            break :blk !manager.pathExists(locked.destination);
        };
        const refresh_direct_registry = direct and
            !workspace_package and
            !isGitSpec(resolution_spec) and
            !isTarballSpec(resolution_spec) and
            !isLocalSpec(resolution_spec) and
            (manager.refresh_direct_registry or
                refresh_unscanned_add or
                refresh_missing_scanned_lock_root);
        const refresh_direct_source = direct and manager.refresh_direct_source and
            (workspace_package or isGitSpec(resolution_spec) or isTarballSpec(resolution_spec) or
                isLocalSpec(resolution_spec) or std.mem.startsWith(u8, effective_spec, "patch:"));

        const inspect_direct_trust = manager.options.trust and manager.options.command == .add and direct;
        if (direct and !refresh_direct_registry and !refresh_direct_source and !inspect_direct_trust) {
            const direct_key = if (explicit_global_link and !std.mem.eql(u8, parent_dir, manager.root_dir)) blk: {
                const destination = try packageDestination(manager.allocator, parent_dir, alias);
                break :blk try manager.lockKeyForDestination(destination);
            } else alias;
            for (manager.records.items) |record| {
                if (std.mem.eql(u8, record.alias, alias) and std.mem.eql(u8, recordLogicalKey(record), direct_key)) {
                    if (record.kind == .npm) {
                        const registry_name, const registry_spec = parseNpmAlias(alias, resolution_spec);
                        if (!std.mem.eql(u8, record.name, registry_name) or
                            !semverSatisfies(manager.allocator, registry_spec, record.version)) continue;
                    }
                    const npm_package = record.kind == .npm;
                    const newly_trusted = manager.manifest_policy.?.isTrusted(alias, npm_package) and
                        !manager.packageWasTrustedInLoadedLock(alias, npm_package);
                    if (!newly_trusted) return record.version;
                }
            }
        }

        if (!refresh_direct_registry and !refresh_direct_source) {
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
        }

        if (workspace_package) {
            const workspace = try manager.resolveWorkspaceDependency(alias, resolution_spec, parent_dir);
            return manager.installResolvedWorkspace(alias, workspace, parent_dir, direct, protocol_patch_paths);
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
            const local = manager.resolveLocalPackage(resolution_spec, parent_dir) catch |err| {
                if (err == error.MissingPackageJSON and !direct) return resolution_spec;
                if (err == error.MissingPackageJSON and !optional and !peer) {
                    try manager.stderr.print(
                        "note: error occurred while resolving {s}@{s}\n",
                        .{ alias, resolution_spec },
                    );
                }
                return err;
            };
            if (isGlobalLinkSpec(resolution_spec) and !manager.options.lockfile_only and !manager.options.dry_run) {
                const cache = try std.fs.path.join(manager.allocator, &.{ manager.root_dir, "node_modules", ".cache" });
                try std.Io.Dir.cwd().createDirPath(manager.init_data.io, cache);
            }
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
            else if (explicit_global_link and !std.mem.eql(u8, parent_dir, manager.root_dir))
                try packageDestination(manager.allocator, parent_dir, alias)
            else if (!std.mem.eql(u8, parent_dir, manager.root_dir) and manager.root_versions.contains(alias))
                try packageDestination(manager.allocator, parent_dir, alias)
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
                    try manager.linkDirectoryAt(destination, local.path);
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
            if (!manager.options.lockfile_only and !manager.options.dry_run) manager.installed_count += 1;
            if (placement_kind != .root) {
                const source_context = try manager.pushIsolatedSourceContext(local.path, destination);
                defer manager.popIsolatedSourceContext(source_context) catch {};
                const cycle_key = try std.fmt.allocPrint(manager.allocator, "local:{s}", .{local.path});
                if (!manager.resolving.contains(cycle_key)) {
                    try manager.resolving.put(cycle_key, {});
                    defer _ = manager.resolving.remove(cycle_key);
                    try manager.installFolderPackageDependencies(local.package_json, local.path, destination, parent_dir);
                }
            }
            if (placement_kind != .root) {
                try manager.queuePackageScripts(alias, local.name, local.version, destination, .local, direct, optional, newly_installed);
            }
            return local.version;
        }

        const registry_name, const registry_spec = parseNpmAlias(alias, resolution_spec);
        const selected_registry_spec = if (!direct)
            if (manager.root_versions.get(alias)) |root_version|
                if (semverSatisfies(manager.allocator, registry_spec, root_version)) root_version else registry_spec
            else
                registry_spec
        else
            registry_spec;
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

        if (!manager.options.force and
            !refresh_direct_registry and
            !manager.shouldRefreshInstalledSecurityRoot(parent_dir, direct))
        {
            if (try manager.findInstalledVersion(alias, resolution_spec, parent_dir, direct, protocol_patch_paths)) |installed| return installed;
        }

        const fetch_log_level: FetchLogLevel = if (optional or peer) .warn else .err;
        const resolved = manager.resolveRegistryPackageWithLogLevel(registry_name, selected_registry_spec, fetch_log_level) catch |err| {
            if (err == error.InvalidRegistryURL or err == error.UnsupportedRegistryScheme) {
                const configured = manager.registryConfigForPackage(registry_name);
                const source_url = configured.source_url orelse configured.url;
                if (err == error.InvalidRegistryURL) {
                    try manager.stderr.print(
                        "{s}: Failed to join registry \"{s}\" and package \"{s}\" URLs\n",
                        .{ if (optional or peer) "warn" else "error", source_url, registry_name },
                    );
                } else {
                    try manager.stderr.print(
                        "{s}: Registry URL must be http:// or https://\nReceived: \"{s}\"\n",
                        .{ if (optional or peer) "warn" else "error", source_url },
                    );
                }
                return error.PackageManagerErrorReported;
            }
            if (err == error.TooRecentVersion or err == error.AllVersionsTooRecent) {
                if (peer) return err;
                const minimum_age_seconds = (manager.options.minimum_release_age_ms orelse 0) / std.time.ms_per_s;
                try manager.stderr.print(
                    "error: No version matching \"{s}\" found for specifier \"{s}\" (blocked by minimum-release-age: {d} seconds)\n",
                    .{ registry_spec, registry_name, minimum_age_seconds },
                );
                return error.PackageManagerErrorReported;
            }
            if (err == error.NoMatchingVersion and
                manager.link_workspace_packages and
                Semver.Version.isTaggedVersionOnly(registry_spec) and
                manager.workspaces.get(registry_name) != null)
            {
                const fallback_spec = try std.fmt.allocPrint(manager.allocator, "workspace:{s}@{s}", .{ registry_name, registry_spec });
                const workspace = try manager.resolveWorkspaceDependency(alias, fallback_spec, parent_dir);
                return manager.installResolvedWorkspace(alias, workspace, parent_dir, direct, protocol_patch_paths);
            }
            if (err == error.NoMatchingVersion) {
                if (peer) return err;
                const package_exists = manager.registry_manifests.contains(registry_name);
                try manager.stderr.print(
                    "error: No version matching \"{s}\" found for specifier \"{s}\"{s}\n",
                    .{ registry_spec, registry_name, if (package_exists) " (but package exists)" else "" },
                );
                return error.PackageManagerErrorReported;
            }
            if (!optional and !peer and (err == error.RegistryManifestRequestFailed or err == error.PackageManagerErrorReported)) {
                try manager.stderr.print("error: {s}@{s} failed to resolve\n", .{ alias, registry_spec });
                return error.PackageManagerErrorReported;
            }
            return err;
        };
        if (resolved.latest_version) |latest| {
            if (!std.mem.eql(u8, latest, resolved.version)) {
                try manager.latest_versions.put(try manager.allocator.dupe(u8, alias), latest);
            }
        }
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
        const package_metadata: *const Value = resolved.metadata;
        const platform_matches = packageSupportsPlatform(
            resolved.metadata,
            manager.options.cpu,
            manager.options.os,
        );
        if (!platform_matches and (optional or manager.options.cpu_overridden or manager.options.os_overridden)) {
            const previous_resolution_only = manager.setResolutionOnly(true);
            defer manager.restoreResolutionOnly(previous_resolution_only);
            if (isTopLevelDestination(manager.root_dir, destination, alias)) {
                try manager.root_versions.put(try manager.allocator.dupe(u8, alias), resolved.version);
            }
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
                .resolution = registry_spec,
                .metadata = resolved.metadata,
                .peer_hash = peer_context.hash,
                .install_dir = destination,
            });
            try manager.rememberPackageMetadata(destination, resolved.metadata);
            manager.changed = true;

            // Keep the lockfile graph cross-platform even though this optional
            // package is not materialized on the current host. Its required
            // dependencies must still be resolvable when the same lockfile is
            // consumed on a matching platform.
            try manager.installDependencyObject(@constCast(resolved.metadata), "dependencies", destination, false, false);
            try manager.installOptionalDependencies(@constCast(resolved.metadata), destination, false);
            try manager.installOrLinkPeerDependencies(resolved.metadata, destination, destination, parent_dir);
            return resolved.version;
        }
        var installed = false;
        if (!manager.options.lockfile_only and !manager.options.dry_run) {
            installed = !manager.options.force and
                try manager.installedPackageMatches(destination, resolved.name, resolved.version) and
                try manager.packagePatchStateMatches(destination, protocol_patch_paths);
            if (!installed) {
                const archive = try manager.fetchRegistryArchive(resolved.archive(), fetch_log_level);
                deletePath(manager.init_data.io, destination);
                try std.Io.Dir.cwd().createDirPath(manager.init_data.io, destination);
                var destination_dir = try std.Io.Dir.cwd().openDir(manager.init_data.io, destination, .{});
                defer destination_dir.close(manager.init_data.io);
                try extractTarballArchive(manager.init_data.io, manager.allocator, destination_dir, archive);
                try manager.applyPackagePatch(resolved.name, resolved.version, destination, protocol_patch_paths);
            }
            try manager.ensureIsolatedLinks(alias, parent_dir, destination);
            try manager.linkBins(alias, destination, package_metadata, direct, parent_dir);
        }

        if (manager.node_linker == .isolated or isTopLevelDestination(manager.root_dir, destination, alias)) {
            try manager.root_versions.put(try manager.allocator.dupe(u8, alias), resolved.version);
        }
        const record_key = if (manager.node_linker == .isolated)
            try manager.dependencyLockKey(parent_dir, alias)
        else
            try manager.lockKeyForDestination(destination);
        try manager.addRecord(.{
            .key = record_key,
            .alias = alias,
            .name = resolved.name,
            .version = resolved.version,
            .tarball = resolved.tarball,
            .integrity = resolved.integrity orelse "",
            .resolution = registry_spec,
            .metadata = resolved.metadata,
            .peer_hash = peer_context.hash,
            .install_dir = destination,
        });
        try manager.rememberPackageMetadata(destination, package_metadata);
        try manager.registerBundledPackages(record_key, package_metadata, destination);
        if (!installed) try manager.countRegistryInstall(resolved.name, resolved.version, resolved.tarball);
        manager.changed = true;

        try manager.installDependencyObject(@constCast(package_metadata), "dependencies", destination, false, false);
        try manager.installOptionalDependencies(@constCast(package_metadata), destination, false);
        try manager.installOrLinkPeerDependencies(package_metadata, destination, destination, parent_dir);
        try manager.queuePackageScripts(alias, resolved.name, resolved.version, destination, .npm, direct, optional, !installed);
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
            const package = graph.get(logical_key) orelse blk: {
                if (try manager.workspaceDependencyLockKey(parent_dir, alias)) |workspace_key| {
                    if (graph.get(workspace_key)) |workspace_package| break :blk workspace_package;
                }
                break :blk graph.get(alias) orelse return null;
            };
            const peer_context = if (package.kind == .workspace)
                Isolated.PeerContext{}
            else
                try manager.peerContextForPackage(package.info, parent_dir, false);
            const destination = if (package.kind == .workspace)
                try std.fs.path.join(manager.allocator, &.{ try manager.isolatedConsumerModules(parent_dir), alias })
            else blk: {
                const placement = try manager.packagePlacementFromLock(package, peer_context);
                try manager.rememberIsolatedParent(placement, logical_key);
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
            if (try manager.workspaceLockKeyForDestination(destination)) |workspace_key| {
                if (graph.get(workspace_key)) |package| {
                    if (try manager.lockedSelectionMatchesRootDependency(package, alias, parent_dir, base)) {
                        return .{ .package = package, .destination = destination };
                    }
                }
            }
            if (manager.lockKeyForDestination(destination) catch null) |key| {
                if (graph.get(key)) |package| {
                    if (try manager.lockedSelectionMatchesRootDependency(package, alias, parent_dir, base)) {
                        return .{ .package = package, .destination = destination };
                    }
                    if (std.mem.eql(u8, base, manager.root_dir) and
                        !std.mem.eql(u8, parent_dir, manager.root_dir))
                    {
                        return .{
                            .package = package,
                            .destination = try packageDestination(manager.allocator, parent_dir, alias),
                        };
                    }
                }
            }
            if (std.mem.eql(u8, base, manager.root_dir)) break;
            base = parentPackageBase(manager.root_dir, base) orelse break;
        }
        return null;
    }

    fn lockedSelectionMatchesRootDependency(
        manager: *Manager,
        package: *const Lockfile.Package,
        alias: []const u8,
        parent_dir: []const u8,
        candidate_base: []const u8,
    ) !bool {
        if (std.mem.eql(u8, parent_dir, manager.root_dir) or
            !std.mem.eql(u8, candidate_base, manager.root_dir)) return true;
        const root_spec = manager.rootDependencySpec(alias) orelse return true;
        const workspace_package = manager.isWorkspaceDependency(alias, root_spec);
        const effective_spec = manager.manifest_policy.?.resolveDependency(alias, root_spec, workspace_package) catch root_spec;
        const resolution_spec = if (try Patch.Spec.parseProtocol(manager.allocator, alias, effective_spec)) |protocol|
            protocol.base_spec
        else
            effective_spec;
        return manager.lockedPackageMatches(package, alias, resolution_spec, manager.root_dir);
    }

    fn lockedPackageMatches(
        manager: *Manager,
        package: *const Lockfile.Package,
        alias: []const u8,
        spec: []const u8,
        parent_dir: []const u8,
    ) !bool {
        const workspace_dependency = manager.isWorkspaceDependency(alias, spec);
        if (workspace_dependency and package.kind != .workspace) return false;
        switch (package.kind) {
            .npm => {
                const registry_name, const registry_spec = parseNpmAlias(alias, spec);
                return std.mem.eql(u8, registry_name, package.name) and
                    semverSatisfies(manager.allocator, registry_spec, package.version);
            },
            .workspace => {
                if (workspace_dependency) {
                    const workspace = try manager.resolveWorkspaceDependency(alias, spec, parent_dir);
                    return std.mem.eql(u8, workspace.name, package.name);
                }
                const workspace = manager.workspaces.get(package.name) orelse return false;
                if (package.source.len > 0 and
                    !std.mem.eql(u8, package.source, workspace.relative_path)) return false;
                const registry_name, const registry_range = parseNpmAlias(alias, spec);
                if (std.mem.startsWith(u8, spec, "npm:") and
                    !std.mem.eql(u8, registry_name, package.name)) return false;
                return manager.workspaceMatchesRange(workspace, registry_range);
            },
            .folder, .symlink => {
                if (!isLocalSpec(spec)) return false;
                const requested = try manager.localPackagePath(spec, parent_dir);
                const locked_spec = try std.fmt.allocPrint(manager.allocator, "{s}{s}", .{
                    if (package.kind == .symlink) "link:" else "file:",
                    package.source,
                });
                const locked = try manager.localPackagePath(locked_spec, manager.root_dir);
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
                if (manager.lock_graph.?.provenance == .npm and !isGitSpec(spec)) {
                    const registry_name, _ = parseNpmAlias(alias, spec);
                    return std.mem.eql(u8, registry_name, package.name) or
                        std.mem.eql(u8, alias, package.name);
                }
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
        const record_key = if (manager.node_linker == .isolated)
            try manager.dependencyLockKey(parent_dir, alias)
        else
            try manager.lockKeyForDestination(selection.destination);
        if (manager.node_linker == .isolated and package.kind != .workspace) {
            try manager.trackIsolatedPlacement(try manager.packagePlacementFromLock(package, selection.peer_context));
            _ = try manager.peerContextForPackage(package.info, parent_dir, true);
        }
        const skip_for_platform = package.kind == .npm and
            package.info != null and
            !packageSupportsPlatform(package.info.?, manager.options.cpu, manager.options.os) and
            (optional or manager.options.cpu_overridden or manager.options.os_overridden);
        if (skip_for_platform) {
            const previous_resolution_only = manager.setResolutionOnly(true);
            defer manager.restoreResolutionOnly(previous_resolution_only);
            if (isTopLevelDestination(manager.root_dir, selection.destination, alias)) {
                try manager.root_versions.put(try manager.allocator.dupe(u8, alias), package.version);
            }
            try manager.addRecord(.{
                .key = record_key,
                .alias = alias,
                .name = package.name,
                .version = package.version,
                .tarball = package.source,
                .git_resolved = package.git_resolved,
                .integrity = package.integrity,
                .metadata = package.info,
                .peer_hash = selection.peer_context.hash,
                .install_dir = selection.destination,
            });
            try manager.rememberPackageMetadata(selection.destination, package.info);
            return package.version;
        }
        switch (package.kind) {
            .npm => {
                const patch_paths = try manager.packagePatchPaths(package.name, package.version, protocol_patch_paths);
                var installed = false;
                const package_metadata = package.info;
                if (!manager.options.lockfile_only and !manager.options.dry_run) {
                    installed = !manager.options.force and
                        try manager.installedPackageMatches(selection.destination, package.name, package.version) and
                        try manager.packagePatchStateMatches(selection.destination, patch_paths);
                    if (!installed) {
                        if (package.source.len > 0 and
                            !std.mem.startsWith(u8, package.source, "https://") and
                            !std.mem.startsWith(u8, package.source, "http://"))
                        {
                            try manager.stderr.print(
                                "error: Expected tarball URL to start with https:// or http://, got \"{s}\" while fetching package \"{s}\"\n",
                                .{ package.source, package.name },
                            );
                            return error.PackageManagerErrorReported;
                        }
                        const registry = manager.registryConfigForPackage(package.name);
                        const tarball_url = if (package.source.len > 0)
                            try resolveRegistryTarballURL(manager.allocator, registry.url, package.source)
                        else
                            try manager.defaultTarballURL(package.name, package.version);
                        const archive = try manager.fetchRegistryArchive(.{
                            .name = package.name,
                            .version = package.version,
                            .tarball = tarball_url,
                            .integrity = if (package.integrity.len > 0) package.integrity else null,
                            .authorization = manager.authorizationForPackageURL(package.name, tarball_url),
                        }, if (optional) .warn else .err);
                        deletePath(manager.init_data.io, selection.destination);
                        try std.Io.Dir.cwd().createDirPath(manager.init_data.io, selection.destination);
                        var destination_dir = try std.Io.Dir.cwd().openDir(manager.init_data.io, selection.destination, .{});
                        defer destination_dir.close(manager.init_data.io);
                        try extractTarballArchive(manager.init_data.io, manager.allocator, destination_dir, archive);
                        try manager.applyPatchPaths(selection.destination, patch_paths);
                        try manager.countRegistryInstall(package.name, package.version, tarball_url);
                    }
                    try manager.ensureIsolatedLinks(alias, parent_dir, selection.destination);
                    if (package.info) |info| {
                        try manager.linkBins(alias, selection.destination, info, direct, parent_dir);
                    } else if (try manager.metadataForInstalledPackage(selection.destination, null)) |info| {
                        try manager.linkBins(alias, selection.destination, info, direct, parent_dir);
                    }
                }

                if (isTopLevelDestination(manager.root_dir, selection.destination, alias)) {
                    try manager.root_versions.put(try manager.allocator.dupe(u8, alias), package.version);
                }
                try manager.addRecord(.{
                    .key = record_key,
                    .alias = alias,
                    .name = package.name,
                    .version = package.version,
                    .tarball = package.source,
                    .integrity = package.integrity,
                    .metadata = package.info,
                    .peer_hash = selection.peer_context.hash,
                    .install_dir = selection.destination,
                });
                try manager.rememberPackageMetadata(selection.destination, package_metadata);
                if (package_metadata) |info| {
                    try manager.registerBundledPackages(record_key, info, selection.destination);
                    const expansion = try manager.expanded_lock_packages.getOrPut(package.key);
                    if (!expansion.found_existing) {
                        try manager.installDependencyObject(@constCast(info), "dependencies", selection.destination, false, false);
                        try manager.installOptionalDependencies(@constCast(info), selection.destination, false);
                        try manager.installOrLinkPeerDependencies(info, selection.destination, selection.destination, parent_dir);
                    }
                }
                try manager.queuePackageScripts(alias, package.name, package.version, selection.destination, .npm, direct, optional, !installed);
                return package.version;
            },
            .workspace => {
                if (protocol_patch_paths.len > 0) return error.UnsupportedPatchResolution;
                const workspace = manager.workspaces.get(package.name) orelse manager.workspaces.get(alias) orelse return error.WorkspaceNotFound;
                if (!manager.options.lockfile_only and !manager.options.dry_run) {
                    try manager.linkRelativeDirectory(selection.destination, workspace.path, true);
                }
                try manager.countWorkspaceInstall(workspace);
                try manager.addRecord(.{
                    .key = record_key,
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
                try manager.installOptionalDependencies(workspace.package_json, workspace.path, false);
                try manager.installOrLinkPeerDependencies(workspace.package_json, workspace.path, workspace.path, parent_dir);
                return workspace.version;
            },
            .folder, .symlink => {
                if (protocol_patch_paths.len > 0) return error.UnsupportedPatchResolution;
                const spec = spec: {
                    if (package.kind == .symlink) {
                        if (manager.rootDependencySpec(alias)) |root_spec| {
                            if (isGlobalLinkSpec(root_spec)) break :spec root_spec;
                        }
                    }
                    break :spec try std.fmt.allocPrint(manager.allocator, "{s}{s}", .{
                        if (package.kind == .symlink) "link:" else "file:",
                        package.source,
                    });
                };
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
                    .key = record_key,
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
                const source_context = try manager.pushIsolatedSourceContext(local.path, selection.destination);
                defer manager.popIsolatedSourceContext(source_context) catch {};
                try manager.installFolderPackageDependencies(local.package_json, local.path, selection.destination, parent_dir);
                try manager.queuePackageScripts(alias, local.name, local.version, selection.destination, .local, direct, optional, newly_installed);
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
                    .key = record_key,
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
                try manager.queuePackageScripts(alias, name, version_value, selection.destination, .local, direct, optional, !installed);
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
                    .key = record_key,
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
        try manager.installOptionalDependencies(@constCast(info), dependency_parent_dir, false);
        try manager.installOrLinkPeerDependencies(info, dependency_parent_dir, package_dir, peer_parent_dir);
    }

    fn installFolderPackageDependencies(
        manager: *Manager,
        package_json: *Value,
        dependency_parent_dir: []const u8,
        package_dir: []const u8,
        peer_parent_dir: []const u8,
    ) !void {
        try manager.installDependencyObject(package_json, "dependencies", dependency_parent_dir, false, false);
        try manager.installOptionalDependencies(package_json, dependency_parent_dir, false);
        if (manager.options.production or manager.options.omit_dev) {
            try manager.resolveOmittedDependencyObject(package_json, "devDependencies", dependency_parent_dir, false, false);
        } else {
            try manager.installDependencyObject(package_json, "devDependencies", dependency_parent_dir, false, false);
        }
        try manager.installOrLinkPeerDependencies(package_json, dependency_parent_dir, package_dir, peer_parent_dir);
    }

    fn installedPackageMatches(manager: *Manager, destination: []const u8, name: []const u8, version_value: []const u8) !bool {
        const package_json_path = try std.fs.path.join(manager.allocator, &.{ destination, "package.json" });
        const source = std.Io.Dir.cwd().readFileAlloc(
            manager.init_data.io,
            package_json_path,
            manager.allocator,
            .limited(4 * 1024 * 1024),
        ) catch return false;
        const package_json = PackageJSON.parsePackageJSON(manager.allocator, package_json_path, source) catch return false;
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
        ) catch |err| return manager.patchFailure(err, patch_paths, null);
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
        var diagnostic: ?Patch.ApplyDiagnostic = null;
        Patch.apply(
            manager.allocator,
            manager.init_data.io,
            manager.root_dir,
            package_dir,
            patch_paths,
            &diagnostic,
        ) catch |err| return manager.patchFailure(err, patch_paths, diagnostic);
    }

    fn patchFailure(
        manager: *Manager,
        err: anyerror,
        patch_paths: []const []const u8,
        diagnostic: ?Patch.ApplyDiagnostic,
    ) anyerror {
        const path = if (patch_paths.len > 0) patch_paths[0] else "";
        if (diagnostic) |detail| {
            if (detail.operation) |_| {
                // COTTONTAIL-COMPAT: Bun reports the concrete I/O failure before the patchfile summary.
                manager.stderr.print("error: failed applying patch file: {f}\n", .{detail}) catch {};
            } else {
                manager.stderr.print("error: failed to parse patchfile: {f}\n", .{detail}) catch {};
            }
        }
        switch (err) {
            error.PatchFileNotFound => manager.stderr.print("error: Couldn't find patch file: '{s}'\n", .{path}) catch {},
            error.EmptyPatchFile => manager.stderr.print("error: patchfile '{s}' is empty, please restore or delete it.\n", .{path}) catch {},
            error.InvalidPatchFile => manager.stderr.print("error: failed to apply patchfile ({s})\n", .{path}) catch {},
            error.PatchApplyFailed => manager.stderr.print("error: failed to apply patchfile ({s})\n", .{path}) catch {},
            else => manager.stderr.print("error: failed to apply patchfile ({s}): {s}\n", .{ path, @errorName(err) }) catch {},
        }
        return error.PackageManagerErrorReported;
    }

    fn defaultTarballURL(manager: *Manager, name: []const u8, version_value: []const u8) ![]const u8 {
        const encoded_name = try encodePackageName(manager.allocator, name);
        const basename = if (std.mem.lastIndexOfScalar(u8, name, '/')) |slash| name[slash + 1 ..] else name;
        const registry = manager.registryConfigForPackage(name);
        return std.fmt.allocPrint(manager.allocator, "{s}{s}/-/{s}-{s}.tgz", .{
            registry.url,
            encoded_name,
            basename,
            version_value,
        });
    }

    fn lockKeyForDestination(manager: *Manager, destination: []const u8) ![]const u8 {
        if (manager.node_linker == .hoisted) {
            if (try manager.workspaceLockKeyForDestination(destination)) |workspace_key| return workspace_key;
        }
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

    fn workspaceDependencyLockKey(manager: *Manager, parent_dir: []const u8, alias: []const u8) !?[]const u8 {
        var workspaces = manager.workspaces.iterator();
        while (workspaces.next()) |entry| {
            const workspace = entry.value_ptr.*;
            if (!std.mem.eql(u8, workspace.path, parent_dir)) continue;
            const key: []const u8 = try std.fmt.allocPrint(manager.allocator, "{s}/{s}", .{ workspace.name, alias });
            return key;
        }
        return null;
    }

    fn workspaceLockKeyForDestination(manager: *Manager, destination: []const u8) !?[]const u8 {
        var selected: ?Workspace = null;
        var workspaces = manager.workspaces.iterator();
        while (workspaces.next()) |entry| {
            const workspace = entry.value_ptr.*;
            if (!pathHasPrefix(destination, workspace.path)) continue;
            if (selected == null or workspace.path.len > selected.?.path.len) selected = workspace;
        }
        const workspace = selected orelse return null;

        var output: std.Io.Writer.Allocating = .init(manager.allocator);
        try output.writer.writeAll(workspace.name);
        var components = std.mem.tokenizeAny(u8, destination[workspace.path.len..], "/\\");
        while (components.next()) |component| {
            if (std.mem.eql(u8, component, "node_modules")) continue;
            try output.writer.writeByte('/');
            try output.writer.writeAll(component);
        }
        return try output.toOwnedSlice();
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
            return std.fmt.allocPrint(manager.allocator, "{s}/{s}", .{ workspace.name, alias });
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
                        true,
                    ) catch |err| {
                        if (err == error.OutOfMemory) return err;
                    };
                }
            }
            if (provider == null) provider = try manager.findPeerProvider(alias, range_value.string, parent_dir);

            if (provider) |resolved| {
                try manager.maybeWarnPeerConflict(range_value.string, resolved);
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

        var importer_key = try manager.logicalImporterKey(parent_dir);
        while (importer_key.len > 0) {
            if (manager.findRecordByLogicalKey(importer_key)) |importer| {
                importer_key = logicalParentKey(importer.*);
            } else {
                importer_key = "";
            }
            if (try manager.findPeerProviderAtLogicalKey(alias, importer_key)) |provider| return provider;
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
        const importer_key = try manager.logicalImporterKey(parent_dir);
        return manager.findPeerProviderAtLogicalKey(alias, importer_key);
    }

    fn findPeerProviderAtLogicalKey(
        manager: *Manager,
        alias: []const u8,
        importer_key: []const u8,
    ) !?PeerProvider {
        const exact_key = try logicalDependencyKey(manager.allocator, importer_key, alias);
        for (manager.records.items) |record| {
            const record_key = recordLogicalKey(record);
            if (!std.mem.eql(u8, record.alias, alias) or !std.mem.eql(u8, record_key, exact_key)) continue;
            const provider: PeerProvider = try manager.peerProviderFromRecord(record);
            return provider;
        }
        return null;
    }

    fn maybeWarnPeerConflict(manager: *Manager, range: []const u8, provider: PeerProvider) !void {
        const matching_concrete_kind = switch (provider.record.kind) {
            .npm => !isGitSpec(range) and !isLocalSpec(range) and !isTarballSpec(range) and
                !std.mem.startsWith(u8, range, "workspace:") and
                !std.mem.startsWith(u8, range, "http://") and
                !std.mem.startsWith(u8, range, "https://"),
            .git, .github => blk: {
                const requested = (Git.parse(manager.allocator, range) catch null) orelse break :blk false;
                break :blk (provider.record.kind == .git and requested.kind == .git) or
                    (provider.record.kind == .github and requested.kind == .github);
            },
            else => false,
        };
        if (!matching_concrete_kind or manager.peerProviderSatisfies(provider.record, range)) return;
        const resolution = switch (provider.record.kind) {
            .git, .github => provider.record.resolution,
            else => provider.record.version,
        };
        const warning_key = try std.fmt.allocPrint(manager.allocator, "{s}@{s}", .{
            provider.record.name,
            resolution,
        });
        const entry = try manager.peer_conflict_warnings.getOrPut(warning_key);
        if (entry.found_existing) return;
        try manager.stderr.print("warn: incorrect peer dependency \"{s}@{s}\"\n", .{
            provider.record.name,
            resolution,
        });
    }

    fn peerProviderSatisfies(manager: *Manager, record: PackageRecord, range: []const u8) bool {
        return switch (record.kind) {
            .npm => blk: {
                const registry_name, const registry_range = parseNpmAlias(record.alias, range);
                break :blk std.mem.eql(u8, registry_name, record.name) and
                    semverSatisfies(manager.allocator, registry_range, record.version);
            },
            .git, .github => Git.matches(manager.allocator, record.resolution, range) catch false,
            else => semverSatisfies(manager.allocator, range, record.version),
        };
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

        var importer_key = try manager.logicalImporterKey(parent_dir);
        while (importer_key.len > 0) {
            if (manager.findRecordByLogicalKey(importer_key)) |importer| {
                importer_key = logicalParentKey(importer.*);
                if (importer_key.len == 0) break;
                const ancestor = manager.findRecordByLogicalKey(importer_key) orelse continue;
                const metadata = ancestor.metadata orelse continue;
                const spec = if (ancestor.kind == .workspace)
                    ownedDependencySpec(metadata, alias)
                else
                    runtimeDependencySpec(metadata, alias);
                if (spec) |value| {
                    return .{
                        .spec = value,
                        .parent_dir = manager.recordDependencyDirectory(ancestor.*),
                        .direct = false,
                    };
                }
                continue;
            }

            if (try manager.workspaceForLogicalPath(importer_key)) |workspace| {
                if (ownedDependencySpec(workspace.package_json, alias)) |spec| {
                    return .{ .spec = spec, .parent_dir = workspace.path, .direct = false };
                }
            }
            break;
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

    fn logicalImporterKey(manager: *Manager, parent_dir: []const u8) ![]const u8 {
        if (std.mem.eql(u8, parent_dir, manager.root_dir)) return "";
        if (manager.isolated_parent_keys.get(parent_dir)) |key| return key;
        var workspaces = manager.workspaces.iterator();
        while (workspaces.next()) |entry| {
            const workspace = entry.value_ptr.*;
            if (std.mem.eql(u8, workspace.path, parent_dir)) return workspace.name;
        }
        return "";
    }

    fn findRecordByLogicalKey(manager: *Manager, key: []const u8) ?*PackageRecord {
        for (manager.records.items) |*record| {
            if (std.mem.eql(u8, recordLogicalKey(record.*), key)) return record;
        }
        return null;
    }

    fn recordDependencyDirectory(manager: *Manager, record: PackageRecord) []const u8 {
        _ = manager;
        return switch (record.kind) {
            .folder, .symlink, .workspace => if (record.local_path.len > 0) record.local_path else record.install_dir,
            else => record.install_dir,
        };
    }

    fn workspaceForLogicalPath(manager: *Manager, logical_path: []const u8) !?Workspace {
        var workspaces = manager.workspaces.iterator();
        while (workspaces.next()) |entry| {
            const workspace = entry.value_ptr.*;
            if (std.mem.eql(u8, try manager.relativeLockPath(workspace.path), logical_path)) return workspace;
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
            try manager.maybeWarnPeerConflict(range_value.string, provider);
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
        if (package_json.* != .object) return;
        const peers = package_json.object.get("peerDependencies") orelse return;
        if (peers != .object) return;
        const aliases = try manager.allocator.dupe([]const u8, peers.object.keys());
        std.mem.sort([]const u8, aliases, {}, lessString);
        for (aliases) |alias| {
            const range_value = peers.object.get(alias) orelse continue;
            if (range_value != .string or
                peerDependencyIsOptional(package_json, alias) or
                packageHasRuntimeDependency(package_json, alias)) continue;
            if (try manager.findPeerProvider(alias, range_value.string, peer_parent_dir)) |provider| {
                try manager.maybeWarnPeerConflict(range_value.string, provider);
                continue;
            }
            _ = manager.installDependency(alias, range_value.string, dependency_parent_dir, false, false, true) catch |err| {
                if (err == error.OutOfMemory) return err;
                continue;
            };
        }
    }

    fn reconcileIsolatedPeerGraph(manager: *Manager) !void {
        if (manager.node_linker != .isolated or manager.records.items.len == 0) return;

        var record_indices = std.StringHashMap(usize).init(manager.allocator);
        defer record_indices.deinit();
        for (manager.records.items, 0..) |record, index| {
            try record_indices.put(try manager.allocator.dupe(u8, recordLogicalKey(record)), index);
        }

        const count = manager.records.items.len;
        const own_peers = try manager.allocator.alloc(std.array_list.Managed([]const u8), count);
        const provides = try manager.allocator.alloc(std.array_list.Managed([]const u8), count);
        const children = try manager.allocator.alloc(std.array_list.Managed(usize), count);
        for (own_peers, provides, children) |*own, *provided, *child| {
            own.* = std.array_list.Managed([]const u8).init(manager.allocator);
            provided.* = std.array_list.Managed([]const u8).init(manager.allocator);
            child.* = std.array_list.Managed(usize).init(manager.allocator);
        }
        defer {
            for (own_peers, provides, children) |*own, *provided, *child| {
                own.deinit();
                provided.deinit();
                child.deinit();
            }
        }

        for (manager.records.items, 0..) |record, index| {
            const metadata = record.metadata orelse continue;
            try manager.appendPeerGraphSection(&record_indices, record, "dependencies", &provides[index], &children[index]);
            if (!manager.options.omit_optional) {
                try manager.appendPeerGraphSection(&record_indices, record, "optionalDependencies", &provides[index], &children[index]);
            }
            if (record.kind == .workspace and !manager.options.production and !manager.options.omit_dev) {
                try manager.appendPeerGraphSection(&record_indices, record, "devDependencies", &provides[index], &children[index]);
            }

            if (metadata.* != .object or manager.options.omit_peer) continue;
            const peers = metadata.object.get("peerDependencies") orelse continue;
            if (peers != .object) continue;
            for (peers.object.keys(), peers.object.values()) |alias, range_value| {
                if (range_value != .string or packageHasRuntimeDependency(metadata, alias)) continue;
                try appendUniqueName(&own_peers[index], alias);
                if (manager.providerRecordIndex(&record_indices, logicalParentKey(record), alias, range_value.string)) |provider_index| {
                    try appendUniqueIndex(&children[index], provider_index);
                }
            }
        }

        const nodes = try manager.allocator.alloc(Isolated.PeerLeakNode, count);
        for (nodes, own_peers, provides, children) |*node, own, provided, child| {
            node.* = .{
                .own_peers = own.items,
                .provides = provided.items,
                .children = child.items,
            };
        }
        const leaks = try Isolated.computePeerLeaks(manager.allocator, nodes);
        const reconciled = try manager.allocator.alloc(ReconciledRecord, count);

        for (manager.records.items, leaks, reconciled) |record, leak_set, *result| {
            var resolutions = std.array_list.Managed(Isolated.PeerResolution).init(manager.allocator);
            defer resolutions.deinit();
            for (leak_set.names) |name| {
                const range = if (record.metadata) |metadata| peerDependencySpec(metadata, name) else null;
                const provider_index = manager.providerRecordIndex(&record_indices, recordLogicalKey(record), name, range) orelse continue;
                const provider = manager.records.items[provider_index];
                try resolutions.append(.{
                    .name = provider.name,
                    .resolution = try manager.peerResolutionForRecord(provider),
                });
            }
            const context = try Isolated.PeerContext.init(manager.allocator, resolutions.items);

            if (record.kind == .workspace) {
                const package_dir = if (record.local_path.len > 0) record.local_path else record.install_dir;
                result.* = .{
                    .context = .{},
                    .placement = null,
                    .old_package_dir = package_dir,
                    .package_dir = package_dir,
                    .modules_dir = try std.fs.path.join(manager.allocator, &.{ package_dir, "node_modules" }),
                };
                continue;
            }

            const source = if (record.tarball.len > 0) record.tarball else record.resolution;
            const placement = try manager.packagePlacementWithPeerContext(
                record.name,
                record.version,
                record.kind,
                source,
                context,
            );
            result.* = .{
                .context = context,
                .placement = placement,
                .old_package_dir = record.install_dir,
                .package_dir = placement.package_dir,
                .modules_dir = placement.modules_dir,
            };
        }

        if (!manager.options.lockfile_only and !manager.options.dry_run) {
            var materialized = std.StringHashMap(void).init(manager.allocator);
            defer materialized.deinit();
            for (manager.records.items, reconciled) |record, result| {
                if (manager.recordResolutionOnly(record)) continue;
                const placement = result.placement orelse continue;
                if (std.mem.eql(u8, result.old_package_dir, result.package_dir) and manager.pathExists(result.package_dir)) {
                    try materialized.put(placement.store_key, {});
                }
            }
            for (manager.records.items, reconciled) |record, result| {
                if (manager.recordResolutionOnly(record)) continue;
                const placement = result.placement orelse continue;
                if (materialized.contains(placement.store_key)) continue;
                if (!manager.options.force and manager.pathExists(result.package_dir)) {
                    try materialized.put(placement.store_key, {});
                    continue;
                }
                if (result.old_package_dir.len == 0 or !manager.pathExists(result.old_package_dir)) {
                    return error.PackageStoreSourceMissing;
                }
                const store_entry = std.fs.path.dirname(placement.modules_dir) orelse return error.InvalidPackageDestination;
                deletePath(manager.init_data.io, store_entry);
                try clonePackagePath(manager.init_data.io, manager.allocator, result.old_package_dir, result.package_dir);
                try materialized.put(placement.store_key, {});
            }
            try manager.retargetIsolatedScriptTasks(reconciled);
        }

        manager.isolated_live_store_keys.clearRetainingCapacity();
        manager.isolated_live_links.clearRetainingCapacity();
        manager.isolated_hidden_hoists.clearRetainingCapacity();
        manager.isolated_public_hoists.clearRetainingCapacity();
        manager.isolated_parent_modules.clearRetainingCapacity();
        manager.isolated_parent_keys.clearRetainingCapacity();

        for (manager.records.items, reconciled) |*record, result| {
            record.peer_hash = result.context.hash;
            record.install_dir = result.package_dir;
            if (manager.recordResolutionOnly(record.*)) continue;
            if (result.placement) |placement| {
                try manager.trackIsolatedPlacement(placement);
                if (record.kind == .root or record.kind == .symlink) {
                    try manager.isolated_live_links.put(try manager.allocator.dupe(u8, result.package_dir), {});
                }
            }
            try manager.isolated_managed_modules.put(try manager.allocator.dupe(u8, result.modules_dir), {});
            try manager.isolated_parent_modules.put(
                try manager.allocator.dupe(u8, result.package_dir),
                try manager.allocator.dupe(u8, result.modules_dir),
            );
            try manager.isolated_parent_keys.put(
                try manager.allocator.dupe(u8, result.package_dir),
                try manager.allocator.dupe(u8, recordLogicalKey(record.*)),
            );
            try manager.rememberPackageMetadata(result.package_dir, record.metadata);
        }

        if (manager.options.lockfile_only or manager.options.dry_run) return;

        for (manager.records.items, reconciled) |record, result| {
            if (manager.recordResolutionOnly(record)) continue;
            const parent_key = logicalParentKey(record);
            if (record.kind == .workspace and
                parent_key.len == 0 and
                manager.rootDependencySpec(record.alias) == null)
            {
                continue;
            }
            var consumer_modules = try manager.modulesForLogicalImporter(&record_indices, reconciled, parent_key);
            const direct_root_dependency = parent_key.len == 0 and manager.rootDependencySpec(record.alias) != null;
            if (parent_key.len == 0 and !direct_root_dependency) {
                consumer_modules = try std.fs.path.join(manager.allocator, &.{
                    manager.root_dir,
                    "node_modules",
                    ".bun",
                    "node_modules",
                });
            }
            if (record_indices.get(parent_key)) |parent_index| {
                const parent_record = manager.records.items[parent_index];
                if (std.mem.eql(u8, record.alias, parent_record.name)) {
                    consumer_modules = try std.fs.path.join(manager.allocator, &.{ reconciled[parent_index].package_dir, "node_modules" });
                }
            }
            try manager.ensureIsolatedLinksInModules(
                record.alias,
                consumer_modules,
                direct_root_dependency,
                result.package_dir,
            );
            if (record.metadata) |metadata| {
                const public_package_dir = try std.fs.path.join(manager.allocator, &.{ consumer_modules, record.alias });
                try manager.linkBinsInDirectory(
                    record.alias,
                    public_package_dir,
                    metadata,
                    false,
                    try std.fs.path.join(manager.allocator, &.{ consumer_modules, ".bin" }),
                );
            }
        }

        if (manager.options.omit_peer) return;
        for (manager.records.items, reconciled) |record, result| {
            const metadata = record.metadata orelse continue;
            if (metadata.* != .object) continue;
            const peers = metadata.object.get("peerDependencies") orelse continue;
            if (peers != .object) continue;
            const parent_key = logicalParentKey(record);
            for (peers.object.keys(), peers.object.values()) |alias, range_value| {
                if (range_value != .string or packageHasRuntimeDependency(metadata, alias)) continue;
                const provider_index = manager.providerRecordIndex(&record_indices, parent_key, alias, range_value.string) orelse continue;
                const provider_record = manager.records.items[provider_index];
                const provider = try manager.peerProviderFromRecord(provider_record);
                try manager.maybeWarnPeerConflict(range_value.string, provider);
                const destination = try std.fs.path.join(manager.allocator, &.{ result.modules_dir, alias });
                if (!std.mem.eql(u8, destination, provider.destination)) {
                    try manager.linkRelativeDirectory(destination, provider.destination, true);
                }
            }
        }
        if (manager.root_package_json) |root| {
            try manager.linkPeerDependencies(root, manager.root_dir, manager.root_dir);
        }
    }

    fn appendPeerGraphSection(
        manager: *Manager,
        record_indices: *const std.StringHashMap(usize),
        record: PackageRecord,
        section_name: []const u8,
        provides: *std.array_list.Managed([]const u8),
        children: *std.array_list.Managed(usize),
    ) !void {
        const metadata = record.metadata orelse return;
        if (metadata.* != .object) return;
        const section = metadata.object.get(section_name) orelse return;
        if (section != .object) return;
        for (section.object.keys(), section.object.values()) |alias, spec| {
            if (spec != .string) continue;
            const child_key = try logicalDependencyKey(manager.allocator, recordLogicalKey(record), alias);
            const child_index = record_indices.get(child_key) orelse continue;
            try appendUniqueName(provides, alias);
            try appendUniqueIndex(children, child_index);
        }
    }

    fn providerRecordIndex(
        manager: *Manager,
        record_indices: *const std.StringHashMap(usize),
        initial_importer_key: []const u8,
        alias: []const u8,
        range: ?[]const u8,
    ) ?usize {
        var importer_key = initial_importer_key;
        while (true) {
            const edge_key = logicalDependencyKey(manager.allocator, importer_key, alias) catch break;
            if (record_indices.get(edge_key)) |index| return index;
            if (importer_key.len == 0) break;
            if (record_indices.get(importer_key)) |importer_index| {
                importer_key = logicalParentKey(manager.records.items[importer_index]);
            } else {
                importer_key = "";
            }
        }

        for (manager.records.items, 0..) |record, index| {
            if (!std.mem.eql(u8, record.alias, alias)) continue;
            if (range) |wanted| if (!manager.peerProviderSatisfies(record, wanted)) continue;
            return index;
        }
        for (manager.records.items, 0..) |record, index| {
            if (std.mem.eql(u8, record.alias, alias)) return index;
        }
        return null;
    }

    fn modulesForLogicalImporter(
        manager: *Manager,
        record_indices: *const std.StringHashMap(usize),
        reconciled: []const ReconciledRecord,
        importer_key: []const u8,
    ) ![]const u8 {
        if (importer_key.len == 0) {
            return std.fs.path.join(manager.allocator, &.{ manager.root_dir, "node_modules" });
        }
        if (record_indices.get(importer_key)) |index| return reconciled[index].modules_dir;
        if (try manager.workspaceForLogicalPath(importer_key)) |workspace| {
            return std.fs.path.join(manager.allocator, &.{ workspace.path, "node_modules" });
        }
        return std.fs.path.join(manager.allocator, &.{ manager.root_dir, "node_modules" });
    }

    fn retargetIsolatedScriptTasks(manager: *Manager, reconciled: []const ReconciledRecord) !void {
        if (manager.script_queue.tasks.items.len == 0) return;
        const original = try manager.allocator.dupe(Scripts.Task, manager.script_queue.tasks.items);
        manager.script_queue.tasks.clearRetainingCapacity();
        for (original) |task| {
            var matched = false;
            for (reconciled) |result| {
                if (!std.mem.eql(u8, task.cwd, result.old_package_dir)) continue;
                matched = true;
                try manager.script_queue.add(.{
                    .name = task.name,
                    .version = task.version,
                    .cwd = result.package_dir,
                    .kind = task.kind,
                    .optional = task.optional,
                });
            }
            if (!matched) try manager.script_queue.add(task);
        }
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
        try manager.isolated_parent_modules.put(
            try manager.allocator.dupe(u8, placement.package_dir),
            try manager.allocator.dupe(u8, placement.modules_dir),
        );
        try manager.isolated_parent_keys.put(
            try manager.allocator.dupe(u8, placement.package_dir),
            try manager.allocator.dupe(u8, logical_key),
        );
    }

    fn pushIsolatedSourceContext(manager: *Manager, source_dir: []const u8, package_dir: []const u8) !IsolatedSourceContext {
        const context = IsolatedSourceContext{
            .source_dir = source_dir,
            .previous_modules = manager.isolated_parent_modules.get(source_dir),
            .previous_key = manager.isolated_parent_keys.get(source_dir),
            .active = manager.node_linker == .isolated and !std.mem.eql(u8, source_dir, package_dir),
        };
        if (!context.active) return context;

        if (manager.isolated_parent_modules.get(package_dir)) |modules| {
            try manager.isolated_parent_modules.put(
                try manager.allocator.dupe(u8, source_dir),
                try manager.allocator.dupe(u8, modules),
            );
        }
        if (manager.isolated_parent_keys.get(package_dir)) |parent_key| {
            try manager.isolated_parent_keys.put(
                try manager.allocator.dupe(u8, source_dir),
                try manager.allocator.dupe(u8, parent_key),
            );
        }
        return context;
    }

    fn popIsolatedSourceContext(manager: *Manager, context: IsolatedSourceContext) !void {
        if (!context.active) return;
        if (context.previous_modules) |modules| {
            try manager.isolated_parent_modules.put(context.source_dir, modules);
        } else {
            _ = manager.isolated_parent_modules.remove(context.source_dir);
        }
        if (context.previous_key) |key| {
            try manager.isolated_parent_keys.put(context.source_dir, key);
        } else {
            _ = manager.isolated_parent_keys.remove(context.source_dir);
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
        var consumer_modules = try manager.isolatedConsumerModules(parent_dir);
        const parent_metadata = manager.isolated_package_metadata.get(parent_dir) orelse
            (manager.readInstalledPackageJSON(parent_dir) catch null);
        if (parent_metadata) |metadata| {
            if (jsonString(metadata, "name")) |parent_name| if (std.mem.eql(u8, alias, parent_name)) {
                consumer_modules = try std.fs.path.join(manager.allocator, &.{ parent_dir, "node_modules" });
            };
        }
        return manager.ensureIsolatedLinksInModules(
            alias,
            consumer_modules,
            std.mem.eql(u8, parent_dir, manager.root_dir),
            package_dir,
        );
    }

    fn ensureIsolatedLinksInModules(
        manager: *Manager,
        alias: []const u8,
        consumer_modules: []const u8,
        parent_is_root: bool,
        package_dir: []const u8,
    ) !void {
        if (manager.options.lockfile_only or manager.options.dry_run) return;
        try manager.isolated_managed_modules.put(try manager.allocator.dupe(u8, consumer_modules), {});
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
        if (parent_is_root) {
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
            } else if (try manager.sharedWorkspaceDependencyShouldHoist(alias, package_dir)) {
                const root_modules = try manager.isolatedConsumerModules(manager.root_dir);
                const public_link = try std.fs.path.join(manager.allocator, &.{ root_modules, alias });
                try manager.linkRelativeDirectory(public_link, package_dir, true);
            } else {
                _ = manager.isolated_public_hoists.remove(alias);
            }
        }
    }

    fn sharedWorkspaceDependencyShouldHoist(
        manager: *Manager,
        alias: []const u8,
        package_dir: []const u8,
    ) !bool {
        if (manager.rootDependencySpec(alias) != null) return false;
        const metadata = manager.readInstalledPackageJSON(package_dir) catch return false;
        const package_name = jsonString(metadata, "name") orelse alias;
        const package_version = jsonString(metadata, "version") orelse return false;

        var matches: usize = 0;
        var iterator = manager.workspaces.iterator();
        while (iterator.next()) |entry| {
            const spec = ownedDependencySpec(entry.value_ptr.package_json, alias) orelse continue;
            if (isGitSpec(spec) or isTarballSpec(spec) or isLocalSpec(spec) or
                std.mem.startsWith(u8, spec, "workspace:")) continue;
            const requested_name, const requested_range = parseNpmAlias(alias, spec);
            if (!std.mem.eql(u8, requested_name, package_name) or
                !semverSatisfies(manager.allocator, requested_range, package_version)) continue;
            matches += 1;
            if (matches >= 2) return true;
        }
        return false;
    }

    fn linkRelativeDirectory(manager: *Manager, destination: []const u8, target: []const u8, replace: bool) !void {
        if (manager.node_linker == .isolated) {
            try manager.isolated_live_links.put(try manager.allocator.dupe(u8, destination), {});
            if (manager.init_data.environ_map.get("COTTONTAIL_PM_ERROR_TRACE") != null) {
                try manager.stderr.print("isolated link: {s} -> {s}\n", .{ destination, target });
            }
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
        var archive_integrity: []const u8 = if (locked_selection) |selection|
            if (manager.lock_graph.?.provenance == .bun_text) selection.package.integrity else ""
        else
            "";
        var git_resolved_name: []const u8 = if (locked_selection) |selection| selection.package.git_resolved else "";

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
                manager.started_ns,
            });
            const checkout_result: GitCheckoutResult = if (spec.kind == .github)
                try manager.checkoutGithubArchive(
                    spec,
                    checkout_path,
                    if (archive_integrity.len > 0) archive_integrity else null,
                )
            else
                .{
                    .checkout = Git.checkout(
                        manager.allocator,
                        manager.init_data.io,
                        manager.init_data.environ_map,
                        spec,
                        checkout_path,
                    ) catch |err| {
                        try manager.stderr.print("error: git dependency {s} failed to resolve\n", .{requested});
                        return err;
                    },
                };
            const checkout = checkout_result.checkout;
            if (checkout_result.integrity.len > 0) {
                if (archive_integrity.len == 0) manager.changed = true;
                archive_integrity = checkout_result.integrity;
            }
            if (checkout_result.resolved_name.len > 0) {
                git_resolved_name = checkout_result.resolved_name;
            } else if (git_resolved_name.len == 0) {
                git_resolved_name = try manager.allocator.dupe(u8, checkout.commit);
            }
            defer deletePath(manager.init_data.io, checkout.path);

            metadata = manager.readInstalledPackageJSON(checkout.path) catch |err| blk: {
                if (err != error.MissingPackageJSON) return err;
                const empty = try manager.allocator.create(Value);
                empty.* = .{ .object = .empty };
                break :blk empty;
            };
            package_name = blk: {
                if (jsonString(metadata, "name")) |name| {
                    if (name.len > 0) break :blk name;
                }
                break :blk alias_hint orelse gitRepositoryName(spec) orelse return error.InvalidPackageName;
            };
            package_version = jsonString(metadata, "version") orelse "0.0.0";
            const alias = alias_hint orelse package_name;
            commit = checkout.commit;
            resolved_source = try spec.resolvedSource(manager.allocator, commit);
            var install_source_path = checkout.path;
            if (!manager.options.lockfile_only and !manager.options.dry_run) {
                const project_cache_dir = try std.fs.path.join(manager.allocator, &.{ manager.root_dir, "node_modules", ".cache" });
                try std.Io.Dir.cwd().createDirPath(manager.init_data.io, project_cache_dir);
                const cache_name = try gitCacheFolderName(manager.allocator, spec, requested, commit);
                const bun_tag_path = try std.fs.path.join(manager.allocator, &.{ checkout.path, ".bun-tag" });
                try std.Io.Dir.cwd().writeFile(manager.init_data.io, .{ .sub_path = bun_tag_path, .data = commit });
                if (spec.kind == .github) {
                    const project_cache_path = try std.fs.path.join(manager.allocator, &.{ project_cache_dir, cache_name });
                    deletePath(manager.init_data.io, project_cache_path);
                    try copyDirectoryTree(manager.init_data.io, manager.allocator, checkout.path, project_cache_path);
                    if (!std.mem.eql(u8, alias, package_name)) {
                        const alias_cache_dir = try std.fs.path.join(manager.allocator, &.{ project_cache_dir, alias });
                        try std.Io.Dir.cwd().createDirPath(manager.init_data.io, alias_cache_dir);
                        const alias_cache_link = try std.fs.path.join(manager.allocator, &.{ alias_cache_dir, gitCacheAliasName(cache_name) });
                        try manager.linkDirectoryAt(alias_cache_link, project_cache_path);
                    }
                    install_source_path = project_cache_path;
                } else {
                    const clone_cache_path = try std.fs.path.join(manager.allocator, &.{ project_cache_dir, cache_name });
                    const metadata_path = try std.fs.path.join(manager.allocator, &.{ checkout.path, ".git" });
                    deletePath(manager.init_data.io, clone_cache_path);
                    try copyDirectoryTree(manager.init_data.io, manager.allocator, metadata_path, clone_cache_path);
                    deletePath(manager.init_data.io, metadata_path);

                    const checkout_cache_name = try std.fmt.allocPrint(manager.allocator, "@G@{s}", .{commit});
                    const checkout_cache_path = try std.fs.path.join(manager.allocator, &.{ project_cache_dir, checkout_cache_name });
                    deletePath(manager.init_data.io, checkout_cache_path);
                    try copyDirectoryTree(manager.init_data.io, manager.allocator, checkout.path, checkout_cache_path);
                    install_source_path = checkout_cache_path;
                }
            }
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

            if (!manager.options.force and !manager.options.lockfile_only and !manager.options.dry_run) {
                const existing_tag_path = try std.fs.path.join(manager.allocator, &.{ final_destination, ".bun-tag" });
                const existing_tag = std.Io.Dir.cwd().readFileAlloc(
                    manager.init_data.io,
                    existing_tag_path,
                    manager.allocator,
                    .limited(128),
                ) catch null;
                if (existing_tag) |tag| {
                    const patch_paths = try manager.packagePatchPaths(package_name, package_version, protocol_patch_paths);
                    installed = std.mem.eql(u8, std.mem.trim(u8, tag, " \t\r\n"), commit) and
                        try manager.packagePatchStateMatches(final_destination, patch_paths);
                }
            }

            if (!installed) {
                if (!manager.options.lockfile_only and !manager.options.dry_run) {
                    deletePath(manager.init_data.io, final_destination);
                    try copyDirectoryTree(manager.init_data.io, manager.allocator, install_source_path, final_destination);
                    try manager.applyPackagePatch(package_name, package_version, final_destination, protocol_patch_paths);
                }
                if (!manager.options.lockfile_only and !manager.options.dry_run) manager.installed_count += 1;
            }
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
            .key = if (manager.node_linker == .isolated)
                try manager.dependencyLockKey(parent_dir, alias)
            else if (locked_selection) |selection|
                selection.package.key
            else
                try manager.lockKeyForDestination(final_destination),
            .alias = alias,
            .name = package_name,
            .version = package_version,
            .integrity = archive_integrity,
            .git_resolved = git_resolved_name,
            .resolution = resolved_source,
            .kind = if (spec.kind == .github) .github else .git,
            .metadata = metadata,
            .peer_hash = peer_context.hash,
            .install_dir = final_destination,
        });
        try manager.rememberPackageMetadata(final_destination, metadata);
        if (locked_selection == null) manager.changed = true;

        try manager.installDependencyObject(metadata, "dependencies", final_destination, false, false);
        try manager.installOptionalDependencies(metadata, final_destination, false);
        if (manager.node_linker == .isolated) {
            try manager.linkPeerDependencies(metadata, final_destination, parent_dir);
        }
        try manager.queuePackageScripts(alias, package_name, package_version, final_destination, .git, direct, optional, !installed);
        return .{
            .alias = alias,
            .name = package_name,
            .version = package_version,
            .source = resolved_source,
            .package_json = metadata,
        };
    }

    fn checkoutGithubArchive(
        manager: *Manager,
        spec: Git.Spec,
        destination: []const u8,
        expected_integrity: ?[]const u8,
    ) !GitCheckoutResult {
        const repository = Git.githubRepositoryPath(spec) orelse return error.InvalidGitDependency;
        var reference = spec.committish;
        if (reference.len == 0) {
            const api_base = std.mem.trimEnd(u8, manager.init_data.environ_map.get("GITHUB_API_URL") orelse "https://api.github.com", "/");
            const metadata_url = try std.fmt.allocPrint(manager.allocator, "{s}/repos/{s}", .{ api_base, repository });
            const metadata_bytes = try manager.fetchBytes(metadata_url, true, 4 * 1024 * 1024);
            const metadata = std.json.parseFromSliceLeaky(Value, manager.allocator, metadata_bytes, .{}) catch
                return error.InvalidGitMetadata;
            reference = jsonString(&metadata, "default_branch") orelse "HEAD";
        }
        const repository_slug = try manager.allocator.dupe(u8, repository);
        std.mem.replaceScalar(u8, repository_slug, '/', '-');
        const requested_name = try std.fmt.allocPrint(manager.allocator, "{s}-{s}", .{
            repository_slug,
            reference[0..@min(reference.len, 7)],
        });
        const cache_dir = try packageCachePath(manager.init_data, manager.allocator);
        try std.Io.Dir.cwd().createDirPath(manager.init_data.io, cache_dir);
        const archive_path = try std.fs.path.join(manager.allocator, &.{ cache_dir, try std.fmt.allocPrint(manager.allocator, "{s}.tgz", .{requested_name}) });
        var archive = try readOptionalFile(manager.init_data.io, manager.allocator, archive_path, max_tarball_bytes);
        var archive_identity = if (archive) |bytes| try githubArchiveIdentity(manager.allocator, bytes) else null;
        if (archive == null or archive_identity == null) {
            const api_base = std.mem.trimEnd(u8, manager.init_data.environ_map.get("GITHUB_API_URL") orelse "https://api.github.com", "/");
            const archive_url = try std.fmt.allocPrint(manager.allocator, "{s}/repos/{s}/tarball/{s}", .{ api_base, repository, reference });
            const downloaded = try manager.fetchBytes(archive_url, false, max_tarball_bytes);
            try std.Io.Dir.cwd().writeFile(manager.init_data.io, .{ .sub_path = archive_path, .data = downloaded });
            archive = downloaded;
            archive_identity = try githubArchiveIdentity(manager.allocator, downloaded);
        }
        const archive_bytes = archive.?;
        if (manager.options.verify_integrity) try verifyIntegrity(archive_bytes, expected_integrity);
        const integrity = try sha512Integrity(manager.allocator, archive_bytes);
        const resolved_name = if (archive_identity) |identity| identity.root_name else requested_name;
        const commit = if (archive_identity) |identity| identity.commit else reference;

        deletePath(manager.init_data.io, destination);
        try std.Io.Dir.cwd().createDirPath(manager.init_data.io, destination);
        var destination_dir = try std.Io.Dir.cwd().openDir(manager.init_data.io, destination, .{});
        defer destination_dir.close(manager.init_data.io);
        try extractTarballArchive(manager.init_data.io, manager.allocator, destination_dir, archive_bytes);
        return .{
            .checkout = .{
                .path = destination,
                .commit = try manager.allocator.dupe(u8, commit),
            },
            .integrity = integrity,
            .resolved_name = resolved_name,
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
        package_json.* = try PackageJSON.parsePackageJSON(manager.allocator, package_json_path, source);
        if (package_json.* != .object) return error.InvalidPackageJSON;
        return package_json;
    }

    fn appendInstalledIsolatedDependency(
        manager: *Manager,
        dependencies: *std.array_list.Managed(InstalledIsolatedDependency),
        package_dir: []const u8,
        alias: []const u8,
        dependency_path: []const u8,
        kind_hint: std.Io.File.Kind,
    ) !void {
        if (!manager.isManagedDirectoryLink(dependency_path, kind_hint)) return;
        const resolved_path = std.Io.Dir.cwd().realPathFileAlloc(
            manager.init_data.io,
            dependency_path,
            manager.allocator,
        ) catch return;
        if (std.mem.eql(u8, resolved_path, package_dir)) return;

        const identity = manager.readInstalledPackageJSON(resolved_path) catch return;
        const installed_name = jsonString(identity, "name") orelse alias;
        const version_value = jsonString(identity, "version") orelse return;
        try dependencies.append(.{
            .alias = try manager.allocator.dupe(u8, alias),
            .spec = if (std.mem.eql(u8, alias, installed_name))
                try manager.allocator.dupe(u8, version_value)
            else
                try std.fmt.allocPrint(manager.allocator, "npm:{s}@{s}", .{ installed_name, version_value }),
        });
    }

    fn metadataForInstalledIsolatedPackage(
        manager: *Manager,
        package_dir: []const u8,
        identity: *const Value,
    ) !*Value {
        const metadata = try manager.allocator.create(Value);
        metadata.* = .{ .object = .empty };
        for (identity.object.keys(), identity.object.values()) |field, value| {
            if (containsString(&all_dependency_sections, field)) continue;
            try metadata.object.put(
                manager.allocator,
                try manager.allocator.dupe(u8, field),
                value,
            );
        }

        const package_parent = std.fs.path.dirname(package_dir) orelse return metadata;
        const modules_dir = if (std.mem.startsWith(u8, std.fs.path.basename(package_parent), "@"))
            std.fs.path.dirname(package_parent) orelse return metadata
        else
            package_parent;
        var dependencies = std.array_list.Managed(InstalledIsolatedDependency).init(manager.allocator);
        defer dependencies.deinit();
        var directory = std.Io.Dir.cwd().openDir(
            manager.init_data.io,
            modules_dir,
            .{ .iterate = true },
        ) catch return metadata;
        defer directory.close(manager.init_data.io);

        var iterator = directory.iterate();
        while (try iterator.next(manager.init_data.io)) |entry| {
            if (entry.name.len == 0 or entry.name[0] == '.') continue;
            const entry_path = try std.fs.path.join(manager.allocator, &.{ modules_dir, entry.name });
            if (entry.name[0] != '@') {
                try manager.appendInstalledIsolatedDependency(
                    &dependencies,
                    package_dir,
                    entry.name,
                    entry_path,
                    entry.kind,
                );
                continue;
            }
            if (entry.kind != .directory) continue;

            var scope = std.Io.Dir.cwd().openDir(
                manager.init_data.io,
                entry_path,
                .{ .iterate = true },
            ) catch continue;
            defer scope.close(manager.init_data.io);
            var scope_iterator = scope.iterate();
            while (try scope_iterator.next(manager.init_data.io)) |package_entry| {
                if (package_entry.name.len == 0 or package_entry.name[0] == '.') continue;
                const alias = try std.fmt.allocPrint(
                    manager.allocator,
                    "{s}/{s}",
                    .{ entry.name, package_entry.name },
                );
                const dependency_path = try std.fs.path.join(
                    manager.allocator,
                    &.{ entry_path, package_entry.name },
                );
                try manager.appendInstalledIsolatedDependency(
                    &dependencies,
                    package_dir,
                    alias,
                    dependency_path,
                    package_entry.kind,
                );
            }
        }

        std.sort.pdq(InstalledIsolatedDependency, dependencies.items, {}, struct {
            fn lessThan(_: void, left: InstalledIsolatedDependency, right: InstalledIsolatedDependency) bool {
                return std.mem.order(u8, left.alias, right.alias) == .lt;
            }
        }.lessThan);
        if (dependencies.items.len > 0) {
            var dependency_object: Value = .{ .object = .empty };
            for (dependencies.items) |dependency| {
                try dependency_object.object.put(
                    manager.allocator,
                    dependency.alias,
                    .{ .string = dependency.spec },
                );
            }
            try metadata.object.put(
                manager.allocator,
                try manager.allocator.dupe(u8, "dependencies"),
                dependency_object,
            );
        }
        return metadata;
    }

    fn metadataForInstalledPackage(
        manager: *Manager,
        package_dir: []const u8,
        fallback: ?*const Value,
    ) !?*const Value {
        const installed = manager.readInstalledPackageJSON(package_dir) catch return fallback;
        return installed;
    }

    fn registerBundledPackages(
        manager: *Manager,
        parent_key: []const u8,
        parent_metadata: *const Value,
        parent_dir: []const u8,
    ) !void {
        if (!packageHasBundledDependencies(parent_metadata)) return;
        const modules_dir = try std.fs.path.join(manager.allocator, &.{ parent_dir, "node_modules" });
        try manager.scanBundledModulesDirectory(parent_key, parent_metadata, modules_dir);
    }

    fn scanBundledModulesDirectory(
        manager: *Manager,
        parent_key: []const u8,
        owner_metadata: *const Value,
        modules_dir: []const u8,
    ) anyerror!void {
        var directory = std.Io.Dir.cwd().openDir(manager.init_data.io, modules_dir, .{ .iterate = true }) catch return;
        defer directory.close(manager.init_data.io);
        var iterator = directory.iterate();
        while (try iterator.next(manager.init_data.io)) |entry| {
            if (entry.kind != .directory or entry.name.len == 0 or entry.name[0] == '.') continue;
            if (entry.name[0] == '@') {
                const scope_dir_path = try std.fs.path.join(manager.allocator, &.{ modules_dir, entry.name });
                var scope_dir = std.Io.Dir.cwd().openDir(manager.init_data.io, scope_dir_path, .{ .iterate = true }) catch continue;
                defer scope_dir.close(manager.init_data.io);
                var scope_iterator = scope_dir.iterate();
                while (try scope_iterator.next(manager.init_data.io)) |package_entry| {
                    if (package_entry.kind != .directory or package_entry.name.len == 0 or package_entry.name[0] == '.') continue;
                    const alias = try std.fmt.allocPrint(manager.allocator, "{s}/{s}", .{ entry.name, package_entry.name });
                    const package_dir = try std.fs.path.join(manager.allocator, &.{ scope_dir_path, package_entry.name });
                    try manager.registerBundledPackage(parent_key, owner_metadata, alias, package_dir);
                }
                continue;
            }
            const package_dir = try std.fs.path.join(manager.allocator, &.{ modules_dir, entry.name });
            try manager.registerBundledPackage(parent_key, owner_metadata, entry.name, package_dir);
        }
    }

    fn registerBundledPackage(
        manager: *Manager,
        parent_key: []const u8,
        owner_metadata: *const Value,
        alias: []const u8,
        package_dir: []const u8,
    ) anyerror!void {
        const owned_alias = try manager.allocator.dupe(u8, alias);
        const metadata = manager.readInstalledPackageJSON(package_dir) catch return;
        const package_name = jsonString(metadata, "name") orelse owned_alias;
        const package_version = jsonString(metadata, "version") orelse "0.0.0";
        const lock_key = try std.fmt.allocPrint(manager.allocator, "{s}/{s}", .{ parent_key, owned_alias });
        const directly_bundled = packageDependencyIsBundled(owner_metadata, owned_alias);
        if (directly_bundled) {
            try metadata.object.put(manager.allocator, try manager.allocator.dupe(u8, "bundled"), .{ .bool = true });
        }

        var tarball: []const u8 = "";
        var integrity: []const u8 = "";
        if (manager.lock_graph) |*graph| {
            if (graph.get(lock_key)) |locked| {
                if (locked.kind == .npm) {
                    tarball = locked.source;
                    integrity = locked.integrity;
                }
            }
        }
        if (tarball.len == 0) {
            for (manager.records.items) |record| {
                if (record.kind != .npm or
                    !std.mem.eql(u8, record.name, package_name) or
                    !std.mem.eql(u8, record.version, package_version) or
                    record.tarball.len == 0) continue;
                tarball = record.tarball;
                integrity = record.integrity;
                break;
            }
        }
        if (tarball.len == 0) {
            const resolved = try manager.resolveRegistryPackage(package_name, package_version);
            tarball = resolved.tarball;
            integrity = resolved.integrity orelse "";
        }

        try manager.addRecord(.{
            .key = lock_key,
            .alias = owned_alias,
            .name = package_name,
            .version = package_version,
            .tarball = tarball,
            .integrity = integrity,
            .metadata = metadata,
            .install_dir = package_dir,
        });
        try manager.rememberPackageMetadata(package_dir, metadata);

        const nested_modules = try std.fs.path.join(manager.allocator, &.{ package_dir, "node_modules" });
        try manager.scanBundledModulesDirectory(lock_key, metadata, nested_modules);
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
        if (!manager.options.lockfile_only and !manager.options.dry_run) manager.installed_count += 1;
        manager.changed = true;

        try manager.installDependencyObject(metadata, "dependencies", destination, false, false);
        try manager.installOptionalDependencies(metadata, destination, false);
        try manager.installOrLinkPeerDependencies(metadata, destination, destination, parent_dir);
        try manager.queuePackageScripts(alias, package_name, package_version, destination, .local, direct, optional, true);
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
            package_json.* = try PackageJSON.parsePackageJSON(manager.allocator, entry.name, contents.written());
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
        if ((direct and std.mem.eql(u8, parent_dir, manager.root_dir)) or manager.root_versions.get(alias) == null) {
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
        if (!manager.options.omit_optional) {
            if (dependencySpecInSection(root, "optionalDependencies", alias)) |spec| return spec;
        }
        if (!manager.options.production and !manager.options.omit_dev) {
            if (dependencySpecInSection(root, "devDependencies", alias)) |spec| return spec;
        }
        if (dependencySpecInSection(root, "dependencies", alias)) |spec| return spec;
        if (!manager.options.omit_peer) {
            if (dependencySpecInSection(root, "peerDependencies", alias)) |spec| return spec;
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
        const registry_name, const registry_spec = parseNpmAlias(alias, spec);
        // Dist-tags are manifest pointers, not semver ranges. An already
        // installed version cannot satisfy one without resolving the current
        // manifest first.
        const tagged_version = Semver.Version.isTaggedVersionOnly(registry_spec);
        if (tagged_version and !(manager.node_linker == .isolated and manager.isSecurityResolution())) return null;
        if (manager.node_linker == .isolated) {
            for (manager.records.items) |record| {
                if (record.kind != .npm or
                    !std.mem.eql(u8, record.name, registry_name) or
                    (!tagged_version and !semverSatisfies(manager.allocator, registry_spec, record.version))) continue;
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
                if (record.metadata) |metadata| {
                    try manager.installDependencyObject(@constCast(metadata), "dependencies", placement.package_dir, false, false);
                    try manager.installOptionalDependencies(@constCast(metadata), placement.package_dir, false);
                }
                try manager.installOrLinkPeerDependencies(record.metadata, placement.package_dir, placement.package_dir, parent_dir);
                return record.version;
            }

            const consumer_modules = try manager.isolatedConsumerModules(parent_dir);
            const destination = try std.fs.path.join(manager.allocator, &.{ consumer_modules, alias });
            if (!manager.pathIsWorkspace(destination)) {
                const identity = manager.readInstalledPackageJSON(destination) catch return null;
                const installed_name = jsonString(identity, "name") orelse alias;
                const installed_version = jsonString(identity, "version") orelse return null;
                if (std.mem.eql(u8, installed_name, registry_name) and
                    (tagged_version or semverSatisfies(manager.allocator, registry_spec, installed_version)))
                {
                    const installed_path = std.Io.Dir.cwd().realPathFileAlloc(
                        manager.init_data.io,
                        destination,
                        manager.allocator,
                    ) catch destination;
                    const patch_paths = try manager.packagePatchPaths(installed_name, installed_version, protocol_patch_paths);
                    if (!try manager.packagePatchStateMatches(installed_path, patch_paths)) return null;
                    // Registry dependency metadata can differ from the
                    // package.json packed in a tarball. The isolated links
                    // are the authoritative record of the resolved graph.
                    const metadata = try manager.metadataForInstalledIsolatedPackage(
                        installed_path,
                        identity,
                    );

                    const logical_key = try manager.dependencyLockKey(parent_dir, alias);
                    const package_parent = std.fs.path.dirname(installed_path) orelse return null;
                    const modules_dir = if (std.mem.startsWith(u8, std.fs.path.basename(package_parent), "@"))
                        std.fs.path.dirname(package_parent) orelse return null
                    else
                        package_parent;
                    try manager.isolated_parent_modules.put(
                        try manager.allocator.dupe(u8, installed_path),
                        try manager.allocator.dupe(u8, modules_dir),
                    );
                    try manager.isolated_parent_keys.put(
                        try manager.allocator.dupe(u8, installed_path),
                        try manager.allocator.dupe(u8, logical_key),
                    );
                    try manager.ensureIsolatedLinks(alias, parent_dir, installed_path);
                    if (!manager.options.lockfile_only and !manager.options.dry_run) {
                        try manager.linkBins(alias, installed_path, identity, direct, parent_dir);
                    }
                    try manager.root_versions.put(try manager.allocator.dupe(u8, alias), installed_version);
                    try manager.addRecord(.{
                        .key = logical_key,
                        .alias = alias,
                        .name = installed_name,
                        .version = installed_version,
                        .resolution = registry_spec,
                        .metadata = metadata,
                        .install_dir = installed_path,
                    });
                    try manager.rememberPackageMetadata(installed_path, metadata);
                    try manager.registerBundledPackages(logical_key, identity, installed_path);
                    try manager.installDependencyObject(metadata, "dependencies", installed_path, false, false);
                    try manager.installOrLinkPeerDependencies(metadata, installed_path, installed_path, parent_dir);
                    return installed_version;
                }
            }
            return null;
        }
        const candidates = [_][]const u8{ parent_dir, manager.root_dir };
        for (candidates) |base| {
            const destination = try packageDestination(manager.allocator, base, alias);
            const destination_key = try manager.lockKeyForDestination(destination);
            for (manager.records.items) |record| {
                if (record.kind != .npm or
                    !std.mem.eql(u8, record.alias, alias) or
                    !std.mem.eql(u8, recordLogicalKey(record), destination_key) or
                    !semverSatisfies(manager.allocator, registry_spec, record.version)) continue;
                const explicitly_aliased = std.mem.startsWith(u8, spec, "npm:");
                // COTTONTAIL-COMPAT: Bun remembers explicit npm aliases. A
                // later plain range for that alias reuses its real package.
                if (!std.mem.eql(u8, record.name, registry_name) and
                    (explicitly_aliased or std.mem.eql(u8, record.name, record.alias))) continue;
                if (!manager.options.lockfile_only and !manager.options.dry_run) {
                    const patch_paths = try manager.packagePatchPaths(record.name, record.version, protocol_patch_paths);
                    if (!try manager.packagePatchStateMatches(destination, patch_paths)) continue;
                }
                return record.version;
            }
            if (manager.pathIsWorkspace(destination)) continue;
            const package_json = try std.fs.path.join(manager.allocator, &.{ destination, "package.json" });
            const source = std.Io.Dir.cwd().readFileAlloc(
                manager.init_data.io,
                package_json,
                manager.allocator,
                .limited(4 * 1024 * 1024),
            ) catch continue;
            const value = try manager.allocator.create(Value);
            value.* = PackageJSON.parsePackageJSON(manager.allocator, package_json, source) catch continue;
            if (value.* != .object) continue;
            const version_value = value.object.get("version") orelse continue;
            if (version_value != .string) continue;
            if (semverSatisfies(manager.allocator, registry_spec, version_value.string)) {
                const package_name = jsonString(value, "name") orelse alias;
                const patch_paths = try manager.packagePatchPaths(package_name, version_value.string, protocol_patch_paths);
                if (!try manager.packagePatchStateMatches(destination, patch_paths)) continue;
                try manager.root_versions.put(try manager.allocator.dupe(u8, alias), version_value.string);
                if (!manager.options.lockfile_only and !manager.options.dry_run) {
                    try manager.linkBins(alias, destination, value, direct, parent_dir);
                }
                try manager.addRecord(.{
                    .key = destination_key,
                    .alias = alias,
                    .name = package_name,
                    .version = version_value.string,
                    .resolution = registry_spec,
                    .metadata = value,
                    .install_dir = destination,
                });
                try manager.rememberPackageMetadata(destination, value);
                try manager.registerBundledPackages(destination_key, value, destination);
                if (manager.shouldTraverseInstalledSecurityDependencies()) {
                    try manager.installDependencyObject(value, "dependencies", destination, false, false);
                    if (!manager.options.omit_optional) {
                        try manager.installDependencyObject(value, "optionalDependencies", destination, false, true);
                    }
                    try manager.installOrLinkPeerDependencies(value, destination, destination, parent_dir);
                }
                return version_value.string;
            }
        }
        return null;
    }

    fn registryManifestCachePath(manager: *Manager, registry_url: []const u8, encoded_name: []const u8) !?[]const u8 {
        const cache_dir = manager.cache_directory orelse return null;
        try std.Io.Dir.cwd().createDirPath(manager.init_data.io, cache_dir);
        const registry_hash = std.hash.Wyhash.hash(0, registry_url);
        const filename = try std.fmt.allocPrint(manager.allocator, "{x}-{s}.npm", .{ registry_hash, encoded_name });
        return try std.fs.path.join(manager.allocator, &.{ cache_dir, filename });
    }

    fn registryArchiveCachePath(manager: *Manager, name: []const u8, version_value: []const u8, tarball_url: []const u8) !?[]const u8 {
        const cache_dir = manager.cache_directory orelse return null;
        const package_cache = try std.fs.path.join(manager.allocator, &.{ cache_dir, name });
        try std.Io.Dir.cwd().createDirPath(manager.init_data.io, package_cache);
        const source_hash = std.hash.Wyhash.hash(0, tarball_url);
        const filename = try std.fmt.allocPrint(manager.allocator, "{s}-{x}.tgz", .{ version_value, source_hash });
        return try std.fs.path.join(manager.allocator, &.{ package_cache, filename });
    }

    fn parseRegistryManifest(manager: *Manager, bytes: []const u8) !?*Value {
        const parsed = try manager.allocator.create(Value);
        parsed.* = std.json.parseFromSliceLeaky(Value, manager.allocator, bytes, .{}) catch return null;
        if (parsed.* != .object) return null;
        const versions = parsed.object.get("versions") orelse return null;
        if (versions != .object) return null;
        return parsed;
    }

    fn needsExtendedRegistryManifest(manager: *const Manager) bool {
        return manager.options.minimum_release_age_ms != null;
    }

    fn registryManifestAccept(manager: *const Manager) []const u8 {
        return if (manager.needsExtendedRegistryManifest()) extended_manifest_accept else manifest_accept;
    }

    fn cachedRegistryManifestIsUsable(manager: *const Manager, manifest: *const Value) bool {
        if (!manager.needsExtendedRegistryManifest()) return true;
        if (manifest.* != .object) return false;
        const time = manifest.object.get("time") orelse return false;
        return time == .object;
    }

    fn registryConfigForPackage(manager: *Manager, name: []const u8) RegistryConfig {
        if (name.len > 1 and name[0] == '@') {
            if (std.mem.indexOfScalar(u8, name, '/')) |slash| {
                if (manager.registry_scopes.get(name[1..slash])) |configured| return configured;
            }
        }
        return .{
            .url = manager.registry,
            .source_url = manager.registry_source,
            .authorization = manager.registry_authorization,
        };
    }

    fn resolveRegistryPackage(manager: *Manager, name: []const u8, spec: []const u8) !RegistryPackage {
        return manager.resolveRegistryPackageWithLogLevel(name, spec, .err);
    }

    fn resolveRegistryPackageWithLogLevel(
        manager: *Manager,
        name: []const u8,
        spec: []const u8,
        fetch_log_level: FetchLogLevel,
    ) !RegistryPackage {
        const refresh_manifest = manager.refresh_direct_registry and
            !manager.refreshed_update_manifests.contains(name);
        const cached_manifest: ?*Value = if (refresh_manifest) null else manager.registry_manifests.get(name);
        const manifest = cached_manifest orelse blk: {
            if (!refresh_manifest and fetch_log_level == .err and manager.registry_manifest_failures.contains(name)) {
                return error.RegistryManifestRequestFailed;
            }
            const encoded_name = try encodePackageName(manager.allocator, name);
            const configured_registry = manager.registryConfigForPackage(name);
            const cache_path = try manager.registryManifestCachePath(configured_registry.url, encoded_name);
            if (!refresh_manifest) {
                if (cache_path) |path| {
                    if (try readOptionalFile(manager.init_data.io, manager.allocator, path, max_manifest_bytes)) |cached| {
                        if (try manager.parseRegistryManifest(cached)) |parsed| {
                            if (manager.cachedRegistryManifestIsUsable(parsed)) {
                                try manager.registry_manifests.put(try manager.allocator.dupe(u8, name), parsed);
                                break :blk parsed;
                            }
                        }
                        std.Io.Dir.cwd().deleteFile(manager.init_data.io, path) catch {};
                    }
                }
            }
            const manifest_url = try joinRegistryPackageURL(manager.allocator, configured_registry, encoded_name);
            const bytes = try manager.fetchBytesWithAuthorizationLogLevel(
                manifest_url,
                true,
                max_manifest_bytes,
                configured_registry.authorization,
                fetch_log_level,
            );
            const parsed = (try manager.parseRegistryManifest(bytes)) orelse return error.InvalidRegistryManifest;
            if (cache_path) |path| {
                try std.Io.Dir.cwd().writeFile(manager.init_data.io, .{ .sub_path = path, .data = bytes });
            }
            _ = manager.registry_manifest_failures.remove(name);
            try manager.registry_manifests.put(try manager.allocator.dupe(u8, name), parsed);
            if (refresh_manifest) try manager.refreshed_update_manifests.put(try manager.allocator.dupe(u8, name), {});
            break :blk parsed;
        };
        if (manifest.* != .object) return error.InvalidRegistryManifest;
        const versions_value = manifest.object.get("versions") orelse return error.PackageNotFound;
        if (versions_value != .object) return error.InvalidRegistryManifest;

        var latest_version: ?[]const u8 = null;
        if (manifest.object.get("dist-tags")) |dist_tags| {
            if (dist_tags == .object) {
                if (dist_tags.object.get("latest")) |latest| {
                    if (latest == .string and versions_value.object.get(latest.string) != null) {
                        latest_version = latest.string;
                    }
                }
            }
        }
        const selection = try MinimumReleaseAge.selectVersion(
            manager.allocator,
            manifest,
            name,
            spec,
            manager.options.minimum_release_age_ms,
            manager.minimum_release_age_excludes,
            manager.started_wall_ms,
        );
        if (manager.options.verbose) {
            if (selection.newest_filtered) |newest_filtered| {
                const minimum_age_seconds = (manager.options.minimum_release_age_ms orelse 0) / std.time.ms_per_s;
                try manager.stderr.print(
                    "[minimum-release-age] {s}@{s} selected {s} instead of {s} due to {d}-second filter\n",
                    .{ name, spec, selection.version, newest_filtered, minimum_age_seconds },
                );
            }
        }
        const version_value = selection.version;
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
        const configured_registry = manager.registryConfigForPackage(name);
        const tarball_url = try resolveRegistryTarballURL(manager.allocator, configured_registry.url, tarball_value.string);
        return .{
            .name = if (metadata.object.get("name")) |value| if (value == .string) value.string else name else name,
            .version = try normalizeRegistryVersion(manager.allocator, version_value),
            .latest_version = if (latest_version) |latest|
                try normalizeRegistryVersion(manager.allocator, latest)
            else
                null,
            .tarball = tarball_url,
            .integrity = integrity,
            .metadata = metadata,
            .authorization = manager.authorizationForPackageURL(name, tarball_url),
            .age_filtered = selection.newest_filtered != null,
        };
    }

    fn prefetchInstallNetwork(manager: *Manager, root: *Value) !void {
        if (manager.lock_graph != null) {
            return manager.prefetchLockedRegistryArchives();
        }
        return manager.prefetchRegistryDependencyGraph(root);
    }

    fn prefetchLockedRegistryArchives(manager: *Manager) !void {
        if (manager.options.lockfile_only or manager.options.dry_run or manager.cache_directory == null) return;
        const graph = if (manager.lock_graph) |*value| value else return;
        var archives = std.array_list.Managed(RegistryArchive).init(manager.allocator);
        defer archives.deinit();

        var packages = graph.packages.iterator();
        while (packages.next()) |entry| {
            const package = entry.value_ptr;
            if (package.kind != .npm or package.name.len == 0 or package.version.len == 0) continue;
            const registry = manager.registryConfigForPackage(package.name);
            const tarball = if (package.source.len > 0)
                try resolveRegistryTarballURL(manager.allocator, registry.url, package.source)
            else
                try manager.defaultTarballURL(package.name, package.version);
            try archives.append(.{
                .name = package.name,
                .version = package.version,
                .tarball = tarball,
                .integrity = if (package.integrity.len > 0) package.integrity else null,
                .authorization = manager.authorizationForPackageURL(package.name, tarball),
            });
        }
        try manager.prefetchRegistryArchives(archives.items);
    }

    fn prefetchRegistryDependencyGraph(manager: *Manager, root: *Value) !void {
        var pending = std.array_list.Managed(RegistryDependencyRequest).init(manager.allocator);
        defer pending.deinit();
        var next = std.array_list.Managed(RegistryDependencyRequest).init(manager.allocator);
        defer next.deinit();
        var manifest_names = std.array_list.Managed([]const u8).init(manager.allocator);
        defer manifest_names.deinit();
        var wave_requests = std.array_list.Managed(RegistryDependencyRequest).init(manager.allocator);
        defer wave_requests.deinit();
        var archives = std.array_list.Managed(RegistryArchive).init(manager.allocator);
        defer archives.deinit();
        var seen = std.StringHashMap(void).init(manager.allocator);
        defer seen.deinit();

        try manager.appendRegistryDependencySection(&pending, root, "dependencies", false);
        if (!manager.options.omit_optional) {
            try manager.appendRegistryDependencySection(&pending, root, "optionalDependencies", true);
        }
        if (!manager.options.production and !manager.options.omit_dev) {
            try manager.appendRegistryDependencySection(&pending, root, "devDependencies", false);
        }
        if (!manager.options.omit_peer) {
            try manager.appendRegistryDependencySection(&pending, root, "peerDependencies", false);
        }

        while (pending.items.len > 0) {
            manifest_names.clearRetainingCapacity();
            wave_requests.clearRetainingCapacity();
            next.clearRetainingCapacity();
            for (pending.items) |request| {
                const request_key = try std.fmt.allocPrint(manager.allocator, "{s}\x00{s}\x00{d}", .{
                    request.name,
                    request.spec,
                    @intFromBool(request.optional),
                });
                if (seen.contains(request_key)) continue;
                try seen.put(request_key, {});
                try manifest_names.append(request.name);
                try wave_requests.append(request);
            }

            try manager.prefetchRegistryManifests(manifest_names.items);
            for (wave_requests.items) |request| {
                if (!manager.registry_manifests.contains(request.name)) continue;
                const resolved = manager.resolveRegistryPackage(request.name, request.spec) catch continue;
                if (request.optional and !packageSupportsPlatform(
                    resolved.metadata,
                    manager.options.cpu,
                    manager.options.os,
                )) continue;

                try archives.append(resolved.archive());
                try manager.appendRegistryDependencySection(&next, resolved.metadata, "dependencies", false);
                if (!manager.options.omit_optional) {
                    try manager.appendRegistryDependencySection(&next, resolved.metadata, "optionalDependencies", true);
                }
                if (!manager.options.omit_peer and manager.node_linker == .hoisted) {
                    try manager.appendRegistryDependencySection(&next, resolved.metadata, "peerDependencies", false);
                }
            }

            pending.clearRetainingCapacity();
            std.mem.swap(
                std.array_list.Managed(RegistryDependencyRequest),
                &pending,
                &next,
            );
        }

        if (!manager.options.lockfile_only and !manager.options.dry_run) {
            try manager.prefetchRegistryArchives(archives.items);
        }
    }

    fn appendRegistryDependencySection(
        manager: *Manager,
        requests: *std.array_list.Managed(RegistryDependencyRequest),
        package_json: *const Value,
        key: []const u8,
        optional: bool,
    ) !void {
        if (package_json.* != .object) return;
        const dependencies = package_json.object.get(key) orelse return;
        if (dependencies != .object) return;

        for (dependencies.object.keys(), dependencies.object.values()) |alias, spec_value| {
            if (spec_value != .string) continue;
            if (std.mem.eql(u8, key, "dependencies") and
                (objectSectionContains(package_json, "optionalDependencies", alias) or
                    packageDependencyIsBundled(package_json, alias))) continue;
            if (std.mem.eql(u8, key, "peerDependencies") and
                (objectSectionContains(package_json, "dependencies", alias) or
                    objectSectionContains(package_json, "optionalDependencies", alias) or
                    (!manager.options.production and !manager.options.omit_dev and
                        objectSectionContains(package_json, "devDependencies", alias)))) continue;
            if (std.mem.eql(u8, key, "peerDependencies") and peerDependencyIsOptional(package_json, alias)) continue;

            var workspace_package = manager.isWorkspaceDependency(alias, spec_value.string);
            const effective_spec = manager.manifest_policy.?.resolveDependency(
                alias,
                spec_value.string,
                workspace_package,
            ) catch continue;
            if (!workspace_package) workspace_package = manager.isWorkspaceDependency(alias, effective_spec);
            const resolution_spec = if (Patch.Spec.parseProtocol(manager.allocator, alias, effective_spec) catch null) |protocol|
                protocol.base_spec
            else
                effective_spec;
            if (workspace_package or isGitSpec(resolution_spec) or isTarballSpec(resolution_spec) or
                isLocalSpec(resolution_spec) or std.mem.startsWith(u8, resolution_spec, "http://") or
                std.mem.startsWith(u8, resolution_spec, "https://")) continue;

            const registry_name, const registry_spec = parseNpmAlias(alias, resolution_spec);
            try requests.append(.{
                .name = registry_name,
                .spec = registry_spec,
                .optional = optional,
            });
        }
    }

    fn enrichMigratedLockMetadata(manager: *Manager) !void {
        const graph = if (manager.lock_graph) |*value| value else return;
        if (graph.provenance != .yarn and graph.provenance != .pnpm) return;

        try manager.prefetchMigratedManifests(graph);

        var packages = graph.packages.iterator();
        while (packages.next()) |entry| {
            const package = entry.value_ptr;
            if (package.kind != .npm or package.name.len == 0 or package.version.len == 0) continue;
            const manifest = manager.registry_manifests.get(package.name) orelse continue;
            if (manifest.* != .object) continue;
            const versions = manifest.object.get("versions") orelse continue;
            if (versions != .object) continue;
            const resolved_metadata = versions.object.getPtr(package.version) orelse continue;
            if (resolved_metadata.* != .object) continue;
            if (graph.provenance == .pnpm and !manager.omit_pnpm_workspace_versions) {
                if (resolved_metadata.object.get("dist")) |dist| {
                    if (dist == .object) {
                        if (jsonString(&dist, "tarball")) |tarball| package.source = tarball;
                    }
                }
            }
            const metadata = if (package.info) |value| @constCast(value) else continue;
            if (metadata.* != .object) continue;
            const fields: []const []const u8 = if (graph.provenance == .pnpm)
                &.{"bin"}
            else
                &.{ "bin", "os", "cpu" };
            for (fields) |field| {
                const value = resolved_metadata.object.get(field) orelse continue;
                if (!std.mem.eql(u8, field, "bin") and metadata.object.get(field) != null) continue;
                try metadata.object.put(manager.allocator, field, value);
            }
        }
    }

    fn prefetchMigratedManifests(manager: *Manager, graph: *const Lockfile.Graph) !void {
        var names = std.array_list.Managed([]const u8).init(manager.allocator);
        defer names.deinit();

        var packages = graph.packages.iterator();
        while (packages.next()) |entry| {
            const package = entry.value_ptr;
            if (package.kind != .npm or package.name.len == 0 or package.version.len == 0) continue;
            try names.append(package.name);
        }
        try manager.prefetchRegistryManifests(names.items);
    }

    fn prefetchRegistryManifests(manager: *Manager, names: []const []const u8) !void {
        var queued = std.StringHashMap(void).init(manager.allocator);
        defer queued.deinit();
        var fetches = std.array_list.Managed(RegistryManifestFetch).init(manager.allocator);
        defer fetches.deinit();

        for (names) |name| {
            if (manager.registry_manifests.contains(name) or queued.contains(name)) continue;
            try queued.put(name, {});

            const encoded_name = try encodePackageName(manager.allocator, name);
            const configured_registry = manager.registryConfigForPackage(name);
            const cache_path = try manager.registryManifestCachePath(configured_registry.url, encoded_name);
            if (cache_path) |path| {
                if (try readOptionalFile(manager.init_data.io, manager.allocator, path, max_manifest_bytes)) |cached| {
                    if (try manager.parseRegistryManifest(cached)) |parsed| {
                        if (manager.cachedRegistryManifestIsUsable(parsed)) {
                            try manager.registry_manifests.put(try manager.allocator.dupe(u8, name), parsed);
                            continue;
                        }
                    }
                    std.Io.Dir.cwd().deleteFile(manager.init_data.io, path) catch {};
                }
            }
            try fetches.append(.{
                .io = manager.init_data.io,
                .environment = manager.init_data.environ_map,
                .name = name,
                .url = try joinRegistryPackageURL(manager.allocator, configured_registry, encoded_name),
                .authorization = configured_registry.authorization,
                .cache_path = cache_path,
                .accept = manager.registryManifestAccept(),
            });
        }

        const concurrency = manager.options.network_concurrency orelse packageFetchConcurrency();
        var offset: usize = 0;
        while (offset < fetches.items.len) {
            const end = @min(offset + concurrency, fetches.items.len);
            const batch = fetches.items[offset..end];
            var group: std.Io.Group = .init;
            defer group.cancel(manager.init_data.io);
            for (batch) |*fetch| try group.concurrent(manager.init_data.io, RegistryManifestFetch.run, .{fetch});
            try group.await(manager.init_data.io);

            for (batch) |*fetch| {
                manager.network_task_count += 1;
                if (fetch.failure) |failure| {
                    if (failure == error.RegistryManifestRequestFailed) {
                        try manager.registry_manifest_failures.put(
                            try manager.allocator.dupe(u8, fetch.name),
                            {},
                        );
                    }
                }
                const bytes = fetch.bytes orelse continue;
                defer std.heap.smp_allocator.free(bytes);
                const parsed = (try manager.parseRegistryManifest(bytes)) orelse continue;
                _ = manager.registry_manifest_failures.remove(fetch.name);
                try manager.registry_manifests.put(try manager.allocator.dupe(u8, fetch.name), parsed);
                if (fetch.cache_path) |path| {
                    std.Io.Dir.cwd().writeFile(manager.init_data.io, .{ .sub_path = path, .data = bytes }) catch {};
                }
            }
            offset = end;
        }
    }

    fn prefetchRegistryArchives(manager: *Manager, archives: []const RegistryArchive) !void {
        if (manager.cache_directory == null) return;
        var queued = std.StringHashMap(void).init(manager.allocator);
        defer queued.deinit();
        var fetches = std.array_list.Managed(RegistryArchiveFetch).init(manager.allocator);
        defer fetches.deinit();

        for (archives) |archive| {
            const cache_path = (try manager.registryArchiveCachePath(archive.name, archive.version, archive.tarball)) orelse continue;
            if (queued.contains(cache_path)) continue;
            try queued.put(cache_path, {});
            try fetches.append(.{
                .io = manager.init_data.io,
                .environment = manager.init_data.environ_map,
                .url = archive.tarball,
                .authorization = archive.authorization,
                .integrity = archive.integrity,
                .verify_integrity = manager.options.verify_integrity,
                .cache_path = cache_path,
            });
        }

        const concurrency = manager.options.network_concurrency orelse packageFetchConcurrency();
        var offset: usize = 0;
        while (offset < fetches.items.len) {
            const end = @min(offset + concurrency, fetches.items.len);
            const batch = fetches.items[offset..end];
            var group: std.Io.Group = .init;
            defer group.cancel(manager.init_data.io);
            for (batch) |*fetch| try group.concurrent(manager.init_data.io, RegistryArchiveFetch.run, .{fetch});
            try group.await(manager.init_data.io);
            for (batch) |fetch| {
                if (fetch.fetched) manager.network_task_count += 1;
            }
            offset = end;
        }
    }

    fn fetchBytes(manager: *Manager, url: []const u8, manifest: bool, limit: usize) ![]const u8 {
        return manager.fetchBytesWithAuthorization(url, manifest, limit, manager.authorizationForURL(url));
    }

    fn authorizationForURL(manager: *Manager, url: []const u8) ?[]const u8 {
        var authorization: ?[]const u8 = null;
        if (std.mem.startsWith(u8, url, manager.registry)) authorization = manager.registry_authorization;
        if (authorization == null) {
            var scopes = manager.registry_scopes.valueIterator();
            while (scopes.next()) |configured| {
                if (std.mem.startsWith(u8, url, configured.url)) {
                    authorization = configured.authorization;
                    break;
                }
            }
        }
        return authorization;
    }

    fn authorizationForPackageURL(manager: *Manager, package_name: []const u8, url: []const u8) ?[]const u8 {
        const configured = manager.registryConfigForPackage(package_name);
        if (std.mem.startsWith(u8, url, configured.url)) return configured.authorization;
        return manager.authorizationForURL(url);
    }

    fn fetchBytesWithAuthorization(
        manager: *Manager,
        url: []const u8,
        manifest: bool,
        limit: usize,
        authorization: ?[]const u8,
    ) ![]const u8 {
        return manager.fetchBytesWithAuthorizationLogLevel(url, manifest, limit, authorization, .err);
    }

    fn fetchBytesWithAuthorizationLogLevel(
        manager: *Manager,
        url: []const u8,
        manifest: bool,
        limit: usize,
        authorization: ?[]const u8,
        log_level: FetchLogLevel,
    ) ![]const u8 {
        var headers_buffer: [3]std.http.Header = undefined;
        var header_count: usize = 0;
        if (manifest) {
            headers_buffer[header_count] = .{ .name = "accept", .value = manager.registryManifestAccept() };
            header_count += 1;
        }
        if (authorization) |value| {
            headers_buffer[header_count] = .{ .name = "authorization", .value = value };
            header_count += 1;
            if (manifest) {
                headers_buffer[header_count] = .{ .name = "npm-auth-type", .value = "legacy" };
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
                    try manager.stderr.print("{s}: GET {s} - {s}\n", .{ log_level.label(), url, packageManagerFetchErrorName(err) });
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
            const retryable = status >= 500 or status == 429;
            if (!retryable or attempt == manager.max_retry_count) {
                try manager.stderr.print("{s}: GET {s} - {d}\n", .{ log_level.label(), url, status });
                return error.PackageManagerErrorReported;
            }
        }
        unreachable;
    }

    fn fetchInfoManifest(manager: *Manager, url: []const u8) !?[]const u8 {
        var headers_buffer: [3]std.http.Header = undefined;
        var header_count: usize = 0;
        headers_buffer[header_count] = .{ .name = "accept", .value = "application/json" };
        header_count += 1;
        if (manager.authorizationForURL(url)) |authorization| {
            headers_buffer[header_count] = .{ .name = "authorization", .value = authorization };
            header_count += 1;
            headers_buffer[header_count] = .{ .name = "npm-auth-type", .value = "legacy" };
            header_count += 1;
        }

        var attempt: usize = 0;
        while (attempt <= manager.max_retry_count) : (attempt += 1) {
            var output: std.Io.Writer.Allocating = .init(manager.allocator);
            const result = manager.client.fetch(.{
                .location = .{ .url = url },
                .response_writer = &output.writer,
                .extra_headers = headers_buffer[0..header_count],
            }) catch |err| {
                if (attempt == manager.max_retry_count) {
                    try manager.stderr.print("error: GET {s} - {s}\n", .{ url, packageManagerFetchErrorName(err) });
                    try manager.stderr.flush();
                    return null;
                }
                continue;
            };
            const status: u16 = @intFromEnum(result.status);
            if (status >= 200 and status < 300) {
                if (output.written().len > max_manifest_bytes) return error.ResponseTooLarge;
                return try output.toOwnedSlice();
            }
            output.deinit();
            if ((status >= 500 or status == 429) and attempt < manager.max_retry_count) continue;
            try manager.stderr.print("error: {s}\n", .{result.status.phrase() orelse @tagName(result.status)});
            try manager.stderr.flush();
            return null;
        }
        unreachable;
    }

    fn fetchRegistryArchive(manager: *Manager, package: RegistryArchive, log_level: FetchLogLevel) ![]const u8 {
        if (manager.registry_archives.get(package.tarball)) |archive| {
            if (manager.options.verify_integrity) try verifyIntegrity(archive, package.integrity);
            return archive;
        }

        const cache_path = try manager.registryArchiveCachePath(package.name, package.version, package.tarball);

        if (cache_path) |path| {
            if (try readOptionalFile(manager.init_data.io, manager.allocator, path, max_tarball_bytes)) |cached| {
                const valid = if (manager.options.verify_integrity) blk: {
                    verifyIntegrity(cached, package.integrity) catch break :blk false;
                    break :blk true;
                } else true;
                if (valid) {
                    try manager.registry_archives.put(try manager.allocator.dupe(u8, package.tarball), cached);
                    return cached;
                }
                std.Io.Dir.cwd().deleteFile(manager.init_data.io, path) catch {};
            }
        }

        const archive = try manager.fetchBytesWithAuthorizationLogLevel(
            package.tarball,
            false,
            max_tarball_bytes,
            package.authorization,
            log_level,
        );
        if (manager.options.verify_integrity) try verifyIntegrity(archive, package.integrity);
        if (cache_path) |path| {
            try std.Io.Dir.cwd().writeFile(manager.init_data.io, .{ .sub_path = path, .data = archive });
        }
        try manager.registry_archives.put(try manager.allocator.dupe(u8, package.tarball), archive);
        return archive;
    }

    const LocalPackage = struct {
        name: []const u8,
        version: []const u8,
        path: []const u8,
        package_json: *Value,
    };

    fn resolveLocalPackage(manager: *Manager, spec: []const u8, parent_dir: []const u8) !LocalPackage {
        const path = try manager.localPackagePath(spec, parent_dir);
        if (manager.init_data.environ_map.get("COTTONTAIL_PM_ERROR_TRACE") != null) {
            try manager.stderr.print("local package: {s} from {s} -> {s}\n", .{ spec, parent_dir, path });
        }
        const package_json_path = try std.fs.path.join(manager.allocator, &.{ path, "package.json" });
        const source = std.Io.Dir.cwd().readFileAlloc(
            manager.init_data.io,
            package_json_path,
            manager.allocator,
            .limited(16 * 1024 * 1024),
        ) catch {
            if (isGlobalLinkSpec(spec)) {
                const package_name = localSpecPath(spec);
                if (manager.options.command == .link) {
                    return error.MissingPackageJSON;
                } else {
                    try manager.stderr.print("error: FileNotFound: failed linking dependency/workspace to node_modules for package {s}\n", .{package_name});
                    const finished_ns = std.Io.Clock.awake.now(manager.init_data.io).nanoseconds;
                    const elapsed_ms = @as(f64, @floatFromInt(finished_ns - manager.started_ns)) / std.time.ns_per_ms;
                    try manager.stdout.print("Failed to install 1 package\n[{d:.2}ms] done\n", .{elapsed_ms});
                    try manager.stdout.flush();
                }
                return error.PackageManagerErrorReported;
            }
            return error.MissingPackageJSON;
        };
        const package_json = try manager.allocator.create(Value);
        package_json.* = try PackageJSON.parsePackageJSON(manager.allocator, package_json_path, source);
        if (package_json.* != .object) return error.InvalidPackageJSON;
        const name = jsonString(package_json, "name") orelse return error.InvalidPackageName;
        return .{
            .name = name,
            .version = jsonString(package_json, "version") orelse "0.0.0",
            .path = path,
            .package_json = package_json,
        };
    }

    fn localPackagePath(manager: *Manager, spec: []const u8, parent_dir: []const u8) ![]const u8 {
        if (std.mem.eql(u8, spec, "link:")) return manager.allocator.dupe(u8, manager.root_dir);
        if (isGlobalLinkSpec(spec)) {
            const node_modules = try globalLinkNodeModulesPath(manager.init_data, manager.allocator);
            return std.fs.path.join(manager.allocator, &.{ node_modules, localSpecPath(spec) });
        }
        return absolutePathFrom(manager.allocator, parent_dir, localSpecPath(spec));
    }

    fn normalizeLocalSpec(manager: *Manager, spec: []const u8, path: []const u8) ![]const u8 {
        return manager.normalizeLocalSpecFrom(spec, path, manager.root_dir);
    }

    fn normalizeLocalSpecFrom(manager: *Manager, spec: []const u8, path: []const u8, base_dir: []const u8) ![]const u8 {
        if (isGlobalLinkSpec(spec)) return manager.allocator.dupe(u8, spec);
        const prefix = if (std.mem.startsWith(u8, spec, "link:")) "link:" else "file:";
        const relative = try std.fs.path.relative(
            manager.allocator,
            manager.root_dir,
            manager.init_data.environ_map,
            base_dir,
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
        const consumer_modules = if (manager.node_linker == .isolated)
            try manager.isolatedConsumerModules(parent_dir)
        else
            "";
        const bin_dir = if (manager.options.global and report_direct)
            manager.global_bin_directory orelse return error.MissingGlobalBinDirectory
        else if (manager.node_linker == .isolated)
            try std.fs.path.join(manager.allocator, &.{ consumer_modules, ".bin" })
        else
            try manager.binDirectoryForPackage(package_dir);
        const target_package_dir = if (manager.node_linker == .isolated and report_direct)
            try std.fs.path.join(manager.allocator, &.{ consumer_modules, alias })
        else
            package_dir;
        return manager.linkBinsInDirectory(alias, target_package_dir, metadata, report_direct, bin_dir);
    }

    fn linkBinsInDirectory(
        manager: *Manager,
        alias: []const u8,
        package_dir: []const u8,
        metadata: *const Value,
        report_direct: bool,
        bin_dir: []const u8,
    ) !void {
        if (metadata.* != .object) return;
        if (metadata.object.get("bin")) |bin_value| {
            if (bin_value == .string) {
                const base_name = normalizedBinName(alias);
                if (try manager.linkBin(bin_dir, base_name, package_dir, bin_value.string)) {
                    if (report_direct) try manager.direct_bins.append(base_name);
                }
            } else if (bin_value == .object) {
                for (bin_value.object.keys(), bin_value.object.values()) |name, path_value| {
                    const bin_name = normalizedBinObjectName(name);
                    if (path_value == .string and try manager.linkBin(bin_dir, bin_name, package_dir, path_value.string)) {
                        if (report_direct) try manager.direct_bins.append(bin_name);
                    }
                }
            }
            return;
        }

        const bin_directory = packageBinDirectory(metadata) orelse return;
        const directory_path = try std.fs.path.join(manager.allocator, &.{ package_dir, bin_directory });
        var directory = std.Io.Dir.cwd().openDir(manager.init_data.io, directory_path, .{ .iterate = true }) catch return;
        defer directory.close(manager.init_data.io);
        var iterator = directory.iterate();
        while (try iterator.next(manager.init_data.io)) |entry| {
            if (entry.kind != .file) continue;
            const relative_target = try std.fs.path.join(manager.allocator, &.{ bin_directory, entry.name });
            if (try manager.linkBin(bin_dir, normalizedBinName(entry.name), package_dir, relative_target)) {
                if (report_direct) try manager.direct_bins.append(normalizedBinName(entry.name));
            }
        }
    }

    fn unlinkBinsInDirectory(
        manager: *Manager,
        alias: []const u8,
        metadata: *const Value,
        bin_dir: []const u8,
    ) !void {
        if (metadata.* != .object) return;
        if (metadata.object.get("bin")) |bin_value| {
            if (bin_value == .string) {
                manager.unlinkBin(bin_dir, normalizedBinName(alias));
            } else if (bin_value == .object) {
                for (bin_value.object.keys()) |name| manager.unlinkBin(bin_dir, normalizedBinObjectName(name));
            }
            return;
        }

        const bin_directory = packageBinDirectory(metadata) orelse return;
        const directory_path = try std.fs.path.join(manager.allocator, &.{ manager.invocation_package_dir, bin_directory });
        var directory = std.Io.Dir.cwd().openDir(manager.init_data.io, directory_path, .{ .iterate = true }) catch return;
        defer directory.close(manager.init_data.io);
        var iterator = directory.iterate();
        while (try iterator.next(manager.init_data.io)) |entry| {
            if (entry.kind == .file) manager.unlinkBin(bin_dir, normalizedBinName(entry.name));
        }
    }

    fn unlinkBin(manager: *Manager, bin_dir: []const u8, name: []const u8) void {
        const destination = std.fs.path.join(manager.allocator, &.{ bin_dir, name }) catch return;
        deletePath(manager.init_data.io, destination);
        if (builtin.os.tag == .windows) {
            const command_path = std.fmt.allocPrint(manager.allocator, "{s}.cmd", .{destination}) catch return;
            deletePath(manager.init_data.io, command_path);
        }
    }

    fn linkBin(manager: *Manager, bin_dir: []const u8, name: []const u8, package_dir: []const u8, relative_target: []const u8) !bool {
        const target = try std.fs.path.join(manager.allocator, &.{ package_dir, relative_target });
        const stat = std.Io.Dir.cwd().statFile(manager.init_data.io, target, .{}) catch return false;
        if (stat.kind != .file) return false;
        if (builtin.os.tag != .windows) try manager.preparePosixBin(target, stat);
        const destination = try std.fs.path.join(manager.allocator, &.{ bin_dir, name });
        const seen = try manager.linked_bins.getOrPut(destination);
        if (seen.found_existing) return false;
        try std.Io.Dir.cwd().createDirPath(manager.init_data.io, bin_dir);
        deletePath(manager.init_data.io, destination);
        const destination_parent = std.fs.path.dirname(destination) orelse bin_dir;
        try std.Io.Dir.cwd().createDirPath(manager.init_data.io, destination_parent);
        if (builtin.os.tag == .windows) {
            const command_path = try std.fmt.allocPrint(manager.allocator, "{s}.cmd", .{destination});
            const executable = try std.process.executablePathAlloc(manager.init_data.io, manager.allocator);
            const command = try std.fmt.allocPrint(manager.allocator, "@\"{s}\" \"{s}\" %*\r\n", .{ executable, target });
            try std.Io.Dir.cwd().writeFile(manager.init_data.io, .{ .sub_path = command_path, .data = command });
            if (manager.node_linker == .isolated) {
                try manager.isolated_live_links.put(try manager.allocator.dupe(u8, command_path), {});
            }
        } else {
            const bin_target = try std.fs.path.relative(
                manager.allocator,
                manager.root_dir,
                manager.init_data.environ_map,
                destination_parent,
                target,
            );
            try std.Io.Dir.cwd().symLink(manager.init_data.io, bin_target, destination, .{});
            if (manager.node_linker == .isolated) {
                try manager.isolated_live_links.put(try manager.allocator.dupe(u8, destination), {});
            }
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
            const candidate_dir = if (candidate.install_dir.len > 0)
                candidate.install_dir
            else
                try packageDestination(manager.allocator, manager.root_dir, candidate.alias);
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
        const discovery = Workspaces.discover(manager.init_data.io, manager.allocator, manager.root_dir, root) catch |err| switch (err) {
            error.InvalidWorkspaces => {
                try manager.stderr.writeAll("error: Invalid workspaces configuration; expected an array of strings\n");
                return error.PackageManagerErrorReported;
            },
            error.InvalidWorkspaceGlob => {
                try manager.stderr.writeAll("error: Invalid workspace glob\n");
                return error.PackageManagerErrorReported;
            },
            else => return err,
        };
        var failed = false;
        for (discovery.diagnostics) |diagnostic| switch (diagnostic) {
            .missing_workspace => |path| {
                try manager.stderr.print("error: Workspace not found \"{s}\"\n", .{path});
                failed = true;
            },
            .missing_name => |path| {
                try manager.stderr.print("error: Workspace at \"{s}\" is missing a package name\n", .{path});
                failed = true;
            },
            .invalid_package_json => |path| {
                try manager.stderr.print("error: Invalid package.json in workspace \"{s}\"\n", .{path});
                failed = true;
            },
            .duplicate_name => |duplicate| {
                const first_path = try std.fs.path.join(manager.allocator, &.{ manager.root_dir, duplicate.first_path, "package.json" });
                const duplicate_path = try std.fs.path.join(manager.allocator, &.{ manager.root_dir, duplicate.duplicate_path, "package.json" });
                const first_source = std.Io.Dir.cwd().readFileAlloc(
                    manager.init_data.io,
                    first_path,
                    manager.allocator,
                    .limited(64 * 1024 * 1024),
                ) catch null;
                const duplicate_source = std.Io.Dir.cwd().readFileAlloc(
                    manager.init_data.io,
                    duplicate_path,
                    manager.allocator,
                    .limited(64 * 1024 * 1024),
                ) catch null;
                const printed = if (first_source != null and duplicate_source != null)
                    try PackageJSON.printDuplicateWorkspaceName(
                        manager.allocator,
                        duplicate.name,
                        duplicate_path,
                        duplicate_source.?,
                        first_path,
                        first_source.?,
                        manager.stderr,
                    )
                else
                    false;
                if (!printed) {
                    try manager.stderr.print(
                        "error: Workspace name \"{s}\" already exists\nnote: first declared at {s}/package.json\nnote: duplicated at {s}/package.json\n",
                        .{ duplicate.name, duplicate.first_path, duplicate.duplicate_path },
                    );
                }
                failed = true;
            },
        };
        if (failed) return error.PackageManagerErrorReported;
        for (discovery.entries) |workspace| try manager.workspaces.put(workspace.name, workspace);

        const graph = if (manager.lock_graph) |*lock_graph| lock_graph else return;
        if (graph.provenance != .npm) return;
        var migrated_workspaces = graph.workspaces.iterator();
        while (migrated_workspaces.next()) |entry| {
            const relative_path = entry.key_ptr.*;
            if (relative_path.len == 0) continue;
            const package_json = entry.value_ptr.*;
            const name = jsonString(package_json, "name") orelse continue;
            if (manager.workspaces.contains(name)) continue;
            const version_value = if (package_json.* == .object) package_json.object.get("version") else null;
            const has_version = version_value != null and version_value.? == .string;
            try manager.workspaces.put(name, .{
                .name = name,
                .path = try std.fs.path.join(manager.allocator, &.{ manager.root_dir, relative_path }),
                .relative_path = relative_path,
                .version = if (has_version) version_value.?.string else "0.0.0",
                .has_version = has_version,
                .package_json = @constCast(package_json),
            });
        }
    }

    fn discoverExplicitWorkspaceDependencies(
        manager: *Manager,
        package_json: *const Value,
        parent_dir: []const u8,
    ) !void {
        var visited = std.StringHashMap(void).init(manager.allocator);
        defer visited.deinit();
        return manager.discoverExplicitWorkspaceDependenciesInner(package_json, parent_dir, &visited);
    }

    fn discoverExplicitWorkspaceDependenciesInner(
        manager: *Manager,
        package_json: *const Value,
        parent_dir: []const u8,
        visited: *std.StringHashMap(void),
    ) !void {
        const visit = try visited.getOrPut(parent_dir);
        if (visit.found_existing) return;
        if (package_json.* != .object) return;
        for (all_dependency_sections) |section_name| {
            const section = package_json.object.get(section_name) orelse continue;
            if (section != .object) continue;
            for (section.object.keys(), section.object.values()) |alias, spec_value| {
                if (spec_value != .string) continue;
                const request = Workspaces.parseRequest(alias, spec_value.string);
                const path = request.path orelse continue;
                const target_path = try absolutePathFrom(manager.allocator, parent_dir, path);
                const workspace = if (manager.workspaceForPath(target_path)) |entry|
                    entry.*
                else
                    (try manager.discoverExplicitWorkspacePath(target_path)) orelse continue;
                try manager.discoverExplicitWorkspaceDependenciesInner(workspace.package_json, workspace.path, visited);
            }
        }
    }

    fn workspaceForPath(manager: *Manager, path: []const u8) ?*Workspace {
        var iterator = manager.workspaces.iterator();
        while (iterator.next()) |entry| {
            if (pathsEquivalent(manager.init_data.io, manager.allocator, entry.value_ptr.path, path) catch false) {
                return entry.value_ptr;
            }
        }
        return null;
    }

    fn discoverExplicitWorkspacePath(manager: *Manager, path: []const u8) !?Workspace {
        const package_json_path = try std.fs.path.join(manager.allocator, &.{ path, "package.json" });
        const source = std.Io.Dir.cwd().readFileAlloc(
            manager.init_data.io,
            package_json_path,
            manager.allocator,
            .limited(64 * 1024 * 1024),
        ) catch return null;
        const package_json = try manager.allocator.create(Value);
        package_json.* = PackageJSON.parsePackageJSON(manager.allocator, package_json_path, source) catch return null;
        if (package_json.* != .object) return null;
        const name = jsonString(package_json, "name") orelse return null;
        if (name.len == 0) return null;
        const version_value = package_json.object.get("version");
        const has_version = version_value != null and version_value.? == .string;
        const workspace: Workspace = .{
            .name = name,
            .path = path,
            .relative_path = try manager.relativeLockPath(path),
            .version = if (has_version) version_value.?.string else "0.0.0",
            .has_version = has_version,
            .package_json = package_json,
        };
        try manager.workspaces.put(name, workspace);
        return workspace;
    }

    fn pathIsWorkspace(manager: *Manager, path: []const u8) bool {
        var iterator = manager.workspaces.iterator();
        while (iterator.next()) |entry| {
            if (pathsEquivalent(manager.init_data.io, manager.allocator, entry.value_ptr.path, path) catch false) {
                return true;
            }
        }
        return false;
    }

    fn workspaceHasRecord(manager: *Manager, workspace: Workspace) bool {
        for (manager.records.items) |record| {
            if (record.kind != .workspace or record.local_path.len == 0) continue;
            if (pathsEquivalent(manager.init_data.io, manager.allocator, record.local_path, workspace.path) catch false) {
                return true;
            }
        }
        return false;
    }

    fn resolveWorkspaceDependency(
        manager: *Manager,
        alias: []const u8,
        spec: []const u8,
        parent_dir: []const u8,
    ) !Workspace {
        const request = Workspaces.parseRequest(alias, spec);
        const registry_name, const registry_range = parseNpmAlias(alias, spec);
        const workspace = if (request.path) |path| path_workspace: {
            const target_path = try absolutePathFrom(manager.allocator, parent_dir, path);
            if (manager.workspaceForPath(target_path)) |entry| break :path_workspace entry.*;
            if (try manager.discoverExplicitWorkspacePath(target_path)) |entry| break :path_workspace entry;
            if (!std.mem.eql(u8, parent_dir, manager.root_dir)) {
                const root_target_path = try absolutePathFrom(manager.allocator, manager.root_dir, path);
                if (manager.workspaceForPath(root_target_path)) |entry| break :path_workspace entry.*;
                if (try manager.discoverExplicitWorkspacePath(root_target_path)) |entry| break :path_workspace entry;
            }
            break :path_workspace null;
        } else manager.workspaces.get(if (request.explicit) request.target_name else registry_name);

        const selected = workspace orelse {
            try manager.stderr.print("error: Workspace dependency \"{s}\" not found\n", .{alias});
            return error.PackageManagerErrorReported;
        };
        if (request.explicit) {
            if (request.range) |range| {
                const trimmed = std.mem.trim(u8, range, " \t\r\n");
                const version_matches = selected.has_version and
                    Semver.Version.parseUTF8(selected.version).valid and
                    semverSatisfies(manager.allocator, trimmed, selected.version);
                if (!version_matches and
                    trimmed.len > 0 and
                    !semverRangeIsWildcard(manager.allocator, trimmed) and
                    !Semver.Version.isTaggedVersionOnly(trimmed))
                {
                    try manager.stderr.print(
                        "error: No matching version for workspace dependency \"{s}\". Version: \"{s}\"\n",
                        .{ alias, spec },
                    );
                    return error.PackageManagerErrorReported;
                }
            }
        } else if (!manager.workspaceMatchesRange(selected, registry_range)) {
            return error.WorkspaceNotFound;
        }
        return selected;
    }

    fn installResolvedWorkspace(
        manager: *Manager,
        alias: []const u8,
        workspace: Workspace,
        parent_dir: []const u8,
        direct: bool,
        protocol_patch_paths: []const []const u8,
    ) ![]const u8 {
        if (protocol_patch_paths.len > 0) return error.UnsupportedPatchResolution;
        _ = try manager.peerContextForPackage(workspace.package_json, parent_dir, true);
        const destination = if (manager.node_linker == .isolated)
            try std.fs.path.join(manager.allocator, &.{ try manager.isolatedConsumerModules(parent_dir), alias })
        else
            try manager.chooseDestination(alias, workspace.version, parent_dir, direct);
        if (!manager.options.lockfile_only) {
            try manager.linkRelativeDirectory(destination, workspace.path, true);
        }
        try manager.countWorkspaceInstall(workspace);
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

    fn isWorkspaceDependency(manager: *Manager, alias: []const u8, spec: []const u8) bool {
        const request = Workspaces.parseRequest(alias, spec);
        if (request.explicit) return true;
        if (isLocalSpec(spec)) return false;
        if (!manager.link_workspace_packages) return false;
        const registry_name, const registry_range = parseNpmAlias(alias, spec);
        const workspace = manager.workspaces.get(registry_name) orelse return false;
        return manager.workspaceMatchesRange(workspace, registry_range);
    }

    fn workspaceDisplayResolution(
        manager: *Manager,
        alias: []const u8,
        spec: []const u8,
        parent_dir: []const u8,
    ) !?[]const u8 {
        if (!manager.isWorkspaceDependency(alias, spec)) return null;
        const workspace = try manager.resolveWorkspaceDependency(alias, spec, parent_dir);
        return try std.fmt.allocPrint(manager.allocator, "workspace:{s}", .{workspace.relative_path});
    }

    fn workspaceMatchesRange(manager: *Manager, workspace: Workspace, range: []const u8) bool {
        if (std.mem.trim(u8, range, " \t\r\n").len == 0) return false;
        if (Semver.Version.isTaggedVersionOnly(range)) return false;
        const parsed_version = Semver.Version.parseUTF8(workspace.version);
        if (workspace.has_version and parsed_version.valid) {
            return semverSatisfies(manager.allocator, range, workspace.version);
        }
        return semverRangeIsWildcard(manager.allocator, range);
    }

    fn workspaceShouldLinkAtRoot(manager: *Manager, workspace: Workspace) bool {
        const root_spec = manager.rootDependencySpec(workspace.name) orelse return true;
        return manager.isWorkspaceDependency(workspace.name, root_spec);
    }

    fn reserveWorkspaceRootVersions(manager: *Manager) !void {
        if (manager.node_linker != .hoisted) return;
        var iterator = manager.workspaces.iterator();
        while (iterator.next()) |entry| {
            const workspace = entry.value_ptr.*;
            if (!manager.workspaceShouldLinkAtRoot(workspace)) continue;
            try manager.root_versions.put(
                try manager.allocator.dupe(u8, workspace.name),
                try manager.allocator.dupe(u8, workspace.version),
            );
        }
    }

    fn captureInitialDirectVersions(
        manager: *Manager,
        package_json: *const Value,
        parent_dir: []const u8,
    ) !void {
        if (package_json.* != .object or manager.options.lockfile_only or manager.options.dry_run) return;
        for (all_dependency_sections) |section_name| {
            const section = package_json.object.get(section_name) orelse continue;
            if (section != .object) continue;
            for (section.object.keys()) |alias| {
                if (manager.initial_root_versions.contains(alias)) continue;
                var base = parent_dir;
                while (true) {
                    const destination = try packageDestination(manager.allocator, base, alias);
                    if (manager.readInstalledPackageJSON(destination) catch null) |installed_package_json| {
                        const installed_version = jsonString(installed_package_json, "version") orelse break;
                        try manager.initial_root_versions.put(
                            try manager.allocator.dupe(u8, alias),
                            try manager.allocator.dupe(u8, installed_version),
                        );
                        break;
                    }
                    if (std.mem.eql(u8, base, manager.root_dir)) break;
                    base = parentPackageBase(manager.root_dir, base) orelse break;
                }
            }
        }
    }

    fn reserveDirectRootVersions(manager: *Manager, root: *const Value) !void {
        if (manager.node_linker != .hoisted or root.* != .object) return;

        // COTTONTAIL-COMPAT: Bun resolves the complete graph before hoisting.
        // Reserve direct selections up front so recursive resolution cannot
        // occupy the root with a different, merely compatible version.
        if (!manager.options.omit_optional) {
            try manager.reserveDirectRootDependencySection(root, "optionalDependencies");
        }
        if (!manager.options.production and !manager.options.omit_dev) {
            try manager.reserveDirectRootDependencySection(root, "devDependencies");
        }
        try manager.reserveDirectRootDependencySection(root, "dependencies");
        if (!manager.options.omit_peer) {
            try manager.reserveDirectRootDependencySection(root, "peerDependencies");
        }
    }

    fn reserveDirectRootDependencySection(
        manager: *Manager,
        root: *const Value,
        section_name: []const u8,
    ) !void {
        const section = root.object.get(section_name) orelse return;
        if (section != .object) return;

        for (section.object.keys(), section.object.values()) |alias, spec_value| {
            if (spec_value != .string or manager.root_versions.contains(alias)) continue;
            var workspace_package = manager.isWorkspaceDependency(alias, spec_value.string);
            const effective_spec = manager.manifest_policy.?.resolveDependency(
                alias,
                spec_value.string,
                workspace_package,
            ) catch continue;
            if (!workspace_package) workspace_package = manager.isWorkspaceDependency(alias, effective_spec);
            const resolution_spec = if (Patch.Spec.parseProtocol(manager.allocator, alias, effective_spec) catch null) |protocol|
                protocol.base_spec
            else
                effective_spec;
            if (workspace_package or isGitSpec(resolution_spec) or isTarballSpec(resolution_spec) or
                isLocalSpec(resolution_spec)) continue;

            const registry_name, const registry_spec = parseNpmAlias(alias, resolution_spec);
            if (manager.lock_graph) |*graph| {
                if (graph.get(alias)) |package| {
                    if (package.kind == .npm and std.mem.eql(u8, package.name, registry_name) and
                        semverSatisfies(manager.allocator, registry_spec, package.version))
                    {
                        try manager.root_versions.put(
                            try manager.allocator.dupe(u8, alias),
                            try manager.allocator.dupe(u8, package.version),
                        );
                        continue;
                    }
                }
            }

            const resolved = manager.resolveRegistryPackage(registry_name, registry_spec) catch continue;
            try manager.root_versions.put(
                try manager.allocator.dupe(u8, alias),
                try manager.allocator.dupe(u8, resolved.version),
            );
        }
    }

    fn countRegistryInstall(manager: *Manager, name: []const u8, version_value: []const u8, tarball: []const u8) !void {
        if (manager.options.lockfile_only or manager.options.dry_run) return;
        const key = try std.fmt.allocPrint(manager.allocator, "{s}\x00{s}\x00{s}", .{ name, version_value, tarball });
        const entry = try manager.installed_registry_packages.getOrPut(key);
        if (!entry.found_existing) manager.installed_count += 1;
    }

    fn countWorkspaceInstall(manager: *Manager, workspace: Workspace) !void {
        if (manager.options.lockfile_only or manager.options.dry_run) return;
        // COTTONTAIL-COMPAT: Bun's hoisted installer counts each selected
        // workspace on every materialization pass, even when its link exists.
        // Its isolated installer reports workspace entries as checked instead.
        const entry = try manager.installed_workspaces.getOrPut(workspace.name);
        if (!entry.found_existing and manager.node_linker == .hoisted) manager.installed_count += 1;
    }

    fn checkedInstallCount(manager: *const Manager) usize {
        if (manager.node_linker == .isolated) {
            // Bun's isolated installer checks one store entry for the root and
            // each package, plus one entry per distinct explicit workspace target.
            return manager.lockfilePackageCount() + manager.installed_workspaces.count();
        }
        return manager.records.items.len;
    }

    fn installWorkspaceDependencies(manager: *Manager) !void {
        var workspaces = std.array_list.Managed(Workspace).init(manager.allocator);
        defer workspaces.deinit();
        var iterator = manager.workspaces.iterator();
        while (iterator.next()) |entry| try workspaces.append(entry.value_ptr.*);
        std.mem.sort(Workspace, workspaces.items, {}, struct {
            fn lessThan(_: void, left: Workspace, right: Workspace) bool {
                return std.mem.order(u8, left.relative_path, right.relative_path) == .lt;
            }
        }.lessThan);

        for (workspaces.items) |workspace| {
            const previous = manager.setResolutionOnly(!manager.workspaceSelected(workspace));
            defer manager.restoreResolutionOnly(previous);
            try manager.rememberPackageMetadata(workspace.path, workspace.package_json);
            _ = try manager.peerContextForPackage(workspace.package_json, workspace.path, true);
            if (manager.node_linker == .hoisted and manager.workspaceShouldLinkAtRoot(workspace)) {
                const destination = try packageDestination(manager.allocator, manager.root_dir, workspace.name);
                if (!manager.options.lockfile_only) try manager.linkRelativeDirectory(destination, workspace.path, true);
                try manager.countWorkspaceInstall(workspace);
                if (!manager.options.lockfile_only) try manager.linkBins(workspace.name, destination, workspace.package_json, true, manager.root_dir);
                try manager.addRecord(.{
                    .key = try manager.lockKeyForDestination(destination),
                    .alias = workspace.name,
                    .name = workspace.name,
                    .version = workspace.version,
                    .local_path = workspace.path,
                    .resolution = workspace.path,
                    .kind = .workspace,
                    .metadata = workspace.package_json,
                    .install_dir = workspace.path,
                });
            } else if (manager.node_linker == .isolated) {
                try manager.addRecord(.{
                    .key = workspace.name,
                    .alias = workspace.name,
                    .name = workspace.name,
                    .version = workspace.version,
                    .local_path = workspace.path,
                    .resolution = workspace.path,
                    .kind = .workspace,
                    .metadata = workspace.package_json,
                    .install_dir = workspace.path,
                });
            }
        }

        for (workspaces.items) |workspace| {
            const previous = manager.setResolutionOnly(!manager.workspaceSelected(workspace));
            defer manager.restoreResolutionOnly(previous);
            try manager.installDependencyObject(workspace.package_json, "dependencies", workspace.path, false, false);
            try manager.installOptionalDependencies(workspace.package_json, workspace.path, false);
            if (manager.options.omit_peer) {
                try manager.resolveOmittedDependencyObject(workspace.package_json, "peerDependencies", workspace.path, false, false);
            } else {
                try manager.installOrLinkPeerDependencies(workspace.package_json, workspace.path, workspace.path, workspace.path);
            }
            if (manager.options.production or manager.options.omit_dev) {
                try manager.resolveOmittedDependencyObject(workspace.package_json, "devDependencies", workspace.path, false, false);
            } else {
                try manager.installDependencyObject(workspace.package_json, "devDependencies", workspace.path, false, false);
            }
            try manager.queuePackageScripts(workspace.name, workspace.name, workspace.version, workspace.path, .workspace, true, false, true);
        }
    }

    fn pruneStaleHoistedWorkspaceLinks(manager: *Manager) !void {
        if (manager.node_linker != .hoisted or manager.options.lockfile_only or manager.options.dry_run) return;
        const graph = if (manager.lock_graph) |*value| value else return;
        var packages = graph.packages.iterator();
        while (packages.next()) |entry| {
            if (entry.value_ptr.kind != .workspace) continue;
            var retained = false;
            for (manager.records.items) |record| {
                const key = if (record.key.len > 0) record.key else record.alias;
                if (manager.recordResolutionOnly(record)) continue;
                if (std.mem.eql(u8, key, entry.key_ptr.*)) {
                    retained = true;
                    break;
                }
            }
            if (retained) continue;
            const destination = Patch.Spec.destinationForLockKey(manager.allocator, manager.root_dir, entry.key_ptr.*) catch continue;
            deletePath(manager.init_data.io, destination);
        }
    }

    fn queuePackageScripts(
        manager: *Manager,
        alias: []const u8,
        package_name: []const u8,
        version_value: []const u8,
        package_dir: []const u8,
        kind: Scripts.PackageKind,
        direct: bool,
        optional: bool,
        newly_installed: bool,
    ) !void {
        if (manager.options.ignore_scripts or manager.options.lockfile_only or manager.options.dry_run) return;
        const npm_package = kind == .npm;
        const explicitly_trusted = manager.options.trust and
            manager.options.command == .add and
            (direct or manager.explicit_adds.contains(alias));
        const trusted = kind == .workspace or
            explicitly_trusted or
            manager.manifest_policy.?.isTrusted(alias, npm_package);
        if (!trusted) {
            if (newly_installed) {
                const manifest = manager.readInstalledPackageJSON(package_dir) catch return;
                const scripts = Scripts.inspectLifecycleScripts(
                    manager.init_data.io,
                    manager.allocator,
                    package_dir,
                    manifest,
                    kind,
                ) catch return;
                if (direct and kind == .local and scripts.total == 1 and
                    scripts.commands[1] != null and
                    std.mem.eql(u8, scripts.commands[1].?, "node-gyp rebuild"))
                {
                    try manager.script_queue.add(.{
                        .name = package_name,
                        .version = version_value,
                        .cwd = package_dir,
                        .kind = kind,
                        .optional = optional,
                        .auto_node_gyp_only = true,
                    });
                    return;
                }
                manager.blocked_scripts += scripts.total;
            }
            return;
        }

        if (explicitly_trusted) {
            const manifest = manager.readInstalledPackageJSON(package_dir) catch return;
            const scripts = Scripts.inspectLifecycleScripts(
                manager.init_data.io,
                manager.allocator,
                package_dir,
                manifest,
                kind,
            ) catch return;
            if (scripts.total == 0) return;
            try manager.trusted_additions.put(try manager.allocator.dupe(u8, alias), {});
        }

        if (!newly_installed and !explicitly_trusted) {
            if (manager.packageWasTrustedInLoadedLock(alias, npm_package)) return;
        }

        try manager.script_queue.add(.{
            .name = package_name,
            .version = version_value,
            .cwd = package_dir,
            .kind = kind,
            .optional = optional,
        });
    }

    fn persistTrustedAdditions(manager: *Manager, root: *Value) !void {
        const additions = try manager.allocator.alloc([]const u8, manager.trusted_additions.count());
        var iterator = manager.trusted_additions.keyIterator();
        var index: usize = 0;
        while (iterator.next()) |name| : (index += 1) additions[index] = name.*;
        _ = try Manifest.mergeTrustedDependencies(manager.allocator, root, additions);

        if (manager.manifest_policy) |*policy| policy.deinit();
        manager.manifest_policy = try Manifest.Policy.init(manager.allocator, root);
        manager.changed = true;
    }

    fn pathExists(manager: *Manager, path: []const u8) bool {
        std.Io.Dir.cwd().access(manager.init_data.io, path, .{}) catch return false;
        return true;
    }

    fn recordResolutionOnly(manager: *const Manager, record: PackageRecord) bool {
        return manager.resolution_only_records.contains(recordLogicalKey(record));
    }

    fn addRecord(manager: *Manager, record: PackageRecord) !void {
        const record_key = if (record.key.len > 0) record.key else record.alias;
        for (manager.records.items, 0..) |existing, index| {
            const existing_key = if (existing.key.len > 0) existing.key else existing.alias;
            if (std.mem.eql(u8, existing_key, record_key)) {
                // A package reached through any enabled edge remains eligible
                // for materialization when an omitted edge reaches it later.
                if (!manager.filter_resolution_only) _ = manager.resolution_only_records.remove(record_key);
                manager.records.items[index] = record;
                return;
            }
        }
        if (manager.filter_resolution_only) {
            try manager.resolution_only_records.put(try manager.allocator.dupe(u8, record_key), {});
        } else {
            _ = manager.resolution_only_records.remove(record_key);
        }
        try manager.records.append(record);
    }

    fn loadRecordsFromLockGraph(manager: *Manager) !void {
        var iterator = manager.lock_graph.?.packages.iterator();
        while (iterator.next()) |entry| {
            const package = entry.value_ptr.*;
            const alias = try lockAliasFromKey(manager.allocator, package.key);
            const version_value = if (package.version.len > 0)
                package.version
            else if (package.info) |info|
                jsonString(info, "version") orelse "0.0.0"
            else
                "0.0.0";
            try manager.addRecord(.{
                .key = package.key,
                .alias = alias,
                .name = package.name,
                .version = version_value,
                .tarball = package.source,
                .git_resolved = package.git_resolved,
                .integrity = package.integrity,
                .local_path = package.source,
                .resolution = package.source,
                .kind = package.kind,
                .metadata = package.info,
            });
        }
    }

    fn lockfilePackageCount(manager: *const Manager) usize {
        var count: usize = 1;
        for (manager.records.items, 0..) |record, index| {
            var duplicate = false;
            for (manager.records.items[0..index]) |previous| {
                if (packageRecordsHaveSameIdentity(record, previous)) {
                    duplicate = true;
                    break;
                }
            }
            if (!duplicate) count += 1;
        }
        return count;
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
                try manager.writePackageInfo(writer, record.metadata, false, false);
                try writer.writeAll(", ");
                try writeJSONString(writer, record.integrity);
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
                try manager.writePackageInfo(writer, record.metadata, false, true);
            },
            .local_tarball, .remote_tarball => {
                const source = if (record.resolution.len > 0) record.resolution else record.tarball;
                const resolution = try std.fmt.allocPrint(manager.allocator, "{s}@{s}", .{ record.name, source });
                try writeJSONString(writer, resolution);
                try writer.writeAll(", ");
                try manager.writePackageInfo(writer, record.metadata, false, false);
                if (record.integrity.len > 0) {
                    try writer.writeAll(", ");
                    try writeJSONString(writer, record.integrity);
                }
            },
            .git, .github => {
                const source = if (record.resolution.len > 0) record.resolution else record.tarball;
                const resolution = try std.fmt.allocPrint(manager.allocator, "{s}@{s}", .{ record.name, source });
                try writeJSONString(writer, resolution);
                try writer.writeAll(", ");
                try manager.writePackageInfo(writer, record.metadata, true, false);
                try writer.writeAll(", ");
                try writeJSONString(writer, record.git_resolved);
                if (record.integrity.len > 0) {
                    try writer.writeAll(", ");
                    try writeJSONString(writer, record.integrity);
                }
            },
            .root => {
                const resolution = try std.fmt.allocPrint(manager.allocator, "{s}@root:", .{record.name});
                try writeJSONString(writer, resolution);
                try writer.writeAll(", ");
                try manager.writePackageInfo(writer, record.metadata, false, false);
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

    fn writePackageInfo(
        manager: *Manager,
        writer: *std.Io.Writer,
        metadata: ?*const Value,
        all_peers_optional: bool,
        include_dev_dependencies: bool,
    ) !void {
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
            if (std.mem.eql(u8, field, "devDependencies") and !include_dev_dependencies) continue;
            const field_value = value.object.get(field) orelse {
                if (std.mem.eql(u8, field, "binDir")) {
                    const bin_directory = packageBinDirectory(value) orelse continue;
                    if (!first) try writer.writeAll(", ");
                    first = false;
                    try writeJSONString(writer, field);
                    try writer.writeAll(": ");
                    try writeJSONString(writer, bin_directory);
                }
                continue;
            };
            if (!first) try writer.writeAll(", ");
            first = false;
            try writeJSONString(writer, field);
            try writer.writeAll(": ");
            if (std.mem.eql(u8, field, "bin")) {
                try writeCompactPackageJSON(writer, field_value);
            } else {
                try writeCanonicalJSON(manager.allocator, writer, field_value);
            }
        }
        const optional_peers = if (all_peers_optional) blk: {
            const peers = value.object.get("peerDependencies") orelse break :blk try manager.allocator.alloc([]const u8, 0);
            if (peers != .object) break :blk try manager.allocator.alloc([]const u8, 0);
            break :blk try manager.allocator.dupe([]const u8, peers.object.keys());
        } else try optionalPeerNames(manager.allocator, value);
        defer manager.allocator.free(optional_peers);
        if (optional_peers.len > 0) {
            if (!first) try writer.writeAll(", ");
            try writeJSONString(writer, "optionalPeers");
            try writer.writeAll(": [");
            for (optional_peers, 0..) |name, index| {
                if (index > 0) try writer.writeAll(", ");
                try writeJSONString(writer, name);
            }
            try writer.writeByte(']');
        }
        try writer.writeByte('}');
    }

    fn writeTextLockfile(manager: *Manager, root: *Value, save_bun_lockfile: bool) !void {
        if (manager.options.frozen_lockfile and manager.changed) return error.FrozenLockfileChanged;
        if (save_bun_lockfile and
            !manager.options.save_yarn_lockfile and
            manager.binary_lockfile_needs_migration and
            !manager.changed and
            !manager.shouldSaveTextLockfile())
        {
            const binary_path = try std.fs.path.join(manager.allocator, &.{ manager.root_dir, "bun.lockb" });
            const previous = try std.Io.Dir.cwd().readFileAlloc(
                manager.init_data.io,
                binary_path,
                manager.allocator,
                .limited(256 * 1024 * 1024),
            );
            const upgraded = try BunLockfile.upgradeBinaryFormat(manager.allocator, previous);
            try std.Io.Dir.cwd().writeFile(manager.init_data.io, .{ .sub_path = binary_path, .data = upgraded });
            if (builtin.os.tag != .windows) {
                const permissions: std.Io.File.Permissions = @enumFromInt(0o755);
                try std.Io.Dir.cwd().setFilePermissions(manager.init_data.io, binary_path, permissions, .{});
            }
            if (!manager.options.silent and manager.options.command != .link) try manager.stderr.writeAll("Saved lockfile\n");
            return;
        }
        var output: std.Io.Writer.Allocating = .init(manager.allocator);
        const writer = &output.writer;
        try writer.print("{{\n  \"lockfileVersion\": 1,\n  \"configVersion\": {d},\n  \"workspaces\": {{\n    \"\": ", .{
            @intFromEnum(manager.lockfile_config_version),
        });
        try manager.writeWorkspaceInfo(writer, root, true, "");
        try writer.writeByte(',');
        var sorted_workspaces = std.array_list.Managed(Workspace).init(manager.allocator);
        defer sorted_workspaces.deinit();
        var workspace_iterator = manager.workspaces.iterator();
        while (workspace_iterator.next()) |entry| {
            if (manager.workspaceHasRecord(entry.value_ptr.*)) {
                try sorted_workspaces.append(entry.value_ptr.*);
            }
        }
        std.sort.pdq(Workspace, sorted_workspaces.items, {}, struct {
            fn lessThan(_: void, left: Workspace, right: Workspace) bool {
                return std.mem.order(u8, left.path, right.path) == .lt;
            }
        }.lessThan);
        for (sorted_workspaces.items) |workspace| {
            const path = try manager.relativeLockPath(workspace.path);
            try writer.writeAll("\n    ");
            try writeJSONString(writer, path);
            try writer.writeAll(": ");
            try manager.writeWorkspaceInfo(writer, workspace.package_json, false, path);
            try writer.writeByte(',');
        }
        try writer.writeAll("\n  }");
        try manager.manifest_policy.?.writeLockFields(writer);
        try writer.writeAll(",\n  \"packages\": {");
        const records = try manager.allocator.dupe(PackageRecord, manager.records.items);
        defer manager.allocator.free(records);
        for (records, 0..) |*record, index| {
            const alias_is_unique = lockRecordAliasIsUnique(records, index);
            if (alias_is_unique and
                (record.kind == .workspace or !packageRecordIsBundled(record.*)))
            {
                record.key = record.alias;
            }
        }
        std.sort.pdq(PackageRecord, records, {}, struct {
            fn lessThan(_: void, left: PackageRecord, right: PackageRecord) bool {
                const left_key = if (left.key.len > 0) left.key else left.alias;
                const right_key = if (right.key.len > 0) right.key else right.alias;
                const key_order = std.mem.order(u8, left_key, right_key);
                if (key_order != .eq) return key_order == .lt;
                const alias_order = std.mem.order(u8, left.alias, right.alias);
                if (alias_order != .eq) return alias_order == .lt;
                const name_order = std.mem.order(u8, left.name, right.name);
                if (name_order != .eq) return name_order == .lt;
                return std.mem.order(u8, left.version, right.version) == .lt;
            }
        }.lessThan);
        var written_records: usize = 0;
        for (records, 0..) |record, index| {
            if (index > 0 and
                std.mem.eql(u8, recordLogicalKey(record), recordLogicalKey(records[index - 1])) and
                packageRecordsHaveSameIdentity(record, records[index - 1]))
            {
                continue;
            }
            try writer.writeAll(if (written_records == 0) "\n    " else ",\n\n    ");
            try manager.linkRecordMetadata(writer, record);
            written_records += 1;
        }
        if (written_records > 0) try writer.writeByte(',');
        try writer.writeAll("\n  }\n}\n");

        if (manager.init_data.environ_map.get("COTTONTAIL_PM_ERROR_TRACE") != null) {
            try manager.stderr.writeAll("--- generated bun.lock ---\n");
            try manager.stderr.writeAll(output.written());
            try manager.stderr.writeAll("--- end generated bun.lock ---\n");
        }

        if (save_bun_lockfile) {
            const save_text = manager.shouldSaveTextLockfile();
            const text_path = try std.fs.path.join(manager.allocator, &.{ manager.root_dir, "bun.lock" });
            const binary_path = try std.fs.path.join(manager.allocator, &.{ manager.root_dir, "bun.lockb" });
            const binary = BunLockfile.textToBinaryAtRoot(
                manager.allocator,
                output.written(),
                manager.init_data.io,
                manager.root_dir,
            ) catch |err| return err;
            if (save_text) {
                const canonical_text = try BunLockfile.binaryToText(manager.allocator, binary);
                try std.Io.Dir.cwd().writeFile(manager.init_data.io, .{ .sub_path = text_path, .data = canonical_text });
                std.Io.Dir.cwd().deleteFile(manager.init_data.io, binary_path) catch {};
            } else {
                try std.Io.Dir.cwd().writeFile(manager.init_data.io, .{ .sub_path = binary_path, .data = binary });
                if (builtin.os.tag != .windows) {
                    const permissions: std.Io.File.Permissions = @enumFromInt(0o755);
                    try std.Io.Dir.cwd().setFilePermissions(manager.init_data.io, binary_path, permissions, .{});
                }
                std.Io.Dir.cwd().deleteFile(manager.init_data.io, text_path) catch {};
            }
            if (!manager.options.silent and manager.options.command != .link) try manager.stderr.writeAll("Saved lockfile\n");
        }
        if (manager.options.save_yarn_lockfile) try manager.writeYarnLockfile(output.written());
    }

    fn shouldSaveTextLockfile(manager: *const Manager) bool {
        if (manager.loaded_text_lockfile) return true;
        if (manager.loaded_binary_lockfile) return manager.save_text_lockfile_configured and manager.save_text_lockfile;
        return manager.save_text_lockfile;
    }

    fn writeYarnLockfile(manager: *Manager, text_lockfile: []const u8) !void {
        var output: std.Io.Writer.Allocating = .init(manager.allocator);
        defer output.deinit();
        try BunLockfile.writeYarnFromText(manager.allocator, text_lockfile, &output.writer);
        try output.writer.flush();
        const yarn_path = try std.fs.path.join(manager.allocator, &.{ manager.root_dir, "yarn.lock" });
        try std.Io.Dir.cwd().writeFile(manager.init_data.io, .{ .sub_path = yarn_path, .data = output.written() });
        if (!manager.options.silent) try manager.stderr.writeAll("Saved yarn.lock\n");
    }

    fn lockfileNeedsRewrite(manager: *const Manager) bool {
        return manager.binary_lockfile_needs_migration or
            (manager.loaded_binary_lockfile and manager.shouldSaveTextLockfile());
    }

    fn writeWorkspaceInfo(
        manager: *Manager,
        writer: *std.Io.Writer,
        package_json: *const Value,
        is_root: bool,
        lock_path: []const u8,
    ) !void {
        try writer.writeByte('{');
        var wrote_field = false;
        const workspace_json = if (manager.lock_graph) |*graph|
            if (graph.provenance == .pnpm and manager.omit_pnpm_workspace_versions)
                graph.workspaces.get(lock_path) orelse package_json
            else
                package_json
        else
            package_json;
        const name = if (is_root and manager.lock_graph != null and manager.lock_graph.?.provenance == .bun_text)
            jsonString(manager.lock_graph.?.root_workspace, "name") orelse jsonString(package_json, "name")
        else
            jsonString(workspace_json, "name");
        if (name) |workspace_name| {
            try writer.writeAll("\n      \"name\": ");
            try writeJSONString(writer, workspace_name);
            try writer.writeByte(',');
            wrote_field = true;
        }
        if (workspace_json.* == .object) {
            if (!is_root) {
                for ([_][]const u8{ "version", "bin", "binDir" }) |field| {
                    if (std.mem.eql(u8, field, "version") and
                        manager.omit_pnpm_workspace_versions) continue;
                    const field_value = workspace_json.object.get(field) orelse continue;
                    try writer.print("\n      \"{s}\": ", .{field});
                    try writeCanonicalJSON(manager.allocator, writer, field_value);
                    try writer.writeByte(',');
                    wrote_field = true;
                }
                if (workspace_json.object.get("binDir") == null) {
                    if (workspace_json.object.get("directories")) |directories| {
                        if (directories == .object) {
                            if (directories.object.get("bin")) |bin_dir| {
                                if (bin_dir == .string) {
                                    try writer.writeAll("\n      \"binDir\": ");
                                    try writeJSONString(writer, bin_dir.string);
                                    try writer.writeByte(',');
                                    wrote_field = true;
                                }
                            }
                        }
                    }
                }
            }
            for (all_dependency_sections) |section_name| {
                const section = workspace_json.object.get(section_name) orelse continue;
                if (section != .object or section.object.count() == 0) continue;
                try writer.print("\n      \"{s}\": {{", .{section_name});
                const keys = try manager.allocator.dupe([]const u8, section.object.keys());
                std.mem.sort([]const u8, keys, {}, struct {
                    fn lessThan(_: void, left: []const u8, right: []const u8) bool {
                        return std.mem.order(u8, left, right) == .lt;
                    }
                }.lessThan);
                for (keys) |key| {
                    const value = section.object.get(key) orelse continue;
                    if (value != .string) continue;
                    try writer.writeAll("\n        ");
                    try writeJSONString(writer, key);
                    try writer.writeAll(": ");
                    try writeJSONString(writer, value.string);
                    try writer.writeByte(',');
                }
                try writer.writeAll("\n      },");
                wrote_field = true;
            }
            const optional_peers = try manager.lockfileOptionalPeerNames(workspace_json, is_root);
            defer manager.allocator.free(optional_peers);
            if (optional_peers.len > 0) {
                try writer.writeAll("\n      \"optionalPeers\": [");
                for (optional_peers) |peer_name| {
                    try writer.writeAll("\n        ");
                    try writeJSONString(writer, peer_name);
                    try writer.writeByte(',');
                }
                try writer.writeAll("\n      ],");
                wrote_field = true;
            }
        }
        if (wrote_field) try writer.writeAll("\n    }") else try writer.writeByte('}');
    }

    fn lockfileOptionalPeerNames(
        manager: *Manager,
        package_json: *const Value,
        is_root: bool,
    ) ![][]const u8 {
        if (package_json.* != .object) return manager.allocator.alloc([]const u8, 0);
        const peers = package_json.object.get("peerDependencies") orelse return manager.allocator.alloc([]const u8, 0);
        if (peers != .object) return manager.allocator.alloc([]const u8, 0);

        const workspace_name = if (is_root) null else jsonString(package_json, "name");
        var names = std.array_list.Managed([]const u8).init(manager.allocator);
        errdefer names.deinit();
        for (peers.object.keys()) |name| {
            if (peerDependencyIsOptional(package_json, name) or
                !try manager.lockfileHasPeerResolution(name, workspace_name))
            {
                try names.append(name);
            }
        }
        std.mem.sort([]const u8, names.items, {}, struct {
            fn lessThan(_: void, left: []const u8, right: []const u8) bool {
                return std.mem.order(u8, left, right) == .lt;
            }
        }.lessThan);
        return names.toOwnedSlice();
    }

    fn lockfileHasPeerResolution(
        manager: *Manager,
        alias: []const u8,
        workspace_name: ?[]const u8,
    ) !bool {
        if (workspace_name) |name| {
            const workspace_key = try logicalDependencyKey(manager.allocator, name, alias);
            defer manager.allocator.free(workspace_key);
            for (manager.records.items) |record| {
                if (std.mem.eql(u8, recordLogicalKey(record), workspace_key)) return true;
            }
        }
        for (manager.records.items) |record| {
            if (std.mem.eql(u8, recordLogicalKey(record), alias)) return true;
        }
        return false;
    }

    fn deleteLockfiles(manager: *Manager) void {
        const text_path = std.fs.path.join(manager.allocator, &.{ manager.root_dir, "bun.lock" }) catch return;
        const binary_path = std.fs.path.join(manager.allocator, &.{ manager.root_dir, "bun.lockb" }) catch return;
        std.Io.Dir.cwd().deleteFile(manager.init_data.io, text_path) catch {};
        std.Io.Dir.cwd().deleteFile(manager.init_data.io, binary_path) catch {};
    }

    fn hasExistingLockfile(manager: *Manager) bool {
        const text_path = std.fs.path.join(manager.allocator, &.{ manager.root_dir, "bun.lock" }) catch return false;
        if (std.Io.Dir.cwd().access(manager.init_data.io, text_path, .{})) |_| return true else |_| {}
        const binary_path = std.fs.path.join(manager.allocator, &.{ manager.root_dir, "bun.lockb" }) catch return false;
        if (std.Io.Dir.cwd().access(manager.init_data.io, binary_path, .{})) |_| return true else |_| return false;
    }
};

const OutdatedBorder = enum { top, middle, bottom };

fn sameOutdatedCatalog(left: OutdatedPackage, right: OutdatedPackage) bool {
    const left_catalog = left.catalog_name orelse return false;
    const right_catalog = right.catalog_name orelse return false;
    return std.mem.eql(u8, left.alias, right.alias) and
        std.mem.eql(u8, left.dependency_type, right.dependency_type) and
        std.mem.eql(u8, left_catalog, right_catalog);
}

fn outdatedDependencySuffix(dependency_type: []const u8) []const u8 {
    if (std.mem.eql(u8, dependency_type, "devDependencies")) return " (dev)";
    if (std.mem.eql(u8, dependency_type, "peerDependencies")) return " (peer)";
    if (std.mem.eql(u8, dependency_type, "optionalDependencies")) return " (optional)";
    return "";
}

fn writeOutdatedBorder(
    writer: *std.Io.Writer,
    widths: []const usize,
    ansi: bool,
    border: OutdatedBorder,
) !void {
    if (!ansi and border != .middle) {
        var total: usize = widths.len - 1;
        for (widths) |width| total += width + 2;
        try writer.writeByte('|');
        try writer.splatByteAll('-', total);
        try writer.writeAll("|\n");
        return;
    }

    const left = if (!ansi)
        "|"
    else switch (border) {
        .top => "\xe2\x94\x8c",
        .middle => "\xe2\x94\x9c",
        .bottom => "\xe2\x94\x94",
    };
    const join = if (!ansi)
        "|"
    else switch (border) {
        .top => "\xe2\x94\xac",
        .middle => "\xe2\x94\xbc",
        .bottom => "\xe2\x94\xb4",
    };
    const right = if (!ansi)
        "|"
    else switch (border) {
        .top => "\xe2\x94\x90",
        .middle => "\xe2\x94\xa4",
        .bottom => "\xe2\x94\x98",
    };
    const horizontal = if (ansi) "\xe2\x94\x80" else "-";

    try writer.writeAll(left);
    for (widths, 0..) |width, index| {
        for (0..width + 2) |_| try writer.writeAll(horizontal);
        try writer.writeAll(if (index + 1 == widths.len) right else join);
    }
    try writer.writeByte('\n');
}

fn writeOutdatedCellStart(writer: *std.Io.Writer, ansi: bool) !void {
    try writer.writeAll(if (ansi) "\xe2\x94\x82 " else "| ");
}

fn writeOutdatedRowEnd(writer: *std.Io.Writer, ansi: bool) !void {
    try writer.writeAll(if (ansi) "\xe2\x94\x82\n" else "|\n");
}

fn writeOutdatedVersion(
    writer: *std.Io.Writer,
    current: []const u8,
    value: []const u8,
    filtered: bool,
    ansi: bool,
) !void {
    if (!ansi) {
        try writer.writeAll(value);
        if (filtered) try writer.writeAll(" *");
        return;
    }

    if (std.mem.eql(u8, current, value)) {
        try writer.print("\x1b[2m{s}\x1b[0m", .{value});
    } else {
        var common: usize = 0;
        while (common < current.len and common < value.len and current[common] == value[common]) : (common += 1) {}
        if (common > 0) {
            try writer.print("\x1b[2m{s}\x1b[0m", .{value[0..common]});
        } else {
            try writer.writeAll("\x1b[0m");
        }
        try writer.print("\x1b[1m\x1b[31m{s}\x1b[0m", .{value[common..]});
    }
    if (filtered) try writer.writeAll(" \x1b[34m*\x1b[0m");
}

fn splitPackageSpec(input: []const u8) PackageSpec {
    if (std.mem.startsWith(u8, input, "@")) {
        const slash = std.mem.indexOfScalar(u8, input, '/') orelse return .{ .name = input, .spec = "latest" };
        if (std.mem.indexOfScalarPos(u8, input, slash + 1, '@')) |at| {
            return .{ .name = input[0..at], .spec = if (at + 1 < input.len) input[at + 1 ..] else "latest" };
        }
        return .{ .name = input, .spec = "latest" };
    }
    if (std.mem.indexOfScalar(u8, input, '@')) |at| {
        if (at > 0 and at + 1 < input.len and isExplicitNamedSourceSpecifier(input[at + 1 ..])) {
            return .{ .name = input[0..at], .spec = input[at + 1 ..] };
        }
    }
    if (isGitSpec(input) or isTarballSpec(input) or isLocalSpec(input) or std.mem.startsWith(u8, input, "http://") or std.mem.startsWith(u8, input, "https://")) {
        return .{ .name = null, .spec = input };
    }
    if (std.mem.indexOfScalar(u8, input, '@')) |at| {
        if (at > 0) return .{ .name = input[0..at], .spec = if (at + 1 < input.len) input[at + 1 ..] else "latest" };
    }
    return .{ .name = input, .spec = "latest" };
}

fn isExplicitNamedSourceSpecifier(spec: []const u8) bool {
    return isTarballSpec(spec) or isLocalSpec(spec) or
        std.mem.startsWith(u8, spec, "github:") or
        std.mem.startsWith(u8, spec, "bitbucket:") or
        std.mem.startsWith(u8, spec, "gitlab:") or
        std.mem.startsWith(u8, spec, "gist:") or
        std.mem.startsWith(u8, spec, "sourcehut:") or
        std.mem.startsWith(u8, spec, "git+") or
        std.mem.startsWith(u8, spec, "git://") or
        std.mem.startsWith(u8, spec, "ssh://") or
        std.mem.startsWith(u8, spec, "git@") or
        std.mem.startsWith(u8, spec, "workspace:") or
        std.mem.startsWith(u8, spec, "patch:");
}

fn packageSpecHasExplicitSpecifier(input: []const u8) bool {
    if (std.mem.startsWith(u8, input, "@")) {
        const slash = std.mem.indexOfScalar(u8, input, '/') orelse return false;
        return std.mem.indexOfScalarPos(u8, input, slash + 1, '@') != null;
    }
    return if (std.mem.indexOfScalar(u8, input, '@')) |at| at > 0 else false;
}

fn findUpdateRequest(requests: []const UpdateRequest, alias: []const u8) ?*const UpdateRequest {
    for (requests) |*request| {
        const request_alias = request.alias orelse continue;
        if (std.mem.eql(u8, request_alias, alias)) return request;
    }
    return null;
}

fn interactiveRequestContains(requests: []const []const u8, alias: []const u8) bool {
    for (requests) |request| {
        const parsed = splitPackageSpec(request);
        if (parsed.name) |name| {
            if (std.mem.eql(u8, name, alias)) return true;
        }
    }
    return false;
}

fn outdatedRequestContains(requests: []const []const u8, alias: []const u8) bool {
    for (requests) |request| {
        const pattern = splitPackageSpec(request).name orelse continue;
        if (Workspaces.globMatch(pattern, alias)) return true;
    }
    return false;
}

fn interactiveDependencyPriority(dependency_type: []const u8) u8 {
    if (std.mem.eql(u8, dependency_type, "dependencies")) return 0;
    if (std.mem.eql(u8, dependency_type, "devDependencies")) return 1;
    if (std.mem.eql(u8, dependency_type, "peerDependencies")) return 2;
    if (std.mem.eql(u8, dependency_type, "optionalDependencies")) return 3;
    return 4;
}

fn isNativeSourceSpecifier(spec: []const u8) bool {
    const trimmed = std.mem.trim(u8, spec, " \t\r\n");
    return isGitSpec(trimmed) or isTarballSpec(trimmed) or isLocalSpec(trimmed) or
        std.mem.startsWith(u8, trimmed, "workspace:") or
        std.mem.startsWith(u8, trimmed, "patch:");
}

fn isRegistryUpdateSpecifier(spec: []const u8) bool {
    const trimmed = std.mem.trim(u8, spec, " \t\r\n");
    if (std.mem.startsWith(u8, trimmed, "npm:") or std.mem.startsWith(u8, trimmed, "catalog:")) return true;
    if (std.mem.startsWith(u8, trimmed, "workspace:") or
        std.mem.startsWith(u8, trimmed, "patch:") or
        std.mem.startsWith(u8, trimmed, "http://") or
        std.mem.startsWith(u8, trimmed, "https://")) return false;
    return !isLocalSpec(trimmed) and !isGitSpec(trimmed) and !isTarballSpec(trimmed) and !hasUnknownURLScheme(trimmed);
}

fn shouldUpdateRegistrySpec(
    original_spec: []const u8,
    requested: bool,
    latest: bool,
    request: ?*const UpdateRequest,
) bool {
    if (request) |value| {
        if (value.spec) |requested_spec| return isRegistryUpdateSpecifier(requested_spec);
    }
    if (!isRegistryUpdateSpecifier(original_spec)) return false;
    if (std.mem.startsWith(u8, original_spec, "catalog:")) return true;
    const parsed_alias = parseNpmAlias("", original_spec);
    const range = parsed_alias[1];
    return requested or latest or !Semver.Version.isTaggedVersionOnly(range);
}

fn npmAliasPrefix(spec: []const u8) ?[]const u8 {
    if (!std.mem.startsWith(u8, spec, "npm:")) return null;
    const parsed = splitPackageSpec(spec["npm:".len..]);
    const name = parsed.name orelse return null;
    return spec[0 .. "npm:".len + name.len];
}

fn updateResolutionSpec(
    allocator: std.mem.Allocator,
    original_spec: ?[]const u8,
    request: ?*const UpdateRequest,
    latest: bool,
) ![]const u8 {
    if (latest) {
        var alias_source = original_spec;
        if (request) |value| {
            if (value.spec) |requested_spec| {
                if (npmAliasPrefix(requested_spec) != null) alias_source = requested_spec;
            }
        }
        if (alias_source) |source| {
            if (npmAliasPrefix(source)) |prefix| return std.fmt.allocPrint(allocator, "{s}@latest", .{prefix});
        }
        return "latest";
    }
    if (request) |value| {
        if (value.spec) |requested_spec| {
            if (npmAliasPrefix(requested_spec) != null) return requested_spec;
            if (original_spec) |original| {
                if (npmAliasPrefix(original)) |prefix| {
                    return std.fmt.allocPrint(allocator, "{s}@{s}", .{ prefix, requested_spec });
                }
            }
            return requested_spec;
        }
    }
    return original_spec orelse "latest";
}

fn formatUpdatedRegistrySpec(
    allocator: std.mem.Allocator,
    alias: []const u8,
    original_spec: ?[]const u8,
    resolution_spec: []const u8,
    resolved_version: []const u8,
    request_had_explicit_spec: bool,
    exact: bool,
) ![]const u8 {
    if (original_spec) |original| {
        if (std.mem.startsWith(u8, original, "catalog:") and !request_had_explicit_spec) return original;
    }

    const pin_source = if (original_spec) |original|
        parseNpmAlias(alias, original)[1]
    else
        parseNpmAlias(alias, resolution_spec)[1];
    const version_spec = if (exact)
        resolved_version
    else switch (Semver.Version.whichVersionIsPinned(pin_source)) {
        .patch => resolved_version,
        .minor => try std.fmt.allocPrint(allocator, "~{s}", .{resolved_version}),
        .major => try std.fmt.allocPrint(allocator, "^{s}", .{resolved_version}),
    };

    var alias_prefix = npmAliasPrefix(resolution_spec);
    if (alias_prefix == null) {
        if (original_spec) |original| alias_prefix = npmAliasPrefix(original);
    }
    if (alias_prefix) |prefix| return std.fmt.allocPrint(allocator, "{s}@{s}", .{ prefix, version_spec });
    return version_spec;
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
    return std.mem.eql(u8, spec, ".") or
        std.mem.startsWith(u8, spec, "file:") or
        std.mem.startsWith(u8, spec, "link:") or
        std.mem.startsWith(u8, spec, "./") or
        std.mem.startsWith(u8, spec, "../") or
        std.fs.path.isAbsolute(spec);
}

fn isGlobalLinkSpec(spec: []const u8) bool {
    if (!std.mem.startsWith(u8, spec, "link:")) return false;
    const target = spec["link:".len..];
    return target.len > 0 and
        !std.mem.eql(u8, target, ".") and
        !std.mem.startsWith(u8, target, "./") and
        !std.mem.startsWith(u8, target, "../") and
        !std.mem.startsWith(u8, target, ".\\") and
        !std.mem.startsWith(u8, target, "..\\") and
        !std.fs.path.isAbsolute(target);
}

fn isValidGlobalLinkName(name: []const u8) bool {
    return compiler.strings.isNPMPackageName(name);
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

fn directLocalDisplay(spec: []const u8) []const u8 {
    const path = localSpecPath(spec);
    if (std.fs.path.isAbsolute(path)) return std.fs.path.basename(path);
    return if (std.mem.startsWith(u8, path, "./")) path[2..] else path;
}

fn isTarballSpec(spec: []const u8) bool {
    return std.mem.endsWith(u8, spec, ".tgz") or
        std.mem.endsWith(u8, spec, ".tar.gz") or
        ((std.mem.startsWith(u8, spec, "http://") or std.mem.startsWith(u8, spec, "https://")) and
            !isGitSpec(spec));
}

fn isRemoteTarballSpec(spec: []const u8) bool {
    return isTarballSpec(spec) and
        (std.mem.startsWith(u8, spec, "http://") or std.mem.startsWith(u8, spec, "https://"));
}

fn isGitSpec(spec: []const u8) bool {
    if (std.mem.startsWith(u8, spec, "github:") or
        std.mem.startsWith(u8, spec, "bitbucket:") or
        std.mem.startsWith(u8, spec, "gitlab:") or
        std.mem.startsWith(u8, spec, "gist:") or
        std.mem.startsWith(u8, spec, "sourcehut:") or
        std.mem.startsWith(u8, spec, "git+") or
        std.mem.startsWith(u8, spec, "git://") or
        std.mem.startsWith(u8, spec, "ssh://") or
        std.mem.startsWith(u8, spec, "git@")) return true;
    if (std.mem.indexOf(u8, spec, "github.com/") != null and std.mem.indexOf(u8, spec, "/tarball/") == null) return true;
    if (std.mem.indexOfScalar(u8, spec, ':')) |colon| {
        const authority = spec[0..colon];
        const path = spec[colon + 1 ..];
        if (authority.len > 0 and
            path.len > 0 and
            std.mem.indexOfScalar(u8, authority, '/') == null and
            (std.mem.indexOfScalar(u8, authority, '@') != null or std.mem.indexOfScalar(u8, authority, '.') != null) and
            std.mem.indexOfScalar(u8, path, '/') != null)
        {
            return true;
        }
    }
    if (spec.len == 0 or spec[0] == '@' or std.mem.startsWith(u8, spec, "./") or std.mem.startsWith(u8, spec, "../")) return false;
    const without_fragment = if (std.mem.indexOfScalar(u8, spec, '#')) |hash| spec[0..hash] else spec;
    const slash = std.mem.indexOfScalar(u8, without_fragment, '/') orelse return false;
    return slash > 0 and slash + 1 < without_fragment.len and
        std.mem.indexOfScalarPos(u8, without_fragment, slash + 1, '/') == null and
        std.mem.indexOfScalar(u8, without_fragment, '@') == null and
        std.mem.indexOfScalar(u8, without_fragment, ':') == null;
}

fn displayGitResolution(allocator: std.mem.Allocator, source: []const u8) ![]const u8 {
    if (!std.mem.startsWith(u8, source, "github:")) return source;
    const hash = std.mem.lastIndexOfScalar(u8, source, '#') orelse return source;
    const commit = source[hash + 1 ..];
    if (commit.len <= 7) return source;
    for (commit) |byte| if (!std.ascii.isHex(byte)) return source;
    return std.fmt.allocPrint(allocator, "{s}#{s}", .{ source[0..hash], commit[0..7] });
}

fn gitRepositoryName(spec: Git.Spec) ?[]const u8 {
    var source = std.mem.trimEnd(u8, spec.lock_prefix, "/");
    const separator = std.mem.lastIndexOfAny(u8, source, "/:") orelse return null;
    if (separator + 1 >= source.len) return null;
    source = source[separator + 1 ..];
    if (std.mem.endsWith(u8, source, ".git")) source = source[0 .. source.len - ".git".len];
    return if (source.len > 0) source else null;
}

fn gitCacheFolderName(allocator: std.mem.Allocator, spec: Git.Spec, requested: []const u8, commit: []const u8) ![]const u8 {
    const abbreviated = commit[0..@min(commit.len, 7)];
    if (spec.kind == .github) {
        const prefix = "https://github.com/";
        if (std.mem.startsWith(u8, spec.clone_url, prefix)) {
            var path = spec.clone_url[prefix.len..];
            if (std.mem.endsWith(u8, path, ".git")) path = path[0 .. path.len - ".git".len];
            if (std.mem.indexOfScalar(u8, path, '/')) |slash| {
                return std.fmt.allocPrint(allocator, "@GH@{s}-{s}-{s}@@@1", .{
                    path[0..slash],
                    path[slash + 1 ..],
                    abbreviated,
                });
            }
        }
    }
    var clone_identity = if (std.mem.indexOfScalar(u8, requested, '#')) |fragment| requested[0..fragment] else requested;
    if (std.mem.startsWith(u8, clone_identity, "git+ssh://")) {
        const scp_identity = clone_identity["git+ssh://".len..];
        if (std.mem.indexOfScalar(u8, scp_identity, '@') != null and
            std.mem.indexOfScalar(u8, scp_identity, ':') != null)
        {
            clone_identity = scp_identity;
        } else {
            clone_identity = clone_identity["git+".len..];
        }
    } else if (std.mem.startsWith(u8, clone_identity, "git+")) {
        clone_identity = clone_identity["git+".len..];
    }
    var hasher = compiler.Wyhash11.init(0);
    hasher.update(clone_identity);
    const task_id = (@as(u64, 4) << 61) | @as(u64, @as(u61, @truncate(hasher.final())));
    return std.fmt.allocPrint(allocator, "{x}.git", .{task_id});
}

fn gitCacheAliasName(cache_name: []const u8) []const u8 {
    if (std.mem.startsWith(u8, cache_name, "@GH@")) return cache_name["@GH@".len..];
    if (std.mem.startsWith(u8, cache_name, "@G@")) return cache_name["@G@".len..];
    return cache_name;
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

const InstallProject = struct {
    root_dir: []const u8,
    package_dir: []const u8,
};

fn findInstallProject(io: std.Io, allocator: std.mem.Allocator, start: []const u8) !InstallProject {
    var current = try allocator.dupe(u8, start);
    var maybe_package_dir: ?[]const u8 = null;
    while (true) {
        const package_json_path = try std.fs.path.join(allocator, &.{ current, "package.json" });
        if (std.Io.Dir.cwd().access(io, package_json_path, .{})) |_| {
            maybe_package_dir = current;
            break;
        } else |_| {}
        const parent = std.fs.path.dirname(current) orelse break;
        if (std.mem.eql(u8, parent, current)) break;
        current = try allocator.dupe(u8, parent);
    }
    const package_dir = maybe_package_dir orelse return .{ .root_dir = start, .package_dir = start };

    current = if (std.fs.path.dirname(package_dir)) |parent|
        try allocator.dupe(u8, parent)
    else
        return .{ .root_dir = package_dir, .package_dir = package_dir };
    while (true) {
        const package_json_path = try std.fs.path.join(allocator, &.{ current, "package.json" });
        const source = std.Io.Dir.cwd().readFileAlloc(
            io,
            package_json_path,
            allocator,
            .limited(64 * 1024 * 1024),
        ) catch null;
        if (source) |contents| {
            const manifest = PackageJSON.parsePackageJSON(allocator, package_json_path, contents) catch null;
            if (manifest) |value| {
                if (value == .object) {
                    const relative = try std.fs.path.relative(allocator, current, null, current, package_dir);
                    if (Workspaces.matchesManifestPath(allocator, &value, relative) catch false) {
                        return .{ .root_dir = current, .package_dir = package_dir };
                    }
                }
            }
        }

        const parent = std.fs.path.dirname(current) orelse break;
        if (std.mem.eql(u8, parent, current)) break;
        current = try allocator.dupe(u8, parent);
    }
    return .{ .root_dir = package_dir, .package_dir = package_dir };
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

fn packageBinDirectory(metadata: *const Value) ?[]const u8 {
    if (metadata.* != .object) return null;
    if (metadata.object.get("binDir")) |bin_dir| {
        if (bin_dir == .string) return bin_dir.string;
    }
    const directories = metadata.object.get("directories") orelse return null;
    if (directories != .object) return null;
    const bin_dir = directories.object.get("bin") orelse return null;
    return if (bin_dir == .string) bin_dir.string else null;
}

fn normalizedBinName(name: []const u8) []const u8 {
    if (std.mem.lastIndexOfAny(u8, name, "/\\:")) |index| return name[index + 1 ..];
    return name;
}

fn normalizedBinObjectName(name: []const u8) []const u8 {
    if (builtin.os.tag == .windows or name.len == 0 or std.fs.path.isAbsolute(name) or
        std.mem.indexOfAny(u8, name, "\\:") != null)
    {
        return normalizedBinName(name);
    }
    var segments = std.mem.splitScalar(u8, name, '/');
    while (segments.next()) |segment| {
        if (segment.len == 0 or std.mem.eql(u8, segment, ".") or std.mem.eql(u8, segment, "..")) {
            return normalizedBinName(name);
        }
    }
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

fn packageSupportsPlatform(
    metadata: *const Value,
    cpu_target: Npm.Architecture,
    os_target: Npm.OperatingSystem,
) bool {
    if (metadata.* != .object) return true;
    if (metadata.object.get("os")) |os| {
        if (!platformSetFromJson(Npm.OperatingSystem, os).isMatch(os_target)) return false;
    }
    if (metadata.object.get("cpu")) |cpu| {
        if (!platformSetFromJson(Npm.Architecture, cpu).isMatch(cpu_target)) return false;
    }
    return true;
}

fn platformSetFromJson(comptime T: type, value: Value) T {
    var result = T.none.negatable();
    switch (value) {
        .string => |entry| applyPlatformMetadataEntry(T, &result, entry),
        .array => |entries| for (entries.items) |entry| {
            if (entry == .string) applyPlatformMetadataEntry(T, &result, entry.string);
        },
        else => {},
    }
    return result.combine();
}

fn applyPlatformMetadataEntry(comptime T: type, result: *Npm.Negatable(T), value: []const u8) void {
    if (std.mem.eql(u8, value, "*")) {
        result.had_wildcard = true;
        result.had_unrecognized_values = false;
    } else {
        result.apply(value);
    }
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
    if (try readOptionalFile(init.io, allocator, ".npmrc", 1024 * 1024)) |raw| {
        const source = try decodeConfigText(allocator, raw);
        if (parseNpmrcValue(source, "cache")) |cache| return allocator.dupe(u8, cache);
    }
    if (init.environ_map.get("XDG_CACHE_HOME")) |home| return std.fs.path.join(allocator, &.{ home, ".bun", "install", "cache" });
    if (init.environ_map.get("HOME")) |home| return std.fs.path.join(allocator, &.{ home, ".bun", "install", "cache" });
    return absolutePath(init.io, allocator, "node_modules/.cache");
}

fn globalLinkRootPath(init: std.process.Init, allocator: std.mem.Allocator) ![]const u8 {
    if (init.environ_map.get("BUN_INSTALL_GLOBAL_DIR")) |path| return allocator.dupe(u8, path);
    if (init.environ_map.get("BUN_INSTALL")) |home| return std.fs.path.join(allocator, &.{ home, "install", "global" });
    if (init.environ_map.get("XDG_CACHE_HOME") orelse init.environ_map.get("HOME")) |home| {
        return std.fs.path.join(allocator, &.{ home, ".bun", "install", "global" });
    }
    if (init.environ_map.get("USERPROFILE")) |home| {
        return std.fs.path.join(allocator, &.{ home, ".bun", "install", "global" });
    }
    return error.MissingGlobalLinkDirectory;
}

fn globalLinkNodeModulesPath(init: std.process.Init, allocator: std.mem.Allocator) ![]const u8 {
    return std.fs.path.join(allocator, &.{ try globalLinkRootPath(init, allocator), "node_modules" });
}

fn globalBinPath(init: std.process.Init, allocator: std.mem.Allocator) ![]const u8 {
    if (init.environ_map.get("BUN_INSTALL_BIN")) |path| return allocator.dupe(u8, path);
    if (init.environ_map.get("BUN_INSTALL")) |home| return std.fs.path.join(allocator, &.{ home, "bin" });
    if (init.environ_map.get("XDG_CACHE_HOME") orelse init.environ_map.get("HOME")) |home| {
        return std.fs.path.join(allocator, &.{ home, ".bun", "bin" });
    }
    if (init.environ_map.get("USERPROFILE")) |home| return std.fs.path.join(allocator, &.{ home, ".bun", "bin" });
    return error.MissingGlobalBinDirectory;
}

fn encodePackageName(allocator: std.mem.Allocator, name: []const u8) ![]const u8 {
    if (!std.mem.startsWith(u8, name, "@")) return allocator.dupe(u8, name);
    const slash = std.mem.indexOfScalar(u8, name, '/') orelse return allocator.dupe(u8, name);
    return std.fmt.allocPrint(allocator, "{s}%2f{s}", .{ name[0..slash], name[slash + 1 ..] });
}

fn normalizeRegistryVersion(allocator: std.mem.Allocator, version_value: []const u8) ![]const u8 {
    const parsed = Semver.Version.parseUTF8(version_value);
    if (!parsed.valid) return version_value;
    // COTTONTAIL-COMPAT: npm accepts loose manifest versions such as
    // `0.0.2rc1`; Bun stores and displays the canonical `0.0.2-rc1` form.
    return std.fmt.allocPrint(allocator, "{f}", .{parsed.version.min().fmt(version_value)});
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

fn semverRangeIsWildcard(allocator: std.mem.Allocator, range: []const u8) bool {
    const sliced = Semver.SlicedString.init(range, range);
    var query = Semver.Query.parse(allocator, range, sliced) catch return false;
    defer query.deinit();
    return query.@"is *"();
}

fn semverVersionLessThan(current: []const u8, latest: []const u8) bool {
    const current_parsed = Semver.Version.parseUTF8(current);
    const latest_parsed = Semver.Version.parseUTF8(latest);
    if (!current_parsed.valid or !latest_parsed.valid) return !std.mem.eql(u8, current, latest);
    return current_parsed.version.min().order(latest_parsed.version.min(), current, latest) == .lt;
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
    const decoded_len = std.base64.standard.Decoder.calcSizeForSlice(encoded) catch return;
    if (decoded_len != expected.len) return;
    _ = std.base64.standard.Decoder.decode(&expected, encoded) catch return;
    var actual: [64]u8 = undefined;
    std.crypto.hash.sha2.Sha512.hash(bytes, &actual, .{});
    if (!std.crypto.timing_safe.eql([64]u8, expected, actual)) return error.IntegrityCheckFailed;
}

const GithubArchiveIdentity = struct {
    root_name: []const u8,
    commit: []const u8,
};

fn githubArchiveIdentity(allocator: std.mem.Allocator, archive: []const u8) !?GithubArchiveIdentity {
    var compressed_reader: std.Io.Reader = .fixed(archive);
    var decompression_buffer: [std.compress.flate.max_window_len]u8 = undefined;
    var decompressor: std.compress.flate.Decompress = .init(&compressed_reader, .gzip, &decompression_buffer);
    var file_name_buffer: [std.fs.max_path_bytes]u8 = undefined;
    var link_name_buffer: [std.fs.max_path_bytes]u8 = undefined;
    var diagnostics: std.tar.Diagnostics = .{ .allocator = allocator };
    defer diagnostics.deinit();

    var iterator: std.tar.Iterator = .init(&decompressor.reader, .{
        .file_name_buffer = &file_name_buffer,
        .link_name_buffer = &link_name_buffer,
        .diagnostics = &diagnostics,
    });
    while (try iterator.next()) |entry| {
        var path = std.mem.trimStart(u8, entry.name, "./");
        if (path.len == 0) continue;
        const slash = std.mem.indexOfScalar(u8, path, '/') orelse path.len;
        path = path[0..slash];
        const separator = std.mem.lastIndexOfScalar(u8, path, '-') orelse return null;
        const commit = path[separator + 1 ..];
        if (commit.len < 7 or commit.len > 40) return null;
        for (commit) |byte| if (!std.ascii.isHex(byte)) return null;
        return .{
            .root_name = try allocator.dupe(u8, path),
            .commit = try allocator.dupe(u8, commit),
        };
    }
    return null;
}

pub fn extractTarballArchive(
    io: std.Io,
    allocator: std.mem.Allocator,
    destination: std.Io.Dir,
    archive: []const u8,
) !void {
    var compressed_reader: std.Io.Reader = .fixed(archive);
    var decompression_buffer: [std.compress.flate.max_window_len]u8 = undefined;
    var decompressor: std.compress.flate.Decompress = .init(&compressed_reader, .gzip, &decompression_buffer);
    var file_name_buffer: [std.fs.max_path_bytes]u8 = undefined;
    var link_name_buffer: [std.fs.max_path_bytes]u8 = undefined;
    var sanitized_path_buffer: [std.fs.max_path_bytes]u8 = undefined;
    var file_contents_buffer: [16 * 1024]u8 = undefined;
    var diagnostics: std.tar.Diagnostics = .{ .allocator = allocator };
    defer diagnostics.deinit();
    var symlink_paths = std.StringHashMap(void).init(allocator);
    defer symlink_paths.deinit();

    var iterator: std.tar.Iterator = .init(&decompressor.reader, .{
        .file_name_buffer = &file_name_buffer,
        .link_name_buffer = &link_name_buffer,
        .diagnostics = &diagnostics,
    });
    while (try iterator.next()) |entry| {
        const strip_components: u32 = if (std.mem.startsWith(u8, entry.name, "./")) 0 else 1;
        const path_len = sanitizeTarPath(&sanitized_path_buffer, entry.name, strip_components) catch continue;
        if (path_len == 0 and entry.kind != .directory) continue;
        const path = sanitized_path_buffer[0..path_len];
        var links = symlink_paths.keyIterator();
        while (links.next()) |link| {
            if (!std.mem.eql(u8, path, link.*) and pathHasPrefix(path, link.*)) return error.TarPathThroughSymlink;
        }
        _ = symlink_paths.remove(path);

        switch (entry.kind) {
            // npm extraction does not preserve empty directories. Parent
            // directories are materialized when a file or symlink needs them.
            .directory => {},
            .file => {
                try removeTarDestination(io, destination, path);
                if (std.fs.path.dirname(path)) |parent| try destination.createDirPath(io, parent);
                const permissions: std.Io.File.Permissions = if (std.Io.File.Permissions.has_executable_bit and (entry.mode & 0o100) != 0) .executable_file else .default_file;
                var file = try destination.createFile(io, path, .{ .truncate = true, .permissions = permissions });
                defer file.close(io);
                var file_writer = file.writer(io, &file_contents_buffer);
                try iterator.streamRemaining(entry, &file_writer.interface);
                try file_writer.interface.flush();
            },
            .sym_link => {
                if (!tarSymlinkTargetIsSafe(path, entry.link_name)) continue;
                try removeTarDestination(io, destination, path);
                if (std.fs.path.dirname(path)) |parent| try destination.createDirPath(io, parent);
                try destination.symLink(io, entry.link_name, path, .{});
                try symlink_paths.put(try allocator.dupe(u8, path), {});
            },
        }
    }

    for (diagnostics.errors.items) |problem| switch (problem) {
        .components_outside_stripped_prefix => {},
        .unable_to_create_file => |info| return info.code,
        .unable_to_create_sym_link => |info| return info.code,
        .unsupported_file_type => return error.TarUnsupportedHeader,
    };
}

fn tarSymlinkTargetIsSafe(path: []const u8, target: []const u8) bool {
    if (target.len == 0 or target[0] == '/' or target[0] == '\\') return false;
    if (target.len >= 2 and std.ascii.isAlphabetic(target[0]) and target[1] == ':') return false;

    var depth: usize = 0;
    const parent = if (std.mem.lastIndexOfScalar(u8, path, '/')) |slash| path[0..slash] else "";
    var parent_parts = std.mem.splitScalar(u8, parent, '/');
    while (parent_parts.next()) |component| {
        if (component.len > 0 and !std.mem.eql(u8, component, ".")) depth += 1;
    }

    var target_parts = std.mem.splitAny(u8, target, "/\\");
    while (target_parts.next()) |component| {
        if (component.len == 0 or std.mem.eql(u8, component, ".")) continue;
        if (std.mem.eql(u8, component, "..")) {
            if (depth == 0) return false;
            depth -= 1;
        } else {
            depth += 1;
        }
    }
    return true;
}

test "tar symlink targets stay inside the extracted package" {
    try std.testing.expect(tarSymlinkTargetIsSafe("package/link", "src"));
    try std.testing.expect(tarSymlinkTargetIsSafe("package/src/link", "../index.js"));
    try std.testing.expect(!tarSymlinkTargetIsSafe("package/link", "../../../tmp"));
    try std.testing.expect(!tarSymlinkTargetIsSafe("package/link", "/tmp"));
    try std.testing.expect(!tarSymlinkTargetIsSafe("package/link", "C:\\tmp"));
}

fn ensureTarDirectory(io: std.Io, directory: std.Io.Dir, path: []const u8) !void {
    const stat = directory.statFile(io, path, .{ .follow_symlinks = false }) catch |err| switch (err) {
        error.FileNotFound => {
            try directory.createDirPath(io, path);
            return;
        },
        else => return err,
    };
    if (stat.kind == .directory) return;
    try removeTarDestination(io, directory, path);
    try directory.createDirPath(io, path);
}

fn removeTarDestination(io: std.Io, directory: std.Io.Dir, path: []const u8) !void {
    const stat = directory.statFile(io, path, .{ .follow_symlinks = false }) catch |err| switch (err) {
        error.FileNotFound => return,
        else => return err,
    };
    if (stat.kind == .directory) {
        try directory.deleteTree(io, path);
    } else {
        try directory.deleteFile(io, path);
    }
}

pub fn sanitizeTarPath(buffer: []u8, path: []const u8, strip_components: u32) error{Invalid}!usize {
    if (path.len == 0 or path[0] == '/') return error.Invalid;
    if (builtin.os.tag == .windows and std.mem.indexOfAny(u8, path, "\\:") != null) return error.Invalid;

    var output_len: usize = 0;
    var components_to_strip = strip_components;
    var components = std.mem.tokenizeScalar(u8, path, '/');
    while (components.next()) |component| {
        if (std.mem.eql(u8, component, ".")) continue;
        if (std.mem.eql(u8, component, "..")) {
            if (output_len == 0) return error.Invalid;
            while (true) {
                const ends_with_slash = buffer[output_len - 1] == '/';
                output_len -= 1;
                if (ends_with_slash or output_len == 0) break;
            }
            continue;
        }
        if (components_to_strip > 0) {
            components_to_strip -= 1;
            continue;
        }
        const separator_len: usize = if (output_len > 0) 1 else 0;
        if (output_len + separator_len + component.len > buffer.len) return error.Invalid;
        if (separator_len == 1) {
            buffer[output_len] = '/';
            output_len += 1;
        }
        @memcpy(buffer[output_len..][0..component.len], component);
        output_len += component.len;
    }
    if (components_to_strip > 0) return error.Invalid;
    return output_len;
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

fn dependencySpecInSection(value: *const Value, section_name: []const u8, key: []const u8) ?[]const u8 {
    if (value.* != .object) return null;
    const section = value.object.get(section_name) orelse return null;
    if (section != .object) return null;
    const spec = section.object.get(key) orelse return null;
    return if (spec == .string) spec.string else null;
}

fn packageHasBundledDependencies(value: *const Value) bool {
    if (value.* != .object) return false;
    for ([_][]const u8{ "bundleDependencies", "bundledDependencies" }) |field_name| {
        const field = value.object.get(field_name) orelse continue;
        if (field == .bool and field.bool) return true;
        if (field == .array and field.array.items.len > 0) return true;
    }
    return false;
}

fn packageDependencyIsBundled(value: *const Value, alias: []const u8) bool {
    if (value.* != .object) return false;
    for ([_][]const u8{ "bundleDependencies", "bundledDependencies" }) |field_name| {
        const field = value.object.get(field_name) orelse continue;
        if (field == .bool and field.bool) return true;
        if (field != .array) continue;
        for (field.array.items) |entry| {
            if (entry == .string and std.mem.eql(u8, entry.string, alias)) return true;
        }
    }
    return false;
}

fn directInstallSectionPriority(section: []const u8) u8 {
    if (std.mem.eql(u8, section, "devDependencies")) return 0;
    if (std.mem.eql(u8, section, "optionalDependencies")) return 1;
    if (std.mem.eql(u8, section, "dependencies")) return 2;
    return 3;
}

fn recordLogicalKey(record: PackageRecord) []const u8 {
    return if (record.key.len > 0) record.key else record.alias;
}

fn lockRecordAliasIsUnique(records: []const PackageRecord, candidate_index: usize) bool {
    const candidate = records[candidate_index];
    for (records, 0..) |record, index| {
        if (index != candidate_index and
            std.mem.eql(u8, record.alias, candidate.alias) and
            !packageRecordsHaveSameIdentity(record, candidate)) return false;
    }
    return true;
}

fn packageRecordIsBundled(record: PackageRecord) bool {
    const metadata = record.metadata orelse return false;
    if (metadata.* != .object) return false;
    const bundled = metadata.object.get("bundled") orelse return false;
    return bundled == .bool and bundled.bool;
}

fn packageRecordsHaveSameIdentity(left: PackageRecord, right: PackageRecord) bool {
    if (left.kind != right.kind or
        !std.mem.eql(u8, left.name, right.name) or
        !std.mem.eql(u8, left.version, right.version)) return false;
    return switch (left.kind) {
        .npm => std.mem.eql(u8, left.tarball, right.tarball),
        .workspace, .folder, .symlink, .root => std.mem.eql(
            u8,
            if (left.local_path.len > 0) left.local_path else left.resolution,
            if (right.local_path.len > 0) right.local_path else right.resolution,
        ),
        .local_tarball, .remote_tarball, .git, .github => std.mem.eql(
            u8,
            if (left.resolution.len > 0) left.resolution else left.tarball,
            if (right.resolution.len > 0) right.resolution else right.tarball,
        ),
    };
}

fn logicalParentKey(record: PackageRecord) []const u8 {
    const key = recordLogicalKey(record);
    if (std.mem.eql(u8, key, record.alias)) return "";
    if (key.len <= record.alias.len or !std.mem.endsWith(u8, key, record.alias)) return "";
    const separator = key.len - record.alias.len - 1;
    if (key[separator] != '/') return "";
    return key[0..separator];
}

fn logicalDependencyKey(allocator: std.mem.Allocator, importer_key: []const u8, alias: []const u8) ![]const u8 {
    if (importer_key.len == 0) return allocator.dupe(u8, alias);
    return std.fmt.allocPrint(allocator, "{s}/{s}", .{ importer_key, alias });
}

fn ownedDependencySpec(value: *const Value, alias: []const u8) ?[]const u8 {
    return dependencySpec(value, alias, &mutable_dependency_sections);
}

fn runtimeDependencySpec(value: *const Value, alias: []const u8) ?[]const u8 {
    return dependencySpec(value, alias, &runtime_dependency_sections);
}

fn peerDependencySpec(value: *const Value, alias: []const u8) ?[]const u8 {
    if (value.* != .object) return null;
    const peers = value.object.get("peerDependencies") orelse return null;
    if (peers != .object) return null;
    const spec = peers.object.get(alias) orelse return null;
    return if (spec == .string) spec.string else null;
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

fn optionalPeerNames(allocator: std.mem.Allocator, value: *const Value) ![][]const u8 {
    if (value.* != .object) return allocator.alloc([]const u8, 0);
    const peers = value.object.get("peerDependencies") orelse return allocator.alloc([]const u8, 0);
    if (peers != .object) return allocator.alloc([]const u8, 0);

    var names = std.array_list.Managed([]const u8).init(allocator);
    errdefer names.deinit();
    for (peers.object.keys()) |name| {
        if (!peerDependencyIsOptional(value, name)) continue;
        try names.append(name);
    }
    std.mem.sort([]const u8, names.items, {}, struct {
        fn lessThan(_: void, left: []const u8, right: []const u8) bool {
            return std.mem.order(u8, left, right) == .lt;
        }
    }.lessThan);
    return names.toOwnedSlice();
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

fn removedDependencyCount(previous: *const Value, current: *const Value) usize {
    if (previous.* != .object or current.* != .object) return 0;
    var count: usize = 0;
    for (all_dependency_sections) |section_name| {
        const previous_section = previous.object.get(section_name) orelse continue;
        if (previous_section != .object) continue;
        const current_section = current.object.get(section_name);
        for (previous_section.object.keys()) |name| {
            if (current_section == null or
                current_section.? != .object or
                current_section.?.object.get(name) == null)
            {
                count += 1;
            }
        }
    }
    return count;
}

fn containsString(values: []const []const u8, needle: []const u8) bool {
    for (values) |value| if (std.mem.eql(u8, value, needle)) return true;
    return false;
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

fn appendUniqueName(list: *std.array_list.Managed([]const u8), name: []const u8) !void {
    for (list.items) |existing| {
        if (std.mem.eql(u8, existing, name)) return;
    }
    try list.append(name);
}

fn appendUniqueIndex(list: *std.array_list.Managed(usize), index: usize) !void {
    if (std.mem.indexOfScalar(usize, list.items, index) == null) try list.append(index);
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
    const indent = if (try readOptionalFile(io, allocator, path, 64 * 1024 * 1024)) |source|
        packageJSONIndent(source)
    else
        "  ";
    var output: std.Io.Writer.Allocating = .init(allocator);
    try writePrettyPackageJSON(&output.writer, value, indent, 0);
    if (trailing_newline) try output.writer.writeByte('\n');
    try std.Io.Dir.cwd().writeFile(io, .{ .sub_path = path, .data = output.written() });
}

fn packageJSONIndent(source: []const u8) []const u8 {
    var lines = std.mem.splitScalar(u8, source, '\n');
    while (lines.next()) |line| {
        const content = std.mem.trimStart(u8, line, " \t\r");
        if (content.len == line.len or content.len == 0 or content[0] != '"') continue;
        return line[0 .. line.len - content.len];
    }
    return "  ";
}

fn writeJSONIndent(writer: *std.Io.Writer, indent: []const u8, depth: usize) !void {
    for (0..depth) |_| try writer.writeAll(indent);
}

fn writePrettyPackageJSON(writer: *std.Io.Writer, value: Value, indent: []const u8, depth: usize) !void {
    switch (value) {
        .object => |object| {
            try writer.writeByte('{');
            for (object.keys(), object.values(), 0..) |key, item, index| {
                try writer.writeAll(if (index == 0) "\n" else ",\n");
                try writeJSONIndent(writer, indent, depth + 1);
                try writeJSONString(writer, key);
                try writer.writeAll(": ");
                try writePrettyPackageJSON(writer, item, indent, depth + 1);
            }
            if (object.count() > 0) {
                try writer.writeByte('\n');
                try writeJSONIndent(writer, indent, depth);
            }
            try writer.writeByte('}');
        },
        .array => |array| {
            try writer.writeByte('[');
            for (array.items, 0..) |item, index| {
                if (index > 0) try writer.writeAll(", ");
                try writeCompactPackageJSON(writer, item);
            }
            try writer.writeByte(']');
        },
        else => try std.json.Stringify.value(value, .{}, writer),
    }
}

fn writeCompactPackageJSON(writer: *std.Io.Writer, value: Value) !void {
    switch (value) {
        .array => |array| {
            try writer.writeByte('[');
            for (array.items, 0..) |item, index| {
                if (index > 0) try writer.writeAll(", ");
                try writeCompactPackageJSON(writer, item);
            }
            try writer.writeByte(']');
        },
        .object => |object| {
            try writer.writeByte('{');
            for (object.keys(), object.values(), 0..) |key, item, index| {
                if (index > 0) try writer.writeAll(", ");
                try writeJSONString(writer, key);
                try writer.writeAll(": ");
                try writeCompactPackageJSON(writer, item);
            }
            try writer.writeByte('}');
        },
        else => try std.json.Stringify.value(value, .{}, writer),
    }
}

fn writeJSONString(writer: *std.Io.Writer, value: []const u8) !void {
    try std.json.Stringify.value(value, .{}, writer);
}

fn writeCanonicalJSON(
    allocator: std.mem.Allocator,
    writer: *std.Io.Writer,
    value: Value,
) !void {
    switch (value) {
        .array => |array| {
            try writer.writeByte('[');
            for (array.items, 0..) |item, index| {
                if (index > 0) try writer.writeAll(", ");
                try writeCanonicalJSON(allocator, writer, item);
            }
            try writer.writeByte(']');
        },
        .object => |object| {
            const keys = try allocator.alloc([]const u8, object.count());
            @memcpy(keys, object.keys());
            std.mem.sort([]const u8, keys, {}, struct {
                fn lessThan(_: void, left: []const u8, right: []const u8) bool {
                    return std.mem.order(u8, left, right) == .lt;
                }
            }.lessThan);
            try writer.writeByte('{');
            for (keys, 0..) |key, index| {
                if (index > 0) try writer.writeAll(", ");
                try writeJSONString(writer, key);
                try writer.writeAll(": ");
                try writeCanonicalJSON(allocator, writer, object.get(key).?);
            }
            try writer.writeByte('}');
        },
        else => try std.json.Stringify.value(value, .{}, writer),
    }
}

fn packageJSONHasWorkspaces(package_json: *const Value) bool {
    if (package_json.* != .object) return false;
    const workspaces = package_json.object.get("workspaces") orelse return false;
    return switch (workspaces) {
        .array => |array| array.items.len > 0,
        .object => |object| if (object.get("packages")) |packages|
            packages == .array and packages.array.items.len > 0
        else
            false,
        else => false,
    };
}

fn deletePath(io: std.Io, path: []const u8) void {
    const stat = std.Io.Dir.cwd().statFile(io, path, .{ .follow_symlinks = false }) catch return;
    if (stat.kind == .directory) {
        std.Io.Dir.cwd().deleteTree(io, path) catch {};
    } else {
        std.Io.Dir.cwd().deleteFile(io, path) catch {};
    }
}

fn clonePackagePath(io: std.Io, allocator: std.mem.Allocator, source: []const u8, destination: []const u8) anyerror!void {
    const stat = try std.Io.Dir.cwd().statFile(io, source, .{ .follow_symlinks = false });
    switch (stat.kind) {
        .directory => try copyDirectoryTree(io, allocator, source, destination),
        .sym_link => {
            var target_buffer: [std.fs.max_path_bytes]u8 = undefined;
            const target_len = try std.Io.Dir.readLinkAbsolute(io, source, &target_buffer);
            if (std.fs.path.dirname(destination)) |parent| try std.Io.Dir.cwd().createDirPath(io, parent);
            const target_stat = std.Io.Dir.cwd().statFile(io, source, .{}) catch null;
            try std.Io.Dir.cwd().symLink(io, target_buffer[0..target_len], destination, .{
                .is_directory = target_stat != null and target_stat.?.kind == .directory,
            });
        },
        .file => try std.Io.Dir.copyFileAbsolute(source, destination, io, .{ .replace = true, .make_path = true }),
        else => return error.UnsupportedPackageStoreEntry,
    }
}

fn copyDirectoryTree(io: std.Io, allocator: std.mem.Allocator, source: []const u8, destination: []const u8) anyerror!void {
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
            .sym_link => try clonePackagePath(io, allocator, source_path, destination_path),
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
    const tarball_alias = splitPackageSpec("fixture@https://registry.example/fixture.tgz");
    try std.testing.expectEqualStrings("fixture", tarball_alias.name.?);
    try std.testing.expectEqualStrings("https://registry.example/fixture.tgz", tarball_alias.spec);
    const git_alias = splitPackageSpec("fixture@github:owner/repository");
    try std.testing.expectEqualStrings("fixture", git_alias.name.?);
    try std.testing.expectEqualStrings("github:owner/repository", git_alias.spec);
    const raw_git = splitPackageSpec("git@github.com:owner/repository.git");
    try std.testing.expect(raw_git.name == null);
    try std.testing.expectEqualStrings("git@github.com:owner/repository.git", raw_git.spec);
}

test "security scanner package metadata uses declared ranges" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    var root = try std.json.parseFromSliceLeaky(
        Value,
        arena.allocator(),
        "{\"dependencies\":{\"bar\":\"^0.0.2\"},\"devDependencies\":{\"tool\":\"latest\"}}",
        .{},
    );
    try std.testing.expectEqualStrings("^0.0.2", securityDependencyRequest(&root, "bar").?);
    try std.testing.expectEqualStrings("latest", securityDependencyRequest(&root, "tool").?);
    try std.testing.expect(securityDependencyRequest(&root, "missing") == null);
}

test "removed dependency count compares lockfile dependency edges" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const previous = try std.json.parseFromSliceLeaky(
        Value,
        arena.allocator(),
        "{\"dependencies\":{\"kept\":\"1.0.0\",\"moved\":\"1.0.0\"},\"devDependencies\":{\"removed\":\"1.0.0\"}}",
        .{},
    );
    const current = try std.json.parseFromSliceLeaky(
        Value,
        arena.allocator(),
        "{\"dependencies\":{\"kept\":\"2.0.0\"},\"devDependencies\":{\"moved\":\"1.0.0\"}}",
        .{},
    );
    try std.testing.expectEqual(@as(usize, 2), removedDependencyCount(&previous, &current));
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

test "install project selection promotes only declared workspace ancestors" {
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.createDirPath(io, "repo/packages/app/src");
    try tmp.dir.writeFile(io, .{
        .sub_path = "repo/package.json",
        .data = "{\"name\":\"repo\",\"workspaces\":[\"packages/*\"]}",
    });
    try tmp.dir.writeFile(io, .{
        .sub_path = "repo/packages/app/package.json",
        .data = "{\"name\":\"app\",\"version\":\"1.0.0\"}",
    });

    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    const relative_root = try std.fs.path.join(allocator, &.{ ".zig-cache", "tmp", &tmp.sub_path, "repo" });
    const root = try std.Io.Dir.cwd().realPathFileAlloc(io, relative_root, allocator);
    const workspace = try std.fs.path.join(allocator, &.{ root, "packages", "app" });
    const nested = try std.fs.path.join(allocator, &.{ workspace, "src" });
    const project = try findInstallProject(io, allocator, nested);
    try std.testing.expectEqualStrings(root, project.root_dir);
    try std.testing.expectEqualStrings(workspace, project.package_dir);

    try tmp.dir.writeFile(io, .{
        .sub_path = "repo/package.json",
        .data = "{\"name\":\"repo\",\"workspaces\":[\"other/*\"]}",
    });
    const standalone = try findInstallProject(io, allocator, nested);
    try std.testing.expectEqualStrings(workspace, standalone.root_dir);
    try std.testing.expectEqualStrings(workspace, standalone.package_dir);
}
