const std = @import("std");
const builtin = @import("builtin");

const Bunx = @import("package_manager_bunx.zig");
const PackageManager = @import("package_manager_cli.zig");

const Value = std.json.Value;
const max_archive_bytes = 512 * 1024 * 1024;
const max_manifest_bytes = 16 * 1024 * 1024;

const ScanResult = union(enum) {
    missing,
    help,
    invocation: Invocation,
};

const Invocation = struct {
    template: []const u8,
    template_index: usize,
    force_runtime: bool,
};

const Template = union(enum) {
    npm,
    local_folder: []const u8,
    github_repository: GitHubRepository,
    official: []const u8,
    source_file: []const u8,
    missing: []const u8,
};

const GitHubRepository = struct {
    name: []const u8,
    reference: []const u8 = "",
};

const CreateOptions = struct {
    destination: ?[]const u8 = null,
    skip_install: bool = false,
    overwrite: bool = false,
    skip_git: bool = false,
    skip_package_json: bool = false,
    verbose: bool = false,
    open: bool = false,
    help: bool = false,
};

const ManifestInfo = struct {
    has_dependencies: bool = false,
    start_command: []const u8 = "bun dev",
    preinstall_tasks: []const []const u8 = &.{},
    postinstall_tasks: []const []const u8 = &.{},
};

pub fn run(
    init: std.process.Init,
    args: []const [:0]const u8,
    stdout: *std.Io.Writer,
    stderr: *std.Io.Writer,
) !u8 {
    const allocator = init.arena.allocator();
    const scan = scanInvocation(args);
    const invocation = switch (scan) {
        .missing => {
            try printHelp(stdout);
            try stdout.flush();
            return 1;
        },
        .help => {
            try printHelp(stdout);
            try stdout.flush();
            return 0;
        },
        .invocation => |value| value,
    };

    if (std.mem.eql(u8, invocation.template, "react")) {
        try stderr.writeAll(
            "The \"react\" template has been deprecated.\n" ++
                "It is recommended to use \"react-app\" or \"vite\" instead.\n\n" ++
                "To create a React project using Vite, run\n\n" ++
                "  bun create vite\n",
        );
        try stderr.flush();
        return 1;
    }
    if (std.mem.eql(u8, invocation.template, "next")) {
        try stderr.writeAll(
            "warn: No template create-next found.\n" ++
                "To create a project with the official Next.js scaffolding tool, run\n" ++
                "  bun create next-app [destination]\n",
        );
        try stderr.flush();
        return 1;
    }

    const cwd = try std.Io.Dir.cwd().realPathFileAlloc(init.io, ".", allocator);
    const template = try classifyTemplate(init, allocator, cwd, invocation.template);
    if (template == .npm) {
        return runInitializer(init, args, invocation, stdout, stderr);
    }

    if (template == .source_file) {
        try stderr.print(
            "error: bun create [local file] currently requires the JSX/TSX project generator: {s}\n",
            .{invocation.template},
        );
        try stderr.flush();
        return 1;
    }
    if (template == .missing) {
        try stderr.print("error: template not found: {s}\n", .{template.missing});
        try stderr.flush();
        return 1;
    }

    const options = parseCreateOptions(args, invocation.template_index) catch |err| {
        try stderr.print("error: {s}\n", .{@errorName(err)});
        try stderr.flush();
        return 1;
    };
    if (options.help) {
        try printHelp(stdout);
        try stdout.flush();
        return 0;
    }

    return createProject(init, cwd, template, invocation.template, options, args[0], stdout, stderr) catch |err| {
        if (err != error.CreateErrorReported) {
            try stderr.print("error: bun create failed: {s}\n", .{@errorName(err)});
        }
        try stderr.flush();
        return 1;
    };
}

fn scanInvocation(args: []const [:0]const u8) ScanResult {
    if (args.len <= 2) return .missing;

    var force_runtime = false;
    var index: usize = 2;
    while (index < args.len) : (index += 1) {
        const arg = std.mem.trim(u8, args[index], " \t\r\n");
        if (arg.len == 0) continue;
        if (std.mem.eql(u8, arg, "-h") or std.mem.eql(u8, arg, "--help")) return .help;
        if (std.mem.startsWith(u8, arg, "--")) {
            if (std.mem.eql(u8, arg, "--bun")) force_runtime = true;
            continue;
        }
        return .{ .invocation = .{
            .template = arg,
            .template_index = index,
            .force_runtime = force_runtime,
        } };
    }
    return .help;
}

fn parseCreateOptions(args: []const [:0]const u8, template_index: usize) !CreateOptions {
    var options: CreateOptions = .{};
    var positional_mode = false;
    var index: usize = 2;
    while (index < args.len) : (index += 1) {
        if (index == template_index) continue;
        const arg = args[index];
        if (arg.len == 0) continue;
        if (!positional_mode and std.mem.eql(u8, arg, "--")) {
            positional_mode = true;
            continue;
        }
        if (!positional_mode and std.mem.startsWith(u8, arg, "-")) {
            if (std.mem.eql(u8, arg, "--no-install")) {
                options.skip_install = true;
            } else if (std.mem.eql(u8, arg, "--force")) {
                options.overwrite = true;
            } else if (std.mem.eql(u8, arg, "--no-git")) {
                options.skip_git = true;
            } else if (std.mem.eql(u8, arg, "--no-package-json")) {
                options.skip_package_json = true;
            } else if (std.mem.eql(u8, arg, "--verbose")) {
                options.verbose = true;
            } else if (std.mem.eql(u8, arg, "--open")) {
                options.open = true;
            } else if (std.mem.eql(u8, arg, "--bun")) {
                // This only controls npm initializer execution.
            } else if (std.mem.eql(u8, arg, "--help") or std.mem.eql(u8, arg, "-h")) {
                options.help = true;
            } else {
                return error.UnknownCreateOption;
            }
            continue;
        }
        if (options.destination == null) options.destination = arg;
    }
    return options;
}

fn classifyTemplate(
    init: std.process.Init,
    allocator: std.mem.Allocator,
    cwd: []const u8,
    requested: []const u8,
) !Template {
    const direct_path = try std.fs.path.resolve(allocator, &.{ cwd, requested });
    if (std.Io.Dir.cwd().statFile(init.io, direct_path, .{}) catch null) |stat| {
        if (stat.kind == .file) {
            const extension = std.fs.path.extension(requested);
            if (std.ascii.eqlIgnoreCase(extension, ".jsx") or std.ascii.eqlIgnoreCase(extension, ".tsx")) {
                return .{ .source_file = direct_path };
            }
        } else if (stat.kind == .directory and isExplicitPath(requested)) {
            return .{ .local_folder = direct_path };
        }
    }

    if (!std.fs.path.isAbsolute(requested)) {
        if (init.environ_map.get("BUN_CREATE_DIR")) |create_dir| {
            if (create_dir.len > 0) {
                const candidate = try std.fs.path.resolve(allocator, &.{ cwd, create_dir, requested });
                if (directoryExists(init.io, candidate)) return .{ .local_folder = candidate };
            }
        }

        const project_candidate = try std.fs.path.resolve(allocator, &.{ cwd, ".bun-create", requested });
        if (directoryExists(init.io, project_candidate)) return .{ .local_folder = project_candidate };

        if (init.environ_map.get(homeEnvironmentName())) |home| {
            if (home.len > 0) {
                const home_candidate = try std.fs.path.resolve(allocator, &.{ home, ".bun-create", requested });
                if (directoryExists(init.io, home_candidate)) return .{ .local_folder = home_candidate };
            }
        }
    }

    if (isLegacyOfficialTemplate(requested)) return .{ .official = requested };
    if (requested.len > 0 and
        (requested[0] == '@' or std.mem.indexOfScalar(u8, requested, '/') == null))
    {
        return .npm;
    }
    if (try parseGitHubRepository(allocator, requested)) |repository| {
        return .{ .github_repository = repository };
    }
    return .{ .missing = requested };
}

fn runInitializer(
    init: std.process.Init,
    args: []const [:0]const u8,
    invocation: Invocation,
    stdout: *std.Io.Writer,
    stderr: *std.Io.Writer,
) !u8 {
    const allocator = init.arena.allocator();
    const package = try Bunx.addCreatePrefix(allocator, invocation.template);
    const passthrough = args[invocation.template_index + 1 ..];
    const bunx_args = try allocator.alloc([:0]const u8, passthrough.len + 3);
    bunx_args[0] = args[0];
    bunx_args[1] = "x";
    bunx_args[2] = package;
    @memcpy(bunx_args[3..], passthrough);
    return Bunx.run(init, bunx_args, .{
        .args_start = 2,
        .force_runtime = invocation.force_runtime,
    }, stdout, stderr);
}

fn createProject(
    init: std.process.Init,
    cwd: []const u8,
    template: Template,
    requested_template: []const u8,
    options: CreateOptions,
    executable_arg: [:0]const u8,
    stdout: *std.Io.Writer,
    stderr: *std.Io.Writer,
) !u8 {
    const allocator = init.arena.allocator();
    const default_destination = switch (template) {
        .local_folder => |path| std.fs.path.basename(path),
        .github_repository => |repository| std.fs.path.basename(repository.name),
        .official => |name| std.fs.path.basename(name),
        else => unreachable,
    };
    const destination_arg = options.destination orelse default_destination;
    if (destination_arg.len == 0) {
        try stderr.writeAll("error: destination cannot be empty\n");
        return error.CreateErrorReported;
    }
    const destination = try std.fs.path.resolve(allocator, &.{ cwd, destination_arg });

    switch (template) {
        .local_folder => |source| try copyLocalTemplate(init, allocator, source, destination),
        .github_repository => |repository| {
            const archive = try fetchGitHubArchive(init, allocator, repository, stderr);
            if (!options.overwrite and try reportArchiveConflicts(init, allocator, destination, archive, requested_template, stderr)) {
                return error.CreateErrorReported;
            }
            try extractArchive(init, allocator, destination, archive);
        },
        .official => |name| {
            const archive = try fetchOfficialArchive(init, allocator, name, stderr);
            if (!options.overwrite and try reportArchiveConflicts(init, allocator, destination, archive, requested_template, stderr)) {
                return error.CreateErrorReported;
            }
            try extractArchive(init, allocator, destination, archive);
        },
        else => unreachable,
    }

    try normalizeTemplateFiles(init.io, allocator, destination);
    const manifest = try processPackageJSON(init, allocator, destination, options.skip_package_json, stderr);
    const should_install = manifest.has_dependencies and !options.skip_install;

    const git_created = if (!options.skip_git)
        try initializeGitRepository(init, destination, options.verbose, stderr)
    else
        false;

    if (should_install) {
        for (manifest.preinstall_tasks) |task| {
            try runCreateTask(init, destination, task, true, stdout, stderr);
        }
        const install_code = try installDependencies(init, executable_arg, cwd, destination, stdout, stderr);
        if (install_code != 0) return install_code;
    }

    for (manifest.postinstall_tasks) |task| {
        try runCreateTask(init, destination, task, should_install, stdout, stderr);
    }

    try printSuccess(
        allocator,
        cwd,
        destination,
        template,
        requested_template,
        manifest.start_command,
        should_install,
        git_created,
        stdout,
    );
    try stdout.flush();

    if (options.open) {
        openBrowser(init, "http://localhost:3000/") catch {};
        try runCreateTask(init, destination, manifest.start_command, false, stdout, stderr);
    }
    return 0;
}

fn copyLocalTemplate(
    init: std.process.Init,
    allocator: std.mem.Allocator,
    source: []const u8,
    destination: []const u8,
) !void {
    if (pathsOverlap(source, destination)) return error.TemplateDestinationOverlapsSource;
    deletePath(init.io, destination);
    try std.Io.Dir.cwd().createDirPath(init.io, destination);
    try copyTemplateDirectory(init.io, allocator, source, destination);
}

fn copyTemplateDirectory(
    io: std.Io,
    allocator: std.mem.Allocator,
    source: []const u8,
    destination: []const u8,
) !void {
    var source_dir = try std.Io.Dir.cwd().openDir(io, source, .{ .iterate = true });
    defer source_dir.close(io);
    var iterator = source_dir.iterate();
    while (try iterator.next(io)) |entry| {
        if (shouldSkipTemplateEntry(entry.name, entry.kind)) continue;
        const source_path = try std.fs.path.join(allocator, &.{ source, entry.name });
        const destination_path = try std.fs.path.join(allocator, &.{ destination, entry.name });
        switch (entry.kind) {
            .directory => {
                try std.Io.Dir.cwd().createDirPath(io, destination_path);
                try copyTemplateDirectory(io, allocator, source_path, destination_path);
            },
            .file => try std.Io.Dir.copyFileAbsolute(source_path, destination_path, io, .{
                .replace = true,
                .make_path = true,
            }),
            else => {},
        }
    }
}

fn shouldSkipTemplateEntry(name: []const u8, kind: std.Io.File.Kind) bool {
    if (kind == .directory and
        (std.mem.eql(u8, name, "node_modules") or std.mem.eql(u8, name, ".git")))
    {
        return true;
    }
    if (kind == .file) {
        for ([_][]const u8{ "package-lock.json", "yarn.lock", "pnpm-lock.yaml" }) |ignored| {
            if (std.mem.eql(u8, name, ignored)) return true;
        }
    }
    return false;
}

fn extractArchive(
    init: std.process.Init,
    allocator: std.mem.Allocator,
    destination: []const u8,
    archive: []const u8,
) !void {
    try std.Io.Dir.cwd().createDirPath(init.io, destination);
    var destination_dir = try std.Io.Dir.cwd().openDir(init.io, destination, .{});
    defer destination_dir.close(init.io);
    try PackageManager.extractTarballArchive(init.io, allocator, destination_dir, archive);
}

fn reportArchiveConflicts(
    init: std.process.Init,
    allocator: std.mem.Allocator,
    destination: []const u8,
    archive: []const u8,
    template: []const u8,
    stderr: *std.Io.Writer,
) !bool {
    const conflicts = try archiveConflicts(init.io, allocator, destination, archive);
    if (conflicts.len == 0) return false;

    try stderr.print(
        "\nerror: The directory {s}/ contains files that could conflict:\n\n",
        .{std.fs.path.basename(destination)},
    );
    for (conflicts) |path| try stderr.print("  {s}\n", .{path});
    try stderr.print("\nTo download {s} anyway, use --force\n", .{template});
    try stderr.flush();
    return true;
}

fn archiveConflicts(
    io: std.Io,
    allocator: std.mem.Allocator,
    destination: []const u8,
    archive: []const u8,
) ![]const []const u8 {
    var conflicts = std.array_list.Managed([]const u8).init(allocator);
    var compressed_reader: std.Io.Reader = .fixed(archive);
    var decompression_buffer: [std.compress.flate.max_window_len]u8 = undefined;
    var decompressor: std.compress.flate.Decompress = .init(&compressed_reader, .gzip, &decompression_buffer);
    var file_name_buffer: [std.fs.max_path_bytes]u8 = undefined;
    var link_name_buffer: [std.fs.max_path_bytes]u8 = undefined;
    var sanitized_path_buffer: [std.fs.max_path_bytes]u8 = undefined;
    var iterator: std.tar.Iterator = .init(&decompressor.reader, .{
        .file_name_buffer = &file_name_buffer,
        .link_name_buffer = &link_name_buffer,
    });

    while (try iterator.next()) |entry| {
        if (entry.kind != .file or entry.size == 0) continue;
        const path_len = PackageManager.sanitizeTarPath(&sanitized_path_buffer, entry.name, 1) catch continue;
        if (path_len == 0) continue;
        const path = sanitized_path_buffer[0..path_len];
        const candidate = try std.fs.path.join(allocator, &.{ destination, path });
        const stat = std.Io.Dir.cwd().statFile(io, candidate, .{}) catch continue;
        if (stat.kind != .file or stat.size == 0) continue;

        const display_path = if (std.mem.indexOfScalar(u8, path, '/')) |slash|
            path[0 .. slash + 1]
        else
            path;
        if (isNeverConflictPath(display_path)) continue;

        var duplicate = false;
        for (conflicts.items) |existing| {
            if (std.mem.eql(u8, existing, display_path)) {
                duplicate = true;
                break;
            }
        }
        if (!duplicate) try conflicts.append(try allocator.dupe(u8, display_path));
    }
    return conflicts.toOwnedSlice();
}

fn normalizeTemplateFiles(io: std.Io, allocator: std.mem.Allocator, destination: []const u8) !void {
    const gitignore = try std.fs.path.join(allocator, &.{ destination, "gitignore" });
    const dot_gitignore = try std.fs.path.join(allocator, &.{ destination, ".gitignore" });
    if (pathExists(io, gitignore)) {
        if (!pathExists(io, dot_gitignore)) {
            std.Io.Dir.renameAbsolute(gitignore, dot_gitignore, io) catch {
                try std.Io.Dir.copyFileAbsolute(gitignore, dot_gitignore, io, .{
                    .replace = false,
                    .make_path = true,
                });
                deletePath(io, gitignore);
            };
        } else {
            deletePath(io, gitignore);
        }
    }
    deletePath(io, try std.fs.path.join(allocator, &.{ destination, ".npmignore" }));
}

fn processPackageJSON(
    init: std.process.Init,
    allocator: std.mem.Allocator,
    destination: []const u8,
    skip: bool,
    stderr: *std.Io.Writer,
) !ManifestInfo {
    if (skip) return .{};
    const package_json_path = try std.fs.path.join(allocator, &.{ destination, "package.json" });
    const source = std.Io.Dir.cwd().readFileAlloc(
        init.io,
        package_json_path,
        allocator,
        .limited(max_manifest_bytes),
    ) catch return .{};
    var root = std.json.parseFromSliceLeaky(Value, allocator, source, .{}) catch |err| {
        try stderr.print("warn: unable to update package.json: {s}\n", .{@errorName(err)});
        return .{};
    };
    if (root != .object) return .{};

    if (root.object.getPtr("name")) |name| {
        if (name.* == .string) name.* = .{ .string = std.fs.path.basename(destination) };
    }

    var has_dependencies = false;
    for ([_][]const u8{ "dependencies", "devDependencies" }) |section_name| {
        const section = root.object.get(section_name) orelse continue;
        if (section == .object and section.object.count() > 0) has_dependencies = true;
    }

    if (root.object.getPtr("scripts")) |scripts| {
        if (scripts.* == .object) {
            var index: usize = 0;
            while (index < scripts.object.count()) {
                const key = scripts.object.keys()[index];
                const command = scripts.object.getPtr(key).?;
                if (command.* != .string) {
                    index += 1;
                    continue;
                }
                if (std.mem.indexOf(u8, command.string, "react-scripts start") != null or
                    std.mem.indexOf(u8, command.string, "next dev") != null or
                    std.mem.indexOf(u8, command.string, "react-scripts eject") != null)
                {
                    _ = scripts.object.orderedRemove(key);
                    continue;
                }
                if (std.mem.indexOf(u8, command.string, "react-scripts build") != null) {
                    command.* = .{ .string = "npx react-scripts build" };
                }
                index += 1;
            }
        }
    }

    var preinstall = std.array_list.Managed([]const u8).init(allocator);
    var postinstall = std.array_list.Managed([]const u8).init(allocator);
    var start_command: []const u8 = "bun dev";
    if (root.object.get("bun-create")) |create| {
        if (create == .object) {
            if (create.object.get("preinstall")) |tasks| try appendCreateTasks(&preinstall, tasks);
            if (create.object.get("postinstall")) |tasks| try appendCreateTasks(&postinstall, tasks);
            if (create.object.get("start")) |start| {
                if (start == .string and start.string.len > 0) start_command = start.string;
            }
        }
        _ = root.object.orderedRemove("bun-create");
    }

    var output: std.Io.Writer.Allocating = .init(allocator);
    try std.json.Stringify.value(root, .{ .whitespace = .indent_2 }, &output.writer);
    try output.writer.writeByte('\n');
    try std.Io.Dir.cwd().writeFile(init.io, .{
        .sub_path = package_json_path,
        .data = output.written(),
    });

    return .{
        .has_dependencies = has_dependencies,
        .start_command = start_command,
        .preinstall_tasks = try preinstall.toOwnedSlice(),
        .postinstall_tasks = try postinstall.toOwnedSlice(),
    };
}

fn appendCreateTasks(list: *std.array_list.Managed([]const u8), value: Value) !void {
    switch (value) {
        .string => |task| if (task.len > 0) try list.append(task),
        .array => |tasks| for (tasks.items) |task| {
            if (task == .string and task.string.len > 0) try list.append(task.string);
        },
        else => {},
    }
}

fn installDependencies(
    init: std.process.Init,
    executable_arg: [:0]const u8,
    original_cwd: []const u8,
    destination: []const u8,
    stdout: *std.Io.Writer,
    stderr: *std.Io.Writer,
) !u8 {
    const allocator = init.arena.allocator();
    try stdout.writeAll("\n$ bun install\n");
    try stdout.flush();
    try stderr.flush();

    const destination_z = try allocator.dupeZ(u8, destination);
    const install_args = [_][:0]const u8{ executable_arg, "install", "--cwd", destination_z };
    const code = PackageManager.run(init, &install_args, stdout, stderr) catch |err| {
        std.process.setCurrentPath(init.io, original_cwd) catch {};
        return err;
    };
    try std.process.setCurrentPath(init.io, original_cwd);
    return code;
}

fn runCreateTask(
    init: std.process.Init,
    destination: []const u8,
    task: []const u8,
    through_package_runner: bool,
    stdout: *std.Io.Writer,
    stderr: *std.Io.Writer,
) !void {
    const trimmed = std.mem.trim(u8, task, " \t\r\n");
    if (trimmed.len == 0) return;
    const allocator = init.arena.allocator();
    const executable = try std.process.executablePathAlloc(init.io, allocator);
    const quoted_executable = try shellQuote(allocator, executable);
    const command = if (through_package_runner and !startsWithBunCommand(trimmed))
        try std.fmt.allocPrint(allocator, "{s} run {s}", .{ quoted_executable, trimmed })
    else if (startsWithBunCommand(trimmed))
        try std.fmt.allocPrint(allocator, "{s}{s}", .{ quoted_executable, trimmed["bun".len..] })
    else
        trimmed;

    var environment = try init.environ_map.clone(allocator);
    defer environment.deinit();
    try environment.put("BUN", executable);
    try environment.put("npm_execpath", executable);
    try environment.put("npm_node_execpath", executable);
    const bin_dir = try std.fs.path.join(allocator, &.{ destination, "node_modules", ".bin" });
    const path = if (environment.get("PATH")) |original|
        try std.fmt.allocPrint(allocator, "{s}{c}{s}", .{ bin_dir, std.fs.path.delimiter, original })
    else
        bin_dir;
    try environment.put("PATH", path);

    try stdout.print("\n$ {s}\n", .{task});
    try stdout.flush();
    try stderr.flush();
    const shell_args: []const []const u8 = if (builtin.os.tag == .windows)
        &.{ "cmd.exe", "/d", "/s", "/c", command }
    else
        &.{ "/bin/sh", "-c", command };
    var child = std.process.spawn(init.io, .{
        .argv = shell_args,
        .cwd = .{ .path = destination },
        .environ_map = &environment,
        .stdin = .inherit,
        .stdout = .inherit,
        .stderr = .inherit,
        .create_no_window = true,
    }) catch |err| {
        try stderr.print("warn: unable to run bun-create task \"{s}\": {s}\n", .{ task, @errorName(err) });
        return;
    };
    defer child.kill(init.io);
    _ = try child.wait(init.io);
}

fn initializeGitRepository(
    init: std.process.Init,
    destination: []const u8,
    verbose: bool,
    stderr: *std.Io.Writer,
) !bool {
    const init_code = runGit(init, destination, &.{ "init", "--quiet" }, verbose, stderr) catch return false;
    if (init_code != 0) return false;
    _ = runGit(init, destination, &.{ "add", "--all", "--ignore-errors" }, verbose, stderr) catch {};
    _ = runGit(init, destination, &.{ "commit", "--quiet", "-m", "Initial commit (via bun create)" }, verbose, stderr) catch {};
    return true;
}

fn runGit(
    init: std.process.Init,
    destination: []const u8,
    command: []const []const u8,
    verbose: bool,
    stderr: *std.Io.Writer,
) !u8 {
    const allocator = init.arena.allocator();
    const argv = try allocator.alloc([]const u8, command.len + 3);
    argv[0] = "git";
    argv[1] = "-C";
    argv[2] = destination;
    @memcpy(argv[3..], command);
    if (verbose) {
        try stderr.writeAll("$ git");
        for (argv[1..]) |arg| try stderr.print(" {s}", .{arg});
        try stderr.writeByte('\n');
        try stderr.flush();
    }
    var child = try std.process.spawn(init.io, .{
        .argv = argv,
        .stdin = .inherit,
        .stdout = .inherit,
        .stderr = .inherit,
        .create_no_window = true,
    });
    defer child.kill(init.io);
    const result = try child.wait(init.io);
    return childExitCode(result);
}

fn fetchGitHubArchive(
    init: std.process.Init,
    allocator: std.mem.Allocator,
    repository: GitHubRepository,
    stderr: *std.Io.Writer,
) ![]const u8 {
    const api_base = if (init.environ_map.get("GITHUB_API_URL")) |configured|
        std.mem.trimEnd(u8, configured, "/")
    else if (init.environ_map.get("GITHUB_API_DOMAIN")) |domain|
        if (std.mem.startsWith(u8, domain, "http://") or std.mem.startsWith(u8, domain, "https://"))
            std.mem.trimEnd(u8, domain, "/")
        else
            try std.fmt.allocPrint(allocator, "https://{s}", .{std.mem.trim(u8, domain, "/")})
    else
        "https://api.github.com";
    const url = if (repository.reference.len > 0)
        try std.fmt.allocPrint(allocator, "{s}/repos/{s}/tarball/{s}", .{ api_base, repository.name, repository.reference })
    else
        try std.fmt.allocPrint(allocator, "{s}/repos/{s}/tarball", .{ api_base, repository.name });

    const standard_headers = [_]std.http.Header{
        .{ .name = "accept", .value = "application/vnd.github+json" },
        .{ .name = "user-agent", .value = "Bun/1.3.10" },
    };
    var authorization_headers: [1]std.http.Header = undefined;
    const privileged_headers: []const std.http.Header = if (init.environ_map.get("GITHUB_TOKEN") orelse
        init.environ_map.get("GITHUB_ACCESS_TOKEN")) |token|
    blk: {
        if (token.len == 0) break :blk &.{};
        authorization_headers[0] = .{
            .name = "authorization",
            .value = try std.fmt.allocPrint(allocator, "Bearer {s}", .{token}),
        };
        break :blk &authorization_headers;
    } else &.{};
    return fetchURL(init, allocator, url, &standard_headers, privileged_headers, max_archive_bytes, stderr);
}

fn fetchOfficialArchive(
    init: std.process.Init,
    allocator: std.mem.Allocator,
    name: []const u8,
    stderr: *std.Io.Writer,
) ![]const u8 {
    const metadata_url = try std.fmt.allocPrint(
        allocator,
        "https://registry.npmjs.org/@bun-examples/{s}/latest",
        .{name},
    );
    const accept = [_]std.http.Header{.{ .name = "accept", .value = "application/json" }};
    const metadata_bytes = try fetchURL(init, allocator, metadata_url, &accept, &.{}, max_manifest_bytes, stderr);
    const metadata = std.json.parseFromSliceLeaky(Value, allocator, metadata_bytes, .{}) catch {
        try stderr.print("error: invalid template metadata for {s}\n", .{name});
        return error.CreateErrorReported;
    };
    const dist = if (metadata == .object) metadata.object.get("dist") else null;
    const tarball = if (dist != null and dist.? == .object) dist.?.object.get("tarball") else null;
    if (tarball == null or tarball.? != .string or tarball.?.string.len == 0) {
        try stderr.print("error: template metadata for {s} is missing dist.tarball\n", .{name});
        return error.CreateErrorReported;
    }
    return fetchURL(init, allocator, tarball.?.string, &.{}, &.{}, max_archive_bytes, stderr);
}

fn fetchURL(
    init: std.process.Init,
    allocator: std.mem.Allocator,
    url: []const u8,
    extra_headers: []const std.http.Header,
    privileged_headers: []const std.http.Header,
    limit: usize,
    stderr: *std.Io.Writer,
) ![]const u8 {
    var client: std.http.Client = .{ .allocator = allocator, .io = init.io };
    defer client.deinit();
    client.initDefaultProxies(allocator, init.environ_map) catch {};

    var output: std.Io.Writer.Allocating = .init(allocator);
    const result = client.fetch(.{
        .location = .{ .url = url },
        .response_writer = &output.writer,
        .extra_headers = extra_headers,
        .privileged_headers = privileged_headers,
    }) catch |err| {
        try stderr.print("error: GET {s} - {s}\n", .{ url, @errorName(err) });
        return error.CreateErrorReported;
    };
    const status: u16 = @intFromEnum(result.status);
    if (status < 200 or status >= 300) {
        try stderr.print("error: GET {s} - {d}\n", .{ url, status });
        return error.CreateErrorReported;
    }
    if (output.written().len > limit) return error.ResponseTooLarge;
    return output.toOwnedSlice();
}

fn printSuccess(
    allocator: std.mem.Allocator,
    cwd: []const u8,
    destination: []const u8,
    template: Template,
    requested_template: []const u8,
    start_command: []const u8,
    installed: bool,
    git_created: bool,
    stdout: *std.Io.Writer,
) !void {
    try stdout.writeByte('\n');
    if (git_created and installed) {
        try stdout.writeAll("A local git repository was created and dependencies were installed automatically.\n\n");
    } else if (git_created) {
        try stdout.writeAll("A local git repository was created.\n\n");
    } else if (installed) {
        try stdout.writeAll("Dependencies were installed automatically.\n\n");
    }

    switch (template) {
        .github_repository => |repository| try stdout.print(
            "Success! {s} loaded into {s}\n",
            .{ repository.name, std.fs.path.basename(destination) },
        ),
        else => try stdout.print(
            "Created {s} project successfully\n",
            .{std.fs.path.basename(requested_template)},
        ),
    }

    const relative = try std.fs.path.relative(allocator, cwd, null, cwd, destination);
    try stdout.writeAll("\n# To get started, run:\n\n");
    if (!std.mem.eql(u8, relative, ".") and relative.len > 0) {
        try stdout.print("  cd {s}\n", .{relative});
    }
    try stdout.print("  {s}\n\n", .{start_command});
}

fn parseGitHubRepository(allocator: std.mem.Allocator, input: []const u8) !?GitHubRepository {
    var value = std.mem.trim(u8, input, " \t\r\n/");
    const prefixes = [_][]const u8{ "https://github.com/", "http://github.com/", "github.com/" };
    var had_prefix = false;
    for (prefixes) |prefix| {
        if (std.mem.startsWith(u8, value, prefix)) {
            value = value[prefix.len..];
            had_prefix = true;
            break;
        }
    }
    if (!had_prefix and
        (value.len == 0 or value[0] == '@' or isExplicitPath(value) or std.mem.indexOfScalar(u8, value, ':') != null))
    {
        return null;
    }

    const hash = std.mem.indexOfScalar(u8, value, '#');
    const repository_path = if (hash) |index| value[0..index] else value;
    const reference = if (hash) |index| value[index + 1 ..] else "";
    const slash = std.mem.indexOfScalar(u8, repository_path, '/') orelse return null;
    if (slash == 0 or slash + 1 >= repository_path.len) return null;
    const owner = repository_path[0..slash];
    var repository = repository_path[slash + 1 ..];
    if (std.mem.indexOfScalar(u8, repository, '/')) |next_slash| repository = repository[0..next_slash];
    if (std.mem.endsWith(u8, repository, ".git")) repository = repository[0 .. repository.len - ".git".len];
    if (repository.len == 0) return null;
    return .{
        .name = try std.fmt.allocPrint(allocator, "{s}/{s}", .{ owner, repository }),
        .reference = try allocator.dupe(u8, reference),
    };
}

fn shellQuote(allocator: std.mem.Allocator, value: []const u8) ![]const u8 {
    var output: std.Io.Writer.Allocating = .init(allocator);
    if (builtin.os.tag == .windows) {
        try output.writer.writeByte('"');
        for (value) |byte| {
            if (byte == '"') try output.writer.writeByte('"');
            try output.writer.writeByte(byte);
        }
        try output.writer.writeByte('"');
    } else {
        try output.writer.writeByte('\'');
        for (value) |byte| {
            if (byte == '\'') try output.writer.writeAll("'\\''") else try output.writer.writeByte(byte);
        }
        try output.writer.writeByte('\'');
    }
    return output.toOwnedSlice();
}

fn openBrowser(init: std.process.Init, url: []const u8) !void {
    const argv: []const []const u8 = switch (builtin.os.tag) {
        .windows => &.{ "cmd.exe", "/d", "/s", "/c", "start", "", url },
        .macos => &.{ "open", url },
        else => &.{ "xdg-open", url },
    };
    var child = try std.process.spawn(init.io, .{
        .argv = argv,
        .stdin = .ignore,
        .stdout = .ignore,
        .stderr = .ignore,
        .create_no_window = true,
    });
    defer child.kill(init.io);
    _ = try child.wait(init.io);
}

fn pathsOverlap(left: []const u8, right: []const u8) bool {
    return pathsEqual(left, right) or pathContains(left, right) or pathContains(right, left);
}

fn pathContains(parent: []const u8, child: []const u8) bool {
    if (child.len <= parent.len or !pathStartsWith(child, parent)) return false;
    return child[parent.len] == '/' or child[parent.len] == '\\';
}

fn pathStartsWith(value: []const u8, prefix: []const u8) bool {
    if (builtin.os.tag == .windows) {
        return value.len >= prefix.len and std.ascii.eqlIgnoreCase(value[0..prefix.len], prefix);
    }
    return std.mem.startsWith(u8, value, prefix);
}

fn pathsEqual(left: []const u8, right: []const u8) bool {
    if (builtin.os.tag == .windows) return std.ascii.eqlIgnoreCase(left, right);
    return std.mem.eql(u8, left, right);
}

fn startsWithBunCommand(command: []const u8) bool {
    return std.mem.startsWith(u8, command, "bun") and
        (command.len == "bun".len or std.ascii.isWhitespace(command["bun".len]));
}

fn childExitCode(term: std.process.Child.Term) u8 {
    return switch (term) {
        .exited => |code| @intCast(@min(code, 255)),
        else => 1,
    };
}

fn isExplicitPath(value: []const u8) bool {
    return std.fs.path.isAbsolute(value) or
        std.mem.startsWith(u8, value, "./") or
        std.mem.startsWith(u8, value, "../") or
        std.mem.startsWith(u8, value, ".\\") or
        std.mem.startsWith(u8, value, "..\\");
}

fn isLegacyOfficialTemplate(value: []const u8) bool {
    return std.mem.eql(u8, value, "elysia") or
        std.mem.eql(u8, value, "elysia-buchta") or
        std.mem.eql(u8, value, "stric");
}

fn isNeverConflictPath(path: []const u8) bool {
    for ([_][]const u8{ "README.md", "gitignore", ".gitignore", ".git/" }) |allowed| {
        if (std.mem.eql(u8, path, allowed)) return true;
    }
    return false;
}

fn directoryExists(io: std.Io, path: []const u8) bool {
    const stat = std.Io.Dir.cwd().statFile(io, path, .{}) catch return false;
    return stat.kind == .directory;
}

fn pathExists(io: std.Io, path: []const u8) bool {
    _ = std.Io.Dir.cwd().statFile(io, path, .{ .follow_symlinks = false }) catch return false;
    return true;
}

fn deletePath(io: std.Io, path: []const u8) void {
    const stat = std.Io.Dir.cwd().statFile(io, path, .{ .follow_symlinks = false }) catch return;
    if (stat.kind == .directory) {
        std.Io.Dir.cwd().deleteTree(io, path) catch {};
    } else {
        std.Io.Dir.cwd().deleteFile(io, path) catch {};
    }
}

fn homeEnvironmentName() []const u8 {
    return if (builtin.os.tag == .windows) "USERPROFILE" else "HOME";
}

fn printHelp(writer: *std.Io.Writer) !void {
    try writer.writeAll(
        "Usage:\n" ++
            "  bun create <MyReactComponent.(jsx|tsx)>\n" ++
            "  bun create <template> [...flags] [destination]\n" ++
            "  bun create <github-org/repo> [...flags] [destination]\n\n" ++
            "Flags:\n" ++
            "  --force            Overwrite existing files\n" ++
            "  --no-install       Do not install dependencies\n" ++
            "  --no-git           Do not create a git repository\n" ++
            "  --no-package-json  Do not transform package.json\n" ++
            "  --bun              Run an npm initializer with Bun\n" ++
            "  --open             Start the project and open it in a browser\n" ++
            "  --verbose          Print additional command details\n\n" ++
            "Templates:\n" ++
            "  NPM templates run bunx create-<template>.\n" ++
            "  GitHub repositories are downloaded directly.\n" ++
            "  Local templates are loaded from BUN_CREATE_DIR, ./.bun-create, or $HOME/.bun-create.\n",
    );
}

test "GitHub create template parsing normalizes URLs and shorthand" {
    const allocator = std.testing.allocator;

    const shorthand = (try parseGitHubRepository(allocator, "owner/repository")).?;
    defer allocator.free(shorthand.name);
    defer allocator.free(shorthand.reference);
    try std.testing.expectEqualStrings("owner/repository", shorthand.name);

    const url = (try parseGitHubRepository(allocator, "https://github.com/owner/repository.git#next")).?;
    defer allocator.free(url.name);
    defer allocator.free(url.reference);
    try std.testing.expectEqualStrings("owner/repository", url.name);
    try std.testing.expectEqualStrings("next", url.reference);

    try std.testing.expect((try parseGitHubRepository(allocator, "./local-template")) == null);
}

test "create command scanning distinguishes missing arguments from help-like empty arguments" {
    const missing = [_][:0]const u8{ "bun", "create" };
    try std.testing.expect(scanInvocation(&missing) == .missing);

    const empty = [_][:0]const u8{ "bun", "create", "" };
    try std.testing.expect(scanInvocation(&empty) == .help);

    const invocation_args = [_][:0]const u8{ "bun", "create", "--bun", "vite", "app" };
    const invocation = scanInvocation(&invocation_args).invocation;
    try std.testing.expect(invocation.force_runtime);
    try std.testing.expectEqualStrings("vite", invocation.template);
}
