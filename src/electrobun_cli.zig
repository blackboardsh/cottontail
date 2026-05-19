const std = @import("std");
const builtin = @import("builtin");

const load_config_template = @embedFile("electrobun_cli/load_config_helper.js");
const run_hook_template = @embedFile("electrobun_cli/run_hook_helper.js");
const esbuild_driver_template = @embedFile("electrobun_cli/esbuild_driver.cjs");

const esbuild_version = "0.28.0";

const MainProcess = enum {
    bun,
    cottontail,
    zig,
};

const BuildEnvironment = enum {
    dev,
    canary,
    stable,
};

const Context = struct {
    io: std.Io,
    allocator: std.mem.Allocator,
    environ_map: *std.process.Environ.Map,
    self_exe_path: []const u8,
    cottontail_home: []const u8,
    project_root: []const u8,

    fn writeStdout(self: *const Context, comptime fmt: []const u8, args: anytype) void {
        var buffer: [2048]u8 = undefined;
        var writer = std.Io.File.stdout().writer(self.io, &buffer);
        const stdout = &writer.interface;
        stdout.print(fmt, args) catch {};
        stdout.flush() catch {};
    }

    fn writeStderr(self: *const Context, comptime fmt: []const u8, args: anytype) void {
        var buffer: [2048]u8 = undefined;
        var writer = std.Io.File.stderr().writer(self.io, &buffer);
        const stderr = &writer.interface;
        stderr.print(fmt, args) catch {};
        stderr.flush() catch {};
    }
};

const CommandContext = struct {
    raw_json: []const u8,
    root: std.json.Value,
    build_env: BuildEnvironment,
};

const AppBundlePaths = struct {
    build_root: []const u8,
    bundle_root: []const u8,
    exec_dir: []const u8,
    resources_dir: []const u8,
    frameworks_dir: ?[]const u8,
    app_code_dir: []const u8,
};

const PlatformPaths = struct {
    package_root: []const u8,
    shared_dist_dir: []const u8,
    platform_dist_dir: []const u8,
    launcher: []const u8,
    bun_binary: []const u8,
    main_js: []const u8,
    preload_full_js: []const u8,
    preload_sandboxed_js: []const u8,
    core_lib: []const u8,
    native_wrapper: []const u8,
    libasar: []const u8,
    process_helper: []const u8,
    cef_dir: []const u8,
    wgpu_lib: []const u8,
    bspatch: []const u8,
    zig_zstd: []const u8,
};

pub fn forceLink() void {}

pub fn run(init: std.process.Init, args: []const [:0]const u8) !u8 {
    var stdout_buffer: [1024]u8 = undefined;
    var stdout_writer = std.Io.File.stdout().writer(init.io, &stdout_buffer);
    const stdout = &stdout_writer.interface;

    var stderr_buffer: [1024]u8 = undefined;
    var stderr_writer = std.Io.File.stderr().writer(init.io, &stderr_buffer);
    const stderr = &stderr_writer.interface;

    if (args.len == 0 or isHelpFlag(args[0])) {
        try printHelp(stdout);
        try stdout.flush();
        return 0;
    }

    const self_exe_path = try std.process.executablePathAlloc(init.io, init.arena.allocator());
    const exe_dir = try std.process.executableDirPathAlloc(init.io, init.arena.allocator());
    const cottontail_home = try findCottontailHome(init.io, init.arena.allocator(), exe_dir);
    const project_root = try std.Io.Dir.cwd().realPathFileAlloc(init.io, ".", init.arena.allocator());

    const ctx = Context{
        .io = init.io,
        .allocator = init.arena.allocator(),
        .environ_map = init.environ_map,
        .self_exe_path = self_exe_path,
        .cottontail_home = cottontail_home,
        .project_root = project_root,
    };

    const command = args[0];

    if (std.mem.eql(u8, command, "config")) {
        const config = try loadConfig(&ctx, parseBuildEnvironment(args[1..]));
        ctx.writeStdout("{s}\n", .{config.raw_json});
        return 0;
    }

    if (std.mem.eql(u8, command, "init")) {
        try runInit(&ctx, args[1..]);
        return 0;
    }

    if (std.mem.eql(u8, command, "build")) {
        const config = try loadConfig(&ctx, parseBuildEnvironment(args[1..]));
        try runBuild(&ctx, config);
        return 0;
    }

    if (std.mem.eql(u8, command, "run")) {
        const config = try loadConfig(&ctx, parseBuildEnvironment(args[1..]));
        try runBuiltApp(&ctx, config);
        return 0;
    }

    if (std.mem.eql(u8, command, "dev")) {
        if (hasFlag(args[1..], "--watch")) {
            const config = try loadConfig(&ctx, parseBuildEnvironment(args[1..]));
            try runDevWatch(&ctx, config);
            return 0;
        }

        const config = try loadConfig(&ctx, parseBuildEnvironment(args[1..]));
        try runBuild(&ctx, config);
        try runBuiltApp(&ctx, config);
        return 0;
    }

    try stderr.print("cottontail electrobun: unknown command: {s}\n", .{command});
    try printHelp(stderr);
    try stderr.flush();
    return 1;
}

fn printHelp(writer: anytype) !void {
    try writer.writeAll(
        \\cottontail electrobun
        \\Electrobun-oriented CLI commands powered by cottontail.
        \\
        \\Usage:
        \\  cottontail electrobun init [project-name] [--template=name]
        \\  cottontail electrobun config [--env=dev|canary|stable]
        \\  cottontail electrobun build [--env=dev|canary|stable]
        \\  cottontail electrobun run [--env=dev|canary|stable]
        \\  cottontail electrobun dev [--env=dev|canary|stable] [--watch]
        \\
        \\Notes:
        \\  - esbuild is vendored automatically on first use through npm.
        \\  - hook scripts are transpiled and executed by cottontail.
        \\  - init copies templates from the installed electrobun package.
        \\
    );
}

fn isHelpFlag(arg: []const u8) bool {
    return std.mem.eql(u8, arg, "--help") or std.mem.eql(u8, arg, "-h");
}

fn hasFlag(args: []const [:0]const u8, flag: []const u8) bool {
    for (args) |arg| {
        if (std.mem.eql(u8, arg, flag)) return true;
    }
    return false;
}

fn parseBuildEnvironment(args: []const [:0]const u8) BuildEnvironment {
    for (args) |arg| {
        if (std.mem.startsWith(u8, arg, "--env=")) {
            const value = arg["--env=".len..];
            if (std.mem.eql(u8, value, "canary")) return .canary;
            if (std.mem.eql(u8, value, "stable")) return .stable;
            return .dev;
        }
    }

    return .dev;
}

fn findCottontailHome(io: std.Io, allocator: std.mem.Allocator, exe_dir: []const u8) ![]const u8 {
    var current = try allocator.dupe(u8, exe_dir);

    while (true) {
        if (looksLikeCottontailHome(io, allocator, current)) {
            return current;
        }

        const parent = std.fs.path.dirname(current) orelse break;
        if (std.mem.eql(u8, parent, current)) break;
        current = try allocator.dupe(u8, parent);
    }

    return error.CottontailHomeNotFound;
}

fn looksLikeCottontailHome(io: std.Io, allocator: std.mem.Allocator, candidate: []const u8) bool {
    const package_json = std.fs.path.join(allocator, &.{ candidate, "package.json" }) catch return false;
    defer allocator.free(package_json);

    const src_main = std.fs.path.join(allocator, &.{ candidate, "src", "main.zig" }) catch return false;
    defer allocator.free(src_main);

    return pathExists(io, package_json) and pathExists(io, src_main);
}

fn pathExists(io: std.Io, absolute_path: []const u8) bool {
    std.Io.Dir.accessAbsolute(io, absolute_path, .{}) catch return false;
    return true;
}

fn loadConfig(ctx: *const Context, build_env: BuildEnvironment) !CommandContext {
    try ensureEsbuild(ctx);

    const tmp_dir = try ensureCliTempDir(ctx);
    const config_source_path = findConfigPath(ctx);
    const bundled_config_path = try std.fs.path.join(ctx.allocator, &.{ tmp_dir, "electrobun-config.bundle.mjs" });
    const wrapper_path = try std.fs.path.join(ctx.allocator, &.{ tmp_dir, "electrobun-config.loader.mjs" });

    if (config_source_path) |path| {
        try transpileHelperModule(ctx, path, bundled_config_path);
    } else {
        try std.Io.Dir.cwd().writeFile(ctx.io, .{
            .sub_path = bundled_config_path,
            .data = "export default {};\n",
        });
    }

    const helper_source = try std.mem.replaceOwned(
        u8,
        ctx.allocator,
        load_config_template,
        "__MODULE_NAME__",
        std.fs.path.basename(bundled_config_path),
    );

    try std.Io.Dir.cwd().writeFile(ctx.io, .{
        .sub_path = wrapper_path,
        .data = helper_source,
    });

    const result = try std.process.run(ctx.allocator, ctx.io, .{
        .argv = &[_][]const u8{ ctx.self_exe_path, wrapper_path },
        .cwd = .{ .path = tmp_dir },
        .create_no_window = true,
    });
    defer ctx.allocator.free(result.stdout);
    defer ctx.allocator.free(result.stderr);

    if (termExitCode(result.term) != 0) {
        if (result.stderr.len > 0) ctx.writeStderr("{s}", .{result.stderr});
        return error.ConfigLoadFailed;
    }

    const trimmed = std.mem.trim(u8, result.stdout, " \r\n\t");
    const parsed = try std.json.parseFromSliceLeaky(std.json.Value, ctx.allocator, trimmed, .{});

    return .{
        .raw_json = try ctx.allocator.dupe(u8, trimmed),
        .root = parsed,
        .build_env = build_env,
    };
}

fn runBuild(ctx: *const Context, config: CommandContext) !void {
    const build_root = try buildOutputRoot(ctx, config);
    try recreateDir(ctx, build_root);

    try runHook(ctx, config, "preBuild", null);

    const main_process = getMainProcess(config.root);
    if (main_process == .zig) {
        return error.ZigMainProcessNotSupportedYet;
    }

    switch (main_process) {
        .bun => try buildBundledElectrobunApp(ctx, config),
        .cottontail => try buildCottontailApp(ctx, config),
        .zig => unreachable,
    }

    try runHook(ctx, config, "postBuild", null);

    ctx.writeStdout("electrobun build complete: {s}\n", .{build_root});
}

fn runBuiltApp(ctx: *const Context, config: CommandContext) !void {
    const main_process = getMainProcess(config.root);
    switch (main_process) {
        .bun => try runBundledElectrobunApp(ctx, config),
        .cottontail => try runCottontailApp(ctx, config),
        .zig => return error.ZigMainProcessNotSupportedYet,
    }
}

fn runInit(ctx: *const Context, args: []const [:0]const u8) !void {
    const templates_root = (try resolveElectrobunTemplatesRoot(ctx)) orelse return error.TemplateRootNotFound;

    var template_name: ?[]const u8 = null;
    var project_name: ?[]const u8 = null;

    for (args) |arg| {
        if (std.mem.startsWith(u8, arg, "--template=")) {
            template_name = arg["--template=".len..];
        } else if (!std.mem.startsWith(u8, arg, "--")) {
            if (project_name == null) {
                project_name = arg;
            } else if (template_name == null) {
                template_name = arg;
            }
        }
    }

    if (template_name == null) {
        if (project_name) |name| {
            const candidate = try std.fs.path.join(ctx.allocator, &.{ templates_root, name });
            if (pathExists(ctx.io, candidate)) {
                template_name = name;
            }
        }
    }

    if (template_name == null) {
        ctx.writeStdout("Available templates:\n", .{});
        var templates_dir = try std.Io.Dir.openDirAbsolute(ctx.io, templates_root, .{ .iterate = true });
        defer templates_dir.close(ctx.io);

        var iterator = templates_dir.iterate();
        while (try iterator.next(ctx.io)) |entry| {
            if (entry.kind == .directory) {
                ctx.writeStdout("  {s}\n", .{entry.name});
            }
        }
        ctx.writeStdout("\nUsage: cottontail electrobun init <project-name> --template=<name>\n", .{});
        return;
    }

    if (project_name == null) {
        project_name = template_name;
    }

    const source_dir = try std.fs.path.join(ctx.allocator, &.{ templates_root, template_name.? });
    if (!pathExists(ctx.io, source_dir)) return error.TemplateNotFound;

    const project_dir = try std.fs.path.join(ctx.allocator, &.{ ctx.project_root, project_name.? });
    if (pathExists(ctx.io, project_dir)) return error.ProjectAlreadyExists;

    try copyPath(ctx, source_dir, project_dir);
    ctx.writeStdout("Created Electrobun project at {s}\n", .{project_dir});
    ctx.writeStdout("Next steps:\n  cd {s}\n  npm install\n  electrobun dev\n", .{project_name.?});
}

fn runDevWatch(ctx: *const Context, config: CommandContext) !void {
    try runBuild(ctx, config);

    var child = try spawnBuiltApp(ctx, config);
    defer {
        child.kill(ctx.io);
        _ = child.wait(ctx.io) catch {};
    }

    var last_signature = try watchSignature(ctx, config.root);
    ctx.writeStdout("[electrobun dev --watch] Watching for changes...\n", .{});

    while (true) {
        std.Io.sleep(ctx.io, std.Io.Duration.fromMilliseconds(350), .awake) catch {};
        const next_signature = try watchSignature(ctx, config.root);
        if (next_signature == last_signature) continue;

        last_signature = next_signature;
        ctx.writeStdout("[electrobun dev --watch] Change detected, rebuilding...\n", .{});

        child.kill(ctx.io);
        _ = child.wait(ctx.io) catch {};

        try runBuild(ctx, config);
        child = try spawnBuiltApp(ctx, config);
    }
}

fn buildCottontailApp(ctx: *const Context, config: CommandContext) !void {
    const build_root = try buildOutputRoot(ctx, config);
    const app_dir = try std.fs.path.join(ctx.allocator, &.{ build_root, "app" });
    try std.Io.Dir.cwd().createDirPath(ctx.io, app_dir);

    const main_source = try resolveMainEntrypoint(ctx, config.root, .cottontail);
    const main_output = try std.fs.path.join(ctx.allocator, &.{ app_dir, "main.js" });
    try buildMainEntrypoint(ctx, config.root, .cottontail, main_source, main_output);
    try buildViews(ctx, config.root, app_dir);
    try copyStaticAssets(ctx, config.root, app_dir);
}

fn runCottontailApp(ctx: *const Context, config: CommandContext) !void {
    const build_root = try buildOutputRoot(ctx, config);
    const app_dir = try std.fs.path.join(ctx.allocator, &.{ build_root, "app" });
    const main_script = try std.fs.path.join(ctx.allocator, &.{ app_dir, "main.js" });

    if (!pathExists(ctx.io, main_script)) {
        return error.BuiltMainNotFound;
    }

    var env_map = std.process.Environ.Map.init(ctx.allocator);
    defer env_map.deinit();

    try inheritCurrentEnvironmentFromContext(ctx, &env_map);
    try env_map.put("COTTONTAIL_ELECTROBUN_NAME", try getAppName(ctx, config.root));
    try env_map.put("COTTONTAIL_ELECTROBUN_IDENTIFIER", try getAppIdentifier(ctx, config.root));
    try env_map.put("COTTONTAIL_ELECTROBUN_CHANNEL", buildEnvironmentName(config.build_env));

    if (try resolveElectrobunDist(ctx)) |dist_dir| {
        try env_map.put("COTTONTAIL_ELECTROBUN_DIST", dist_dir);
    }

    var child = try std.process.spawn(ctx.io, .{
        .argv = &[_][]const u8{ ctx.self_exe_path, "electrobun", main_script },
        .cwd = .{ .path = app_dir },
        .environ_map = &env_map,
        .stdin = .inherit,
        .stdout = .inherit,
        .stderr = .inherit,
        .create_no_window = true,
    });
    defer child.kill(ctx.io);

    const term = try child.wait(ctx.io);
    if (termExitCode(term) != 0) {
        return error.RunFailed;
    }
}

fn buildBundledElectrobunApp(ctx: *const Context, config: CommandContext) !void {
    const platform_paths = try getPlatformPaths(ctx);
    const bundle = try appBundlePaths(ctx, config);

    try std.Io.Dir.cwd().createDirPath(ctx.io, bundle.exec_dir);
    try std.Io.Dir.cwd().createDirPath(ctx.io, bundle.resources_dir);
    try std.Io.Dir.cwd().createDirPath(ctx.io, bundle.app_code_dir);
    if (bundle.frameworks_dir) |frameworks_dir| {
        try std.Io.Dir.cwd().createDirPath(ctx.io, frameworks_dir);
    }

    if (builtin.os.tag == .macos) {
        try writeInfoPlist(ctx, config, bundle);
    }

    try copyPath(ctx, platform_paths.launcher, try std.fs.path.join(ctx.allocator, &.{ bundle.exec_dir, launcherFileName() }));
    try copyPath(ctx, platform_paths.bun_binary, try std.fs.path.join(ctx.allocator, &.{ bundle.exec_dir, bunBinaryFileName() }));
    try copyPath(ctx, platform_paths.core_lib, try std.fs.path.join(ctx.allocator, &.{ bundle.exec_dir, std.fs.path.basename(platform_paths.core_lib) }));
    try copyPath(ctx, platform_paths.native_wrapper, try std.fs.path.join(ctx.allocator, &.{ bundle.exec_dir, std.fs.path.basename(platform_paths.native_wrapper) }));
    try copyPath(ctx, platform_paths.libasar, try std.fs.path.join(ctx.allocator, &.{ bundle.exec_dir, std.fs.path.basename(platform_paths.libasar) }));
    if (pathExists(ctx.io, platform_paths.bspatch)) {
        try copyPath(ctx, platform_paths.bspatch, try std.fs.path.join(ctx.allocator, &.{ bundle.exec_dir, std.fs.path.basename(platform_paths.bspatch) }));
    }
    if (pathExists(ctx.io, platform_paths.zig_zstd)) {
        try copyPath(ctx, platform_paths.zig_zstd, try std.fs.path.join(ctx.allocator, &.{ bundle.exec_dir, std.fs.path.basename(platform_paths.zig_zstd) }));
    }

    try copyPath(ctx, platform_paths.main_js, try std.fs.path.join(ctx.allocator, &.{ bundle.resources_dir, "main.js" }));
    try copyPath(ctx, platform_paths.preload_full_js, try std.fs.path.join(ctx.allocator, &.{ bundle.resources_dir, "preload-full.js" }));
    try copyPath(ctx, platform_paths.preload_sandboxed_js, try std.fs.path.join(ctx.allocator, &.{ bundle.resources_dir, "preload-sandboxed.js" }));

    if (bundleUsesWgpu(config.root) and pathExists(ctx.io, platform_paths.wgpu_lib)) {
        try copyPath(ctx, platform_paths.wgpu_lib, try std.fs.path.join(ctx.allocator, &.{ bundle.exec_dir, std.fs.path.basename(platform_paths.wgpu_lib) }));
    }

    if (bundleUsesCef(config.root)) {
        try copyBundledCef(ctx, bundle, platform_paths);
    }

    try writeBundledRuntimeMetadata(ctx, config, bundle);

    const main_source = try resolveMainEntrypoint(ctx, config.root, .bun);
    const bun_dir = try std.fs.path.join(ctx.allocator, &.{ bundle.app_code_dir, "bun" });
    try std.Io.Dir.cwd().createDirPath(ctx.io, bun_dir);
    const main_output = try std.fs.path.join(ctx.allocator, &.{ bun_dir, "index.js" });
    try buildMainEntrypoint(ctx, config.root, .bun, main_source, main_output);

    try buildViews(ctx, config.root, bundle.app_code_dir);
    try copyStaticAssets(ctx, config.root, bundle.app_code_dir);
}

fn runBundledElectrobunApp(ctx: *const Context, config: CommandContext) !void {
    var child = try spawnBuiltApp(ctx, config);
    defer child.kill(ctx.io);

    const term = try child.wait(ctx.io);
    if (termExitCode(term) != 0) {
        return error.RunFailed;
    }
}

fn spawnBuiltApp(ctx: *const Context, config: CommandContext) !std.process.Child {
    return switch (getMainProcess(config.root)) {
        .bun => blk: {
            const bundle = try appBundlePaths(ctx, config);
            const launcher_path = try std.fs.path.join(ctx.allocator, &.{ bundle.exec_dir, launcherFileName() });
            if (!pathExists(ctx.io, launcher_path)) return error.BuiltMainNotFound;

            break :blk try std.process.spawn(ctx.io, .{
                .argv = &[_][]const u8{launcher_path},
                .cwd = .{ .path = bundle.exec_dir },
                .stdin = .inherit,
                .stdout = .inherit,
                .stderr = .inherit,
                .create_no_window = true,
            });
        },
        .cottontail => blk: {
            const build_root = try buildOutputRoot(ctx, config);
            const app_dir = try std.fs.path.join(ctx.allocator, &.{ build_root, "app" });
            const main_script = try std.fs.path.join(ctx.allocator, &.{ app_dir, "main.js" });
            if (!pathExists(ctx.io, main_script)) return error.BuiltMainNotFound;

            var env_map = std.process.Environ.Map.init(ctx.allocator);
            try inheritCurrentEnvironmentFromContext(ctx, &env_map);
            try env_map.put("COTTONTAIL_ELECTROBUN_NAME", try getAppName(ctx, config.root));
            try env_map.put("COTTONTAIL_ELECTROBUN_IDENTIFIER", try getAppIdentifier(ctx, config.root));
            try env_map.put("COTTONTAIL_ELECTROBUN_CHANNEL", buildEnvironmentName(config.build_env));
            if (try resolveElectrobunDist(ctx)) |dist_dir| {
                try env_map.put("COTTONTAIL_ELECTROBUN_DIST", dist_dir);
            }

            break :blk try std.process.spawn(ctx.io, .{
                .argv = &[_][]const u8{ ctx.self_exe_path, "electrobun", main_script },
                .cwd = .{ .path = app_dir },
                .environ_map = &env_map,
                .stdin = .inherit,
                .stdout = .inherit,
                .stderr = .inherit,
                .create_no_window = true,
            });
        },
        .zig => error.ZigMainProcessNotSupportedYet,
    };
}

fn runHook(ctx: *const Context, config: CommandContext, hook_name: []const u8, extra_env: ?*const std.process.Environ.Map) !void {
    const scripts = getObjectField(config.root, "scripts") orelse return;
    const hook_value = scripts.get(hook_name) orelse return;
    if (hook_value != .string or hook_value.string.len == 0) return;

    try ensureEsbuild(ctx);

    const tmp_dir = try ensureCliTempDir(ctx);
    const hook_source = try absoluteProjectPath(ctx, hook_value.string);
    const hook_bundle = try std.fs.path.join(ctx.allocator, &.{ tmp_dir, "hook.bundle.mjs" });
    const hook_wrapper = try std.fs.path.join(ctx.allocator, &.{ tmp_dir, "hook.runner.mjs" });

    try transpileHelperModule(ctx, hook_source, hook_bundle);

    const helper_source = try std.mem.replaceOwned(
        u8,
        ctx.allocator,
        run_hook_template,
        "__MODULE_NAME__",
        std.fs.path.basename(hook_bundle),
    );
    try std.Io.Dir.cwd().writeFile(ctx.io, .{
        .sub_path = hook_wrapper,
        .data = helper_source,
    });

    var env_map = std.process.Environ.Map.init(ctx.allocator);
    defer env_map.deinit();

    try inheritCurrentEnvironmentFromContext(ctx, &env_map);
    try env_map.put("ELECTROBUN_BUILD_ENV", buildEnvironmentName(config.build_env));
    try env_map.put("ELECTROBUN_OS", osName());
    try env_map.put("ELECTROBUN_ARCH", archName());
    try env_map.put("ELECTROBUN_BUILD_DIR", try buildOutputRoot(ctx, config));
    try env_map.put("ELECTROBUN_APP_NAME", try getAppName(ctx, config.root));
    try env_map.put("ELECTROBUN_APP_VERSION", try getAppVersion(ctx, config.root));
    try env_map.put("ELECTROBUN_APP_IDENTIFIER", try getAppIdentifier(ctx, config.root));
    try env_map.put("ELECTROBUN_ARTIFACT_DIR", try artifactOutputRoot(ctx, config.root));

    if (extra_env) |map| {
        var it = map.iterator();
        while (it.next()) |entry| {
            try env_map.put(entry.key_ptr.*, entry.value_ptr.*);
        }
    }

    var child = try std.process.spawn(ctx.io, .{
        .argv = &[_][]const u8{ ctx.self_exe_path, hook_wrapper },
        .cwd = .{ .path = ctx.project_root },
        .environ_map = &env_map,
        .stdin = .inherit,
        .stdout = .inherit,
        .stderr = .inherit,
        .create_no_window = true,
    });
    defer child.kill(ctx.io);

    const term = try child.wait(ctx.io);
    if (termExitCode(term) != 0) {
        return error.HookFailed;
    }
}

fn ensureEsbuild(ctx: *const Context) !void {
    const vendor_dir = try std.fs.path.join(ctx.allocator, &.{ ctx.cottontail_home, "vendors", "esbuild" });
    const version_file = try std.fs.path.join(ctx.allocator, &.{ vendor_dir, ".esbuild-version" });
    const esbuild_pkg = try std.fs.path.join(ctx.allocator, &.{ vendor_dir, "node_modules", "esbuild", "package.json" });

    if (pathExists(ctx.io, version_file) and pathExists(ctx.io, esbuild_pkg)) {
        const current_version = std.Io.Dir.cwd().readFileAlloc(ctx.io, version_file, ctx.allocator, .limited(64)) catch "";
        if (std.mem.eql(u8, std.mem.trim(u8, current_version, " \r\n\t"), esbuild_version)) {
            return;
        }
    }

    if (pathExists(ctx.io, vendor_dir)) {
        std.Io.Dir.cwd().deleteTree(ctx.io, vendor_dir) catch {};
    }

    try std.Io.Dir.cwd().createDirPath(ctx.io, vendor_dir);

    const package_json_path = try std.fs.path.join(ctx.allocator, &.{ vendor_dir, "package.json" });
    try std.Io.Dir.cwd().writeFile(ctx.io, .{
        .sub_path = package_json_path,
        .data =
            \\{
            \\  "name": "cottontail-esbuild-vendor",
            \\  "private": true
            \\}
            \\
        ,
    });

    ctx.writeStdout("Vendoring esbuild {s} with npm...\n", .{esbuild_version});

    const spec = try std.fmt.allocPrint(ctx.allocator, "esbuild@{s}", .{esbuild_version});
    const npm_bin = if (builtin.os.tag == .windows) "npm.cmd" else "npm";

    var child = try std.process.spawn(ctx.io, .{
        .argv = &[_][]const u8{
            npm_bin,
            "install",
            "--prefix",
            vendor_dir,
            "--no-save",
            "--no-fund",
            "--no-audit",
            spec,
        },
        .cwd = .{ .path = ctx.cottontail_home },
        .stdin = .inherit,
        .stdout = .inherit,
        .stderr = .inherit,
        .create_no_window = true,
    });
    defer child.kill(ctx.io);

    const term = try child.wait(ctx.io);
    if (termExitCode(term) != 0) {
        return error.EsbuildVendoringFailed;
    }

    try std.Io.Dir.cwd().writeFile(ctx.io, .{
        .sub_path = version_file,
        .data = esbuild_version ++ "\n",
    });
}

fn transpileHelperModule(ctx: *const Context, source_path: []const u8, output_path: []const u8) !void {
    var spec: std.json.ObjectMap = .empty;
    try spec.put(ctx.allocator, "entryPoints", .{ .array = try singleValueArray(ctx.allocator, .{ .string = source_path }) });
    try spec.put(ctx.allocator, "bundle", .{ .bool = true });
    try spec.put(ctx.allocator, "platform", .{ .string = "neutral" });
    try spec.put(ctx.allocator, "format", .{ .string = "esm" });
    try spec.put(ctx.allocator, "outfile", .{ .string = output_path });
    try runEsbuild(ctx, .{ .object = spec });
}

fn buildMainEntrypoint(ctx: *const Context, root: std.json.Value, main_process: MainProcess, source_path: []const u8, output_path: []const u8) !void {
    const build = getObjectField(root, "build") orelse return error.InvalidConfig;
    const options = switch (main_process) {
        .cottontail => getObjectFieldFromObject(build, "cottontail") orelse getObjectFieldFromObject(build, "main") orelse getObjectFieldFromObject(build, "bun"),
        .bun => getObjectFieldFromObject(build, "main") orelse getObjectFieldFromObject(build, "bun"),
        .zig => null,
    } orelse return error.InvalidConfig;

    var spec: std.json.ObjectMap = .empty;
    try spec.put(ctx.allocator, "entryPoints", .{ .array = try singleValueArray(ctx.allocator, .{ .string = source_path }) });
    try spec.put(ctx.allocator, "bundle", .{ .bool = true });
    try spec.put(ctx.allocator, "platform", .{ .string = switch (main_process) {
        .bun => "node",
        else => "neutral",
    } });
    try spec.put(ctx.allocator, "format", .{ .string = "esm" });
    try spec.put(ctx.allocator, "outfile", .{ .string = output_path });
    if (main_process == .bun) {
        try spec.put(ctx.allocator, "external", .{ .array = try singleValueArray(ctx.allocator, .{ .string = "bun:ffi" }) });
    }

    try appendSharedEsbuildOptions(ctx, &spec, options, .main);
    try runEsbuild(ctx, .{ .object = spec });
}

fn buildViews(ctx: *const Context, root: std.json.Value, app_dir: []const u8) !void {
    const build = getObjectField(root, "build") orelse return;
    const views = getObjectFieldFromObject(build, "views") orelse return;

    var it = views.iterator();
    while (it.next()) |entry| {
        const view_name = entry.key_ptr.*;
        const view_value = entry.value_ptr.*;
        if (view_value != .object) continue;

        const entrypoint = getStringFieldFromObject(view_value.object, "entrypoint") orelse continue;
        const source_path = try absoluteProjectPath(ctx, entrypoint);
        const output_dir = try std.fs.path.join(ctx.allocator, &.{ app_dir, "views", view_name });
        const output_file = try std.fs.path.join(ctx.allocator, &.{ output_dir, "index.js" });

        try std.Io.Dir.cwd().createDirPath(ctx.io, output_dir);

        var spec: std.json.ObjectMap = .empty;
        try spec.put(ctx.allocator, "entryPoints", .{ .array = try singleValueArray(ctx.allocator, .{ .string = source_path }) });
        try spec.put(ctx.allocator, "bundle", .{ .bool = true });
        try spec.put(ctx.allocator, "platform", .{ .string = "browser" });
        try spec.put(ctx.allocator, "outfile", .{ .string = output_file });

        try appendSharedEsbuildOptions(ctx, &spec, view_value.object, .view);
        try runEsbuild(ctx, .{ .object = spec });
    }
}

fn copyStaticAssets(ctx: *const Context, root: std.json.Value, app_dir: []const u8) !void {
    const build = getObjectField(root, "build") orelse return;
    const copy = getObjectFieldFromObject(build, "copy") orelse return;

    var it = copy.iterator();
    while (it.next()) |entry| {
        if (entry.value_ptr.* != .string) continue;

        const source_path = try absoluteProjectPath(ctx, entry.key_ptr.*);
        const dest_path = try std.fs.path.join(ctx.allocator, &.{ app_dir, entry.value_ptr.*.string });
        try copyPath(ctx, source_path, dest_path);
    }
}

fn appendSharedEsbuildOptions(
    ctx: *const Context,
    spec: *std.json.ObjectMap,
    object: std.json.ObjectMap,
    comptime kind: enum { main, view },
) !void {
    if (getBoolFieldFromObject(object, "minify")) {
        try spec.put(ctx.allocator, "minify", .{ .bool = true });
    }

    if (getValueFieldFromObject(object, "sourcemap")) |value| {
        switch (value) {
            .bool, .string => try spec.put(ctx.allocator, "sourcemap", value),
            else => {},
        }
    }

    if (kind == .view) {
        if (getStringFieldFromObject(object, "format")) |format| {
            try spec.put(ctx.allocator, "format", .{ .string = format });
        }
    }

    if (getValueFieldFromObject(object, "target")) |value| {
        switch (value) {
            .string, .array => try spec.put(ctx.allocator, "target", value),
            else => {},
        }
    }

    if (getValueFieldFromObject(object, "external")) |value| {
        if (value == .array) try spec.put(ctx.allocator, "external", value);
    }

    if (getValueFieldFromObject(object, "define")) |value| {
        if (value == .object) try spec.put(ctx.allocator, "define", value);
    }
}

fn runEsbuild(ctx: *const Context, build_spec: std.json.Value) !void {
    const tmp_dir = try ensureCliTempDir(ctx);
    const vendor_dir = try std.fs.path.join(ctx.allocator, &.{ ctx.cottontail_home, "vendors", "esbuild" });
    const driver_path = try std.fs.path.join(ctx.allocator, &.{ tmp_dir, "esbuild-driver.cjs" });
    const spec_path = try std.fs.path.join(ctx.allocator, &.{ tmp_dir, "esbuild-spec.json" });

    try std.Io.Dir.cwd().writeFile(ctx.io, .{
        .sub_path = driver_path,
        .data = esbuild_driver_template,
    });

    var full_spec: std.json.ObjectMap = .empty;
    try full_spec.put(ctx.allocator, "op", .{ .string = "build" });
    try full_spec.put(ctx.allocator, "vendorDir", .{ .string = vendor_dir });
    try full_spec.put(ctx.allocator, "options", build_spec);

    const spec_json = try std.json.Stringify.valueAlloc(ctx.allocator, std.json.Value{ .object = full_spec }, .{});
    try std.Io.Dir.cwd().writeFile(ctx.io, .{
        .sub_path = spec_path,
        .data = spec_json,
    });

    const node_bin = if (builtin.os.tag == .windows) "node.exe" else "node";
    const result = try std.process.run(ctx.allocator, ctx.io, .{
        .argv = &[_][]const u8{ node_bin, driver_path, spec_path },
        .cwd = .{ .path = ctx.project_root },
        .create_no_window = true,
    });
    defer ctx.allocator.free(result.stdout);
    defer ctx.allocator.free(result.stderr);

    if (termExitCode(result.term) != 0) {
        if (result.stdout.len > 0) ctx.writeStdout("{s}", .{result.stdout});
        if (result.stderr.len > 0) ctx.writeStderr("{s}", .{result.stderr});
        return error.EsbuildFailed;
    }
}

fn copyPath(ctx: *const Context, source_path: []const u8, dest_path: []const u8) !void {
    if (std.Io.Dir.cwd().statFile(ctx.io, source_path, .{})) |stat| {
        switch (stat.kind) {
            .file => {
                try ensureParentDir(ctx, dest_path);
                try std.Io.Dir.copyFileAbsolute(source_path, dest_path, ctx.io, .{});
                return;
            },
            .directory => {
                try std.Io.Dir.cwd().createDirPath(ctx.io, dest_path);
                var src_dir = try std.Io.Dir.openDirAbsolute(ctx.io, source_path, .{ .iterate = true });
                defer src_dir.close(ctx.io);

                var walker = try src_dir.walk(ctx.allocator);
                defer walker.deinit();

                while (try walker.next(ctx.io)) |entry| {
                    const target_path = try std.fs.path.join(ctx.allocator, &.{ dest_path, entry.path });
                    switch (entry.kind) {
                        .directory => try std.Io.Dir.cwd().createDirPath(ctx.io, target_path),
                        .file => {
                            const source_file = try std.fs.path.join(ctx.allocator, &.{ source_path, entry.path });
                            try ensureParentDir(ctx, target_path);
                            try std.Io.Dir.copyFileAbsolute(source_file, target_path, ctx.io, .{});
                        },
                        else => {},
                    }
                }
                return;
            },
            else => return,
        }
    } else |_| {
        return error.CopySourceMissing;
    }
}

fn ensureParentDir(ctx: *const Context, path: []const u8) !void {
    const parent = std.fs.path.dirname(path) orelse return;
    try std.Io.Dir.cwd().createDirPath(ctx.io, parent);
}

fn recreateDir(ctx: *const Context, absolute_path: []const u8) !void {
    if (pathExists(ctx.io, absolute_path)) {
        std.Io.Dir.cwd().deleteTree(ctx.io, absolute_path) catch {};
    }
    try std.Io.Dir.cwd().createDirPath(ctx.io, absolute_path);
}

fn ensureCliTempDir(ctx: *const Context) ![]const u8 {
    const tmp_dir = try std.fs.path.join(ctx.allocator, &.{ ctx.project_root, ".cottontail-tmp", "electrobun" });
    try std.Io.Dir.cwd().createDirPath(ctx.io, tmp_dir);
    return tmp_dir;
}

fn singleValueArray(allocator: std.mem.Allocator, value: std.json.Value) !std.json.Array {
    const items = try allocator.alloc(std.json.Value, 1);
    items[0] = value;
    return .fromOwnedSlice(allocator, items);
}

fn findConfigPath(ctx: *const Context) ?[]const u8 {
    const candidates = [_][]const u8{
        "electrobun.config.ts",
        "electrobun.config.mts",
        "electrobun.config.js",
        "electrobun.config.mjs",
    };

    for (candidates) |candidate| {
        const absolute = std.fs.path.join(ctx.allocator, &.{ ctx.project_root, candidate }) catch continue;
        if (pathExists(ctx.io, absolute)) return absolute;
    }

    return null;
}

fn resolveMainEntrypoint(ctx: *const Context, root: std.json.Value, main_process: MainProcess) ![]const u8 {
    const build = getObjectField(root, "build") orelse return error.InvalidConfig;

    const relative = switch (main_process) {
        .cottontail => blk: {
            if (getObjectFieldFromObject(build, "cottontail")) |object| {
                if (getStringFieldFromObject(object, "entrypoint")) |path| break :blk path;
            }
            if (getObjectFieldFromObject(build, "main")) |object| {
                if (getStringFieldFromObject(object, "entrypoint")) |path| break :blk path;
            }
            if (getObjectFieldFromObject(build, "bun")) |object| {
                if (getStringFieldFromObject(object, "entrypoint")) |path| break :blk path;
            }
            break :blk "src/main.ts";
        },
        .bun => blk: {
            if (getObjectFieldFromObject(build, "main")) |object| {
                if (getStringFieldFromObject(object, "entrypoint")) |path| break :blk path;
            }
            if (getObjectFieldFromObject(build, "bun")) |object| {
                if (getStringFieldFromObject(object, "entrypoint")) |path| break :blk path;
            }
            break :blk "src/bun/index.ts";
        },
        .zig => return error.ZigMainProcessNotSupportedYet,
    };

    return absoluteProjectPath(ctx, relative);
}

fn absoluteProjectPath(ctx: *const Context, relative_or_absolute: []const u8) ![]const u8 {
    if (std.fs.path.isAbsolute(relative_or_absolute)) {
        return relative_or_absolute;
    }
    return std.fs.path.join(ctx.allocator, &.{ ctx.project_root, relative_or_absolute });
}

fn buildOutputRoot(ctx: *const Context, config: CommandContext) ![]const u8 {
    const build = getObjectField(config.root, "build") orelse return error.InvalidConfig;
    const build_folder = getStringFieldFromObject(build, "buildFolder") orelse "build";
    const prefix = try std.fmt.allocPrint(ctx.allocator, "{s}-{s}-{s}", .{
        buildEnvironmentName(config.build_env),
        osName(),
        archName(),
    });
    return std.fs.path.join(ctx.allocator, &.{ ctx.project_root, build_folder, prefix });
}

fn artifactOutputRoot(ctx: *const Context, root: std.json.Value) ![]const u8 {
    const build = getObjectField(root, "build") orelse return error.InvalidConfig;
    const artifact_folder = getStringFieldFromObject(build, "artifactFolder") orelse "artifacts";
    return std.fs.path.join(ctx.allocator, &.{ ctx.project_root, artifact_folder });
}

fn getMainProcess(root: std.json.Value) MainProcess {
    const build = getObjectField(root, "build") orelse return .bun;
    const value = getStringFieldFromObject(build, "mainProcess") orelse "bun";
    if (std.mem.eql(u8, value, "cottontail")) return .cottontail;
    if (std.mem.eql(u8, value, "zig")) return .zig;
    return .bun;
}

fn getAppName(_: *const Context, root: std.json.Value) ![]const u8 {
    const app = getObjectField(root, "app") orelse return error.InvalidConfig;
    return getStringFieldFromObject(app, "name") orelse error.InvalidConfig;
}

fn getAppIdentifier(_: *const Context, root: std.json.Value) ![]const u8 {
    const app = getObjectField(root, "app") orelse return error.InvalidConfig;
    return getStringFieldFromObject(app, "identifier") orelse error.InvalidConfig;
}

fn getAppVersion(_: *const Context, root: std.json.Value) ![]const u8 {
    const app = getObjectField(root, "app") orelse return error.InvalidConfig;
    return getStringFieldFromObject(app, "version") orelse error.InvalidConfig;
}

fn getObjectField(value: std.json.Value, field: []const u8) ?std.json.ObjectMap {
    if (value != .object) return null;
    return getObjectFieldFromObject(value.object, field);
}

fn getObjectFieldFromObject(object: std.json.ObjectMap, field: []const u8) ?std.json.ObjectMap {
    const value = object.get(field) orelse return null;
    if (value != .object) return null;
    return value.object;
}

fn getStringFieldFromObject(object: std.json.ObjectMap, field: []const u8) ?[]const u8 {
    const value = object.get(field) orelse return null;
    if (value != .string) return null;
    return value.string;
}

fn getBoolFieldFromObject(object: std.json.ObjectMap, field: []const u8) bool {
    const value = object.get(field) orelse return false;
    if (value != .bool) return false;
    return value.bool;
}

fn getValueFieldFromObject(object: std.json.ObjectMap, field: []const u8) ?std.json.Value {
    return object.get(field);
}

fn buildEnvironmentName(build_env: BuildEnvironment) []const u8 {
    return switch (build_env) {
        .dev => "dev",
        .canary => "canary",
        .stable => "stable",
    };
}

fn osName() []const u8 {
    return switch (builtin.os.tag) {
        .windows => "win",
        .macos => "macos",
        else => "linux",
    };
}

fn archName() []const u8 {
    return switch (builtin.cpu.arch) {
        .aarch64 => "arm64",
        .x86_64 => "x64",
        else => "unknown",
    };
}

fn inheritCurrentEnvironmentFromContext(ctx: *const Context, env_map: *std.process.Environ.Map) !void {
    var it = ctx.environ_map.iterator();
    while (it.next()) |entry| {
        try env_map.put(entry.key_ptr.*, entry.value_ptr.*);
    }
}

fn watchSignature(ctx: *const Context, root: std.json.Value) !u64 {
    var roots = try collectWatchRoots(ctx, root);
    defer roots.deinit(ctx.allocator);

    var hasher = std.hash.Wyhash.init(0);
    for (roots.items) |root_path| {
        if (!pathExists(ctx.io, root_path)) continue;

        if (std.Io.Dir.cwd().statFile(ctx.io, root_path, .{})) |stat| {
            if (stat.kind == .file) {
                if (!shouldIgnoreWatchPath(ctx, root, root_path)) {
                    hasher.update(root_path);
                    hasher.update(std.mem.asBytes(&stat.size));
                    hasher.update(std.mem.asBytes(&stat.mtime));
                }
                continue;
            }
        } else |_| {}

        var dir = try std.Io.Dir.openDirAbsolute(ctx.io, root_path, .{ .iterate = true });
        defer dir.close(ctx.io);

        var walker = try dir.walk(ctx.allocator);
        defer walker.deinit();

        while (try walker.next(ctx.io)) |entry| {
            if (entry.kind != .file) continue;
            const full_path = try std.fs.path.join(ctx.allocator, &.{ root_path, entry.path });
            if (shouldIgnoreWatchPath(ctx, root, full_path)) continue;
            const stat = std.Io.Dir.cwd().statFile(ctx.io, full_path, .{}) catch continue;
            hasher.update(full_path);
            hasher.update(std.mem.asBytes(&stat.size));
            hasher.update(std.mem.asBytes(&stat.mtime));
        }
    }

    return hasher.final();
}

fn collectWatchRoots(ctx: *const Context, root: std.json.Value) !std.ArrayList([]const u8) {
    var roots: std.ArrayList([]const u8) = .empty;
    const build = getObjectField(root, "build") orelse return roots;

    const main_process = getMainProcess(root);
    if (main_process != .zig) {
        const main_entry = try resolveMainEntrypoint(ctx, root, main_process);
        try appendWatchRoot(ctx, &roots, dirnameOrSelf(main_entry));
    }

    if (getObjectFieldFromObject(build, "views")) |views| {
        var it = views.iterator();
        while (it.next()) |entry| {
            if (entry.value_ptr.* != .object) continue;
            const entrypoint = getStringFieldFromObject(entry.value_ptr.*.object, "entrypoint") orelse continue;
            try appendWatchRoot(ctx, &roots, dirnameOrSelf(try absoluteProjectPath(ctx, entrypoint)));
        }
    }

    if (getObjectFieldFromObject(build, "copy")) |copy| {
        var it = copy.iterator();
        while (it.next()) |entry| {
            const source_path = try absoluteProjectPath(ctx, entry.key_ptr.*);
            try appendWatchRoot(ctx, &roots, dirnameOrSelf(source_path));
        }
    }

    if (getValueFieldFromObject(build, "watch")) |watch_value| {
        if (watch_value == .array) {
            for (watch_value.array.items) |item| {
                if (item != .string) continue;
                try appendWatchRoot(ctx, &roots, dirnameOrSelf(try absoluteProjectPath(ctx, item.string)));
            }
        }
    }

    return roots;
}

fn appendWatchRoot(ctx: *const Context, roots: *std.ArrayList([]const u8), path: []const u8) !void {
    for (roots.items) |existing| {
        if (std.mem.eql(u8, existing, path)) return;
    }
    try roots.append(ctx.allocator, path);
}

fn dirnameOrSelf(path: []const u8) []const u8 {
    return std.fs.path.dirname(path) orelse path;
}

fn shouldIgnoreWatchPath(ctx: *const Context, root: std.json.Value, full_path: []const u8) bool {
    if (std.mem.indexOf(u8, full_path, "/node_modules/") != null) return true;
    if (std.mem.indexOf(u8, full_path, "\\node_modules\\") != null) return true;
    if (std.mem.indexOf(u8, full_path, "/.cottontail-tmp/") != null) return true;

    const build = getObjectField(root, "build") orelse return false;
    const build_folder = getStringFieldFromObject(build, "buildFolder") orelse "build";
    const artifact_folder = getStringFieldFromObject(build, "artifactFolder") orelse "artifacts";
    const build_root = std.fs.path.join(ctx.allocator, &.{ ctx.project_root, build_folder }) catch return false;
    const artifact_root = std.fs.path.join(ctx.allocator, &.{ ctx.project_root, artifact_folder }) catch return false;

    if (std.mem.startsWith(u8, full_path, build_root)) return true;
    if (std.mem.startsWith(u8, full_path, artifact_root)) return true;

    if (getValueFieldFromObject(build, "watchIgnore")) |ignore_value| {
        if (ignore_value == .array) {
            const relative = if (std.mem.startsWith(u8, full_path, ctx.project_root))
                full_path[@min(full_path.len, ctx.project_root.len + 1)..]
            else
                full_path;

            for (ignore_value.array.items) |item| {
                if (item != .string) continue;
                if (watchIgnoreMatches(relative, item.string)) return true;
            }
        }
    }

    return false;
}

fn watchIgnoreMatches(relative_path: []const u8, pattern: []const u8) bool {
    if (std.mem.eql(u8, relative_path, pattern)) return true;
    if (std.mem.endsWith(u8, pattern, "/**")) {
        const prefix = pattern[0 .. pattern.len - 3];
        return std.mem.startsWith(u8, relative_path, prefix);
    }
    return false;
}

fn launcherFileName() []const u8 {
    return switch (builtin.os.tag) {
        .windows => "launcher.exe",
        else => "launcher",
    };
}

fn bunBinaryFileName() []const u8 {
    return switch (builtin.os.tag) {
        .windows => "bun.exe",
        else => "bun",
    };
}

fn resolveElectrobunPackageRoot(ctx: *const Context) !?[]const u8 {
    if (ctx.environ_map.get("COTTONTAIL_ELECTROBUN_PACKAGE")) |package_root| {
        if (pathExists(ctx.io, package_root)) return package_root;
    }

    var current = ctx.project_root;

    while (true) {
        const candidate = try std.fs.path.join(ctx.allocator, &.{ current, "node_modules", "electrobun" });
        if (pathExists(ctx.io, try std.fs.path.join(ctx.allocator, &.{ candidate, "package.json" }))) return candidate;

        const parent = std.fs.path.dirname(current) orelse break;
        if (std.mem.eql(u8, parent, current)) break;
        current = parent;
    }

    const sibling_repo = try std.fs.path.join(ctx.allocator, &.{ ctx.cottontail_home, "..", "electrobun", "package" });
    if (pathExists(ctx.io, try std.fs.path.join(ctx.allocator, &.{ sibling_repo, "package.json" }))) return sibling_repo;

    return null;
}

fn resolveElectrobunDist(ctx: *const Context) !?[]const u8 {
    const package_root = (try resolveElectrobunPackageRoot(ctx)) orelse return null;
    const candidate = try std.fs.path.join(ctx.allocator, &.{ package_root, "dist" });
    if (pathExists(ctx.io, candidate)) return candidate;
    return null;
}

fn resolveElectrobunTemplatesRoot(ctx: *const Context) !?[]const u8 {
    const package_root = (try resolveElectrobunPackageRoot(ctx)) orelse return null;
    const in_package = try std.fs.path.join(ctx.allocator, &.{ package_root, "templates" });
    if (pathExists(ctx.io, in_package)) return in_package;

    const sibling_templates = try std.fs.path.join(ctx.allocator, &.{ package_root, "..", "templates" });
    if (pathExists(ctx.io, sibling_templates)) return sibling_templates;

    return null;
}

fn getPlatformPaths(ctx: *const Context) !PlatformPaths {
    const package_root = (try resolveElectrobunPackageRoot(ctx)) orelse return error.ElectrobunPackageNotFound;
    const shared_dist_dir = try std.fs.path.join(ctx.allocator, &.{ package_root, "dist" });
    const platform_dist_dir = blk: {
        const candidate = try std.fmt.allocPrint(ctx.allocator, "{s}/dist-{s}-{s}", .{
            package_root,
            osName(),
            archName(),
        });
        if (pathExists(ctx.io, candidate)) break :blk candidate;
        break :blk shared_dist_dir;
    };

    return .{
        .package_root = package_root,
        .shared_dist_dir = shared_dist_dir,
        .platform_dist_dir = platform_dist_dir,
        .launcher = try std.fs.path.join(ctx.allocator, &.{ platform_dist_dir, launcherFileName() }),
        .bun_binary = try std.fs.path.join(ctx.allocator, &.{ platform_dist_dir, bunBinaryFileName() }),
        .main_js = try std.fs.path.join(ctx.allocator, &.{ platform_dist_dir, "main.js" }),
        .preload_full_js = try std.fs.path.join(ctx.allocator, &.{ platform_dist_dir, "preload-full.js" }),
        .preload_sandboxed_js = try std.fs.path.join(ctx.allocator, &.{ platform_dist_dir, "preload-sandboxed.js" }),
        .core_lib = try std.fs.path.join(ctx.allocator, &.{ platform_dist_dir, switch (builtin.os.tag) {
            .windows => "ElectrobunCore.dll",
            .macos => "libElectrobunCore.dylib",
            else => "libElectrobunCore.so",
        } }),
        .native_wrapper = try std.fs.path.join(ctx.allocator, &.{ platform_dist_dir, switch (builtin.os.tag) {
            .windows => "libNativeWrapper.dll",
            .macos => "libNativeWrapper.dylib",
            else => "libNativeWrapper.so",
        } }),
        .libasar = try std.fs.path.join(ctx.allocator, &.{ platform_dist_dir, switch (builtin.os.tag) {
            .windows => "libasar.dll",
            .macos => "libasar.dylib",
            else => "libasar.so",
        } }),
        .process_helper = try std.fs.path.join(ctx.allocator, &.{ platform_dist_dir, switch (builtin.os.tag) {
            .windows => "process_helper.exe",
            else => "process_helper",
        } }),
        .cef_dir = try std.fs.path.join(ctx.allocator, &.{ platform_dist_dir, "cef" }),
        .wgpu_lib = try std.fs.path.join(ctx.allocator, &.{ platform_dist_dir, switch (builtin.os.tag) {
            .windows => "webgpu_dawn.dll",
            .macos => "libwebgpu_dawn.dylib",
            else => "libwebgpu_dawn.so",
        } }),
        .bspatch = try std.fs.path.join(ctx.allocator, &.{ platform_dist_dir, switch (builtin.os.tag) {
            .windows => "bspatch.exe",
            else => "bspatch",
        } }),
        .zig_zstd = try std.fs.path.join(ctx.allocator, &.{ platform_dist_dir, switch (builtin.os.tag) {
            .windows => "zig-zstd.exe",
            else => "zig-zstd",
        } }),
    };
}

fn appBundlePaths(ctx: *const Context, config: CommandContext) !AppBundlePaths {
    const build_root = try buildOutputRoot(ctx, config);
    const bundle_name = try bundleDisplayName(ctx, config);

    if (builtin.os.tag == .macos) {
        const bundle_root = try std.fs.path.join(ctx.allocator, &.{ build_root, bundle_name });
        const contents_dir = try std.fs.path.join(ctx.allocator, &.{ bundle_root, "Contents" });
        const exec_dir = try std.fs.path.join(ctx.allocator, &.{ contents_dir, "MacOS" });
        const resources_dir = try std.fs.path.join(ctx.allocator, &.{ contents_dir, "Resources" });
        const frameworks_dir = try std.fs.path.join(ctx.allocator, &.{ contents_dir, "Frameworks" });
        const app_code_dir = try std.fs.path.join(ctx.allocator, &.{ resources_dir, "app" });
        return .{
            .build_root = build_root,
            .bundle_root = bundle_root,
            .exec_dir = exec_dir,
            .resources_dir = resources_dir,
            .frameworks_dir = frameworks_dir,
            .app_code_dir = app_code_dir,
        };
    }

    const bundle_root = try std.fs.path.join(ctx.allocator, &.{ build_root, bundle_name });
    const exec_dir = try std.fs.path.join(ctx.allocator, &.{ bundle_root, "bin" });
    const resources_dir = try std.fs.path.join(ctx.allocator, &.{ bundle_root, "Resources" });
    const app_code_dir = try std.fs.path.join(ctx.allocator, &.{ resources_dir, "app" });
    return .{
        .build_root = build_root,
        .bundle_root = bundle_root,
        .exec_dir = exec_dir,
        .resources_dir = resources_dir,
        .frameworks_dir = null,
        .app_code_dir = app_code_dir,
    };
}

fn bundleDisplayName(ctx: *const Context, config: CommandContext) ![]const u8 {
    const app_name = try getAppName(ctx, config.root);
    const suffix = switch (config.build_env) {
        .dev => if (builtin.os.tag == .macos) ".app" else "",
        .canary => if (builtin.os.tag == .macos) "-canary.app" else "-canary",
        .stable => if (builtin.os.tag == .macos) ".app" else "",
    };
    return std.fmt.allocPrint(ctx.allocator, "{s}{s}", .{ app_name, suffix });
}

fn bundleUsesCef(root: std.json.Value) bool {
    const platform = platformBuildObject(root) orelse return false;
    return getBoolFieldFromObject(platform, "bundleCEF");
}

fn bundleUsesWgpu(root: std.json.Value) bool {
    const platform = platformBuildObject(root) orelse return false;
    return getBoolFieldFromObject(platform, "bundleWGPU");
}

fn platformBuildObject(root: std.json.Value) ?std.json.ObjectMap {
    const build = getObjectField(root, "build") orelse return null;
    return switch (builtin.os.tag) {
        .macos => getObjectFieldFromObject(build, "mac"),
        .windows => getObjectFieldFromObject(build, "win"),
        else => getObjectFieldFromObject(build, "linux"),
    };
}

fn writeInfoPlist(ctx: *const Context, config: CommandContext, bundle: AppBundlePaths) !void {
    const app_name = try getAppName(ctx, config.root);
    const identifier = try getAppIdentifier(ctx, config.root);
    const version_name = try getAppVersion(ctx, config.root);
    const contents = try std.fmt.allocPrint(ctx.allocator,
        \\<?xml version="1.0" encoding="UTF-8"?>
        \\<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        \\<plist version="1.0">
        \\<dict>
        \\    <key>CFBundleExecutable</key>
        \\    <string>launcher</string>
        \\    <key>CFBundleIdentifier</key>
        \\    <string>{s}</string>
        \\    <key>CFBundleName</key>
        \\    <string>{s}</string>
        \\    <key>CFBundleVersion</key>
        \\    <string>{s}</string>
        \\    <key>CFBundlePackageType</key>
        \\    <string>APPL</string>
        \\</dict>
        \\</plist>
        \\
    , .{ identifier, app_name, version_name });
    const plist_path = try std.fs.path.join(ctx.allocator, &.{ bundle.bundle_root, "Contents", "Info.plist" });
    try std.Io.Dir.cwd().writeFile(ctx.io, .{ .sub_path = plist_path, .data = contents });
}

fn copyBundledCef(ctx: *const Context, bundle: AppBundlePaths, platform_paths: PlatformPaths) !void {
    if (!pathExists(ctx.io, platform_paths.cef_dir)) return;

    switch (builtin.os.tag) {
        .macos => {
            const frameworks_dir = bundle.frameworks_dir orelse return;
            const framework_source = try std.fs.path.join(ctx.allocator, &.{ platform_paths.cef_dir, "Chromium Embedded Framework.framework" });
            const framework_dest = try std.fs.path.join(ctx.allocator, &.{ frameworks_dir, "Chromium Embedded Framework.framework" });
            try copyPath(ctx, framework_source, framework_dest);

            const helper_names = [_][]const u8{
                "bun Helper",
                "bun Helper (Alerts)",
                "bun Helper (GPU)",
                "bun Helper (Plugin)",
                "bun Helper (Renderer)",
            };
            for (helper_names) |helper_name| {
                const helper_app_name = try std.fmt.allocPrint(ctx.allocator, "{s}.app", .{helper_name});
                const helper_dest = try std.fs.path.join(ctx.allocator, &.{ frameworks_dir, helper_app_name, "Contents", "MacOS", helper_name });
                try copyPath(ctx, platform_paths.process_helper, helper_dest);
            }
        },
        else => {
            try copyPath(ctx, platform_paths.cef_dir, try std.fs.path.join(ctx.allocator, &.{ bundle.exec_dir, "cef" }));
            if (pathExists(ctx.io, platform_paths.process_helper)) {
                try copyPath(ctx, platform_paths.process_helper, try std.fs.path.join(ctx.allocator, &.{ bundle.exec_dir, std.fs.path.basename(platform_paths.process_helper) }));
            }
        },
    }
}

fn writeBundledRuntimeMetadata(ctx: *const Context, config: CommandContext, bundle: AppBundlePaths) !void {
    const identifier = try getAppIdentifier(ctx, config.root);
    const app_name = try getAppName(ctx, config.root);
    const version_name = try getAppVersion(ctx, config.root);
    const runtime_value = getValueFieldFromObject(config.root.object, "runtime") orelse std.json.Value{ .object = .empty };
    const runtime_json = try std.json.Stringify.valueAlloc(ctx.allocator, runtime_value, .{});
    const default_renderer = if (platformBuildObject(config.root)) |platform| getStringFieldFromObject(platform, "defaultRenderer") orelse "native" else "native";
    const available_renderers = if (bundleUsesCef(config.root)) "[\"native\",\"cef\"]" else "[\"native\"]";
    const build_json = try std.fmt.allocPrint(ctx.allocator,
        "{{\"mainProcess\":\"bun\",\"defaultRenderer\":\"{s}\",\"availableRenderers\":{s},\"runtime\":{s}}}",
        .{ default_renderer, available_renderers, runtime_json },
    );
    const version_json = try std.fmt.allocPrint(ctx.allocator,
        "{{\"version\":\"{s}\",\"hash\":\"\",\"channel\":\"{s}\",\"name\":\"{s}\",\"identifier\":\"{s}\"}}",
        .{ version_name, buildEnvironmentName(config.build_env), app_name, identifier },
    );

    try std.Io.Dir.cwd().writeFile(ctx.io, .{
        .sub_path = try std.fs.path.join(ctx.allocator, &.{ bundle.resources_dir, "build.json" }),
        .data = build_json,
    });
    try std.Io.Dir.cwd().writeFile(ctx.io, .{
        .sub_path = try std.fs.path.join(ctx.allocator, &.{ bundle.resources_dir, "version.json" }),
        .data = version_json,
    });
}

fn termExitCode(term: std.process.Child.Term) u8 {
    return switch (term) {
        .exited => |code| @intCast(code),
        .signal => 1,
        .stopped => 1,
        .unknown => 1,
    };
}
