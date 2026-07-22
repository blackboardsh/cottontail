const std = @import("std");

const Lockfile = @import("package_manager_lockfile.zig");
const package_manager_cli = @import("package_manager_cli.zig");

const Allocator = std.mem.Allocator;
const Value = std.json.Value;

const bun_compat_version = "1.3.10";

const gitignore_default = @embedFile("compiler/src/cli/init/gitignore.default");
const tsconfig_default = @embedFile("compiler/src/cli/init/tsconfig.default.json");
const readme_default = @embedFile("compiler/src/cli/init/README.default.md");
const readme_react = @embedFile("compiler/src/cli/init/README2.default.md");
const agent_rule = @embedFile("compiler/src/cli/init/rule.md");

const Template = enum {
    blank,
    react,
    react_tailwind,
    react_shadcn,
    library,
};

const Options = struct {
    template: Template = .blank,
    minimal: bool = false,
    auto_yes: bool = false,
    help: bool = false,
    destination: ?[]const u8 = null,
};

const TemplateFile = struct {
    path: []const u8,
    contents: []const u8,
};

const react_files = [_]TemplateFile{
    .{ .path = "bunfig.toml", .contents = @embedFile("compiler/src/cli/init/react-app/bunfig.toml") },
    .{ .path = "package.json", .contents = @embedFile("compiler/src/cli/init/react-app/package.json") },
    .{ .path = "tsconfig.json", .contents = @embedFile("compiler/src/cli/init/react-app/tsconfig.json") },
    .{ .path = "bun-env.d.ts", .contents = @embedFile("compiler/src/cli/init/react-app/bun-env.d.ts") },
    .{ .path = ".gitignore", .contents = gitignore_default },
    .{ .path = "src/index.ts", .contents = @embedFile("compiler/src/cli/init/react-app/src/index.ts") },
    .{ .path = "src/App.tsx", .contents = @embedFile("compiler/src/cli/init/react-app/src/App.tsx") },
    .{ .path = "src/index.html", .contents = @embedFile("compiler/src/cli/init/react-app/src/index.html") },
    .{ .path = "src/index.css", .contents = @embedFile("compiler/src/cli/init/react-app/src/index.css") },
    .{ .path = "src/APITester.tsx", .contents = @embedFile("compiler/src/cli/init/react-app/src/APITester.tsx") },
    .{ .path = "src/react.svg", .contents = @embedFile("compiler/src/cli/init/react-app/src/react.svg") },
    .{ .path = "src/frontend.tsx", .contents = @embedFile("compiler/src/cli/init/react-app/src/frontend.tsx") },
    .{ .path = "src/logo.svg", .contents = @embedFile("compiler/src/cli/init/react-app/src/logo.svg") },
};

const react_tailwind_files = [_]TemplateFile{
    .{ .path = "bunfig.toml", .contents = @embedFile("compiler/src/cli/init/react-tailwind/bunfig.toml") },
    .{ .path = "package.json", .contents = @embedFile("compiler/src/cli/init/react-tailwind/package.json") },
    .{ .path = "tsconfig.json", .contents = @embedFile("compiler/src/cli/init/react-tailwind/tsconfig.json") },
    .{ .path = "bun-env.d.ts", .contents = @embedFile("compiler/src/cli/init/react-tailwind/bun-env.d.ts") },
    .{ .path = ".gitignore", .contents = gitignore_default },
    .{ .path = "src/index.ts", .contents = @embedFile("compiler/src/cli/init/react-tailwind/src/index.ts") },
    .{ .path = "src/App.tsx", .contents = @embedFile("compiler/src/cli/init/react-tailwind/src/App.tsx") },
    .{ .path = "src/index.html", .contents = @embedFile("compiler/src/cli/init/react-tailwind/src/index.html") },
    .{ .path = "src/index.css", .contents = @embedFile("compiler/src/cli/init/react-tailwind/src/index.css") },
    .{ .path = "src/APITester.tsx", .contents = @embedFile("compiler/src/cli/init/react-tailwind/src/APITester.tsx") },
    .{ .path = "src/react.svg", .contents = @embedFile("compiler/src/cli/init/react-tailwind/src/react.svg") },
    .{ .path = "src/frontend.tsx", .contents = @embedFile("compiler/src/cli/init/react-tailwind/src/frontend.tsx") },
    .{ .path = "src/logo.svg", .contents = @embedFile("compiler/src/cli/init/react-tailwind/src/logo.svg") },
    .{ .path = "build.ts", .contents = @embedFile("compiler/src/cli/init/react-tailwind/build.ts") },
};

const react_shadcn_files = [_]TemplateFile{
    .{ .path = "bunfig.toml", .contents = @embedFile("compiler/src/cli/init/react-shadcn/bunfig.toml") },
    .{ .path = "styles/globals.css", .contents = @embedFile("compiler/src/cli/init/react-shadcn/styles/globals.css") },
    .{ .path = "package.json", .contents = @embedFile("compiler/src/cli/init/react-shadcn/package.json") },
    .{ .path = "components.json", .contents = @embedFile("compiler/src/cli/init/react-shadcn/components.json") },
    .{ .path = "tsconfig.json", .contents = @embedFile("compiler/src/cli/init/react-shadcn/tsconfig.json") },
    .{ .path = "bun-env.d.ts", .contents = @embedFile("compiler/src/cli/init/react-shadcn/bun-env.d.ts") },
    .{ .path = ".gitignore", .contents = gitignore_default },
    .{ .path = "src/index.ts", .contents = @embedFile("compiler/src/cli/init/react-shadcn/src/index.ts") },
    .{ .path = "src/App.tsx", .contents = @embedFile("compiler/src/cli/init/react-shadcn/src/App.tsx") },
    .{ .path = "src/index.html", .contents = @embedFile("compiler/src/cli/init/react-shadcn/src/index.html") },
    .{ .path = "src/index.css", .contents = @embedFile("compiler/src/cli/init/react-shadcn/src/index.css") },
    .{ .path = "src/components/ui/card.tsx", .contents = @embedFile("compiler/src/cli/init/react-shadcn/src/components/ui/card.tsx") },
    .{ .path = "src/components/ui/label.tsx", .contents = @embedFile("compiler/src/cli/init/react-shadcn/src/components/ui/label.tsx") },
    .{ .path = "src/components/ui/button.tsx", .contents = @embedFile("compiler/src/cli/init/react-shadcn/src/components/ui/button.tsx") },
    .{ .path = "src/components/ui/select.tsx", .contents = @embedFile("compiler/src/cli/init/react-shadcn/src/components/ui/select.tsx") },
    .{ .path = "src/components/ui/input.tsx", .contents = @embedFile("compiler/src/cli/init/react-shadcn/src/components/ui/input.tsx") },
    .{ .path = "src/components/ui/textarea.tsx", .contents = @embedFile("compiler/src/cli/init/react-shadcn/src/components/ui/textarea.tsx") },
    .{ .path = "src/APITester.tsx", .contents = @embedFile("compiler/src/cli/init/react-shadcn/src/APITester.tsx") },
    .{ .path = "src/lib/utils.ts", .contents = @embedFile("compiler/src/cli/init/react-shadcn/src/lib/utils.ts") },
    .{ .path = "src/react.svg", .contents = @embedFile("compiler/src/cli/init/react-shadcn/src/react.svg") },
    .{ .path = "src/frontend.tsx", .contents = @embedFile("compiler/src/cli/init/react-shadcn/src/frontend.tsx") },
    .{ .path = "src/logo.svg", .contents = @embedFile("compiler/src/cli/init/react-shadcn/src/logo.svg") },
    .{ .path = "build.ts", .contents = @embedFile("compiler/src/cli/init/react-shadcn/build.ts") },
};

const help_text =
    \\Usage: bun init [flags] [destination]
    \\
    \\Initialize a Bun project in the current directory.
    \\
    \\Flags:
    \\  -y, --yes              Accept the default blank template
    \\  -m, --minimal          Only create package.json and tsconfig.json
    \\  -r, --react            Create a React application
    \\      --react=tailwind   Create a React + Tailwind application
    \\      --react=shadcn     Create a React + shadcn application
    \\  -h, --help             Print this help
    \\
;

fn parseOptions(args: []const [:0]const u8) Options {
    var options: Options = .{};
    var parse_flags = true;
    for (args) |arg_z| {
        const arg: []const u8 = arg_z;
        if (parse_flags and std.mem.eql(u8, arg, "--")) {
            parse_flags = false;
        } else if (parse_flags and (std.mem.eql(u8, arg, "-h") or std.mem.eql(u8, arg, "--help"))) {
            options.help = true;
        } else if (parse_flags and (std.mem.eql(u8, arg, "-m") or std.mem.eql(u8, arg, "--minimal"))) {
            options.minimal = true;
        } else if (parse_flags and (std.mem.eql(u8, arg, "-y") or std.mem.eql(u8, arg, "--yes"))) {
            options.auto_yes = true;
        } else if (parse_flags and (std.mem.eql(u8, arg, "-r") or std.mem.eql(u8, arg, "--react"))) {
            options.template = .react;
            options.auto_yes = true;
        } else if (parse_flags and (std.mem.eql(u8, arg, "--react=tailwind") or std.mem.eql(u8, arg, "-r=tailwind"))) {
            options.template = .react_tailwind;
            options.auto_yes = true;
        } else if (parse_flags and (std.mem.eql(u8, arg, "--react=shadcn") or std.mem.eql(u8, arg, "-r=shadcn"))) {
            options.template = .react_shadcn;
            options.auto_yes = true;
        } else if (parse_flags and std.mem.startsWith(u8, arg, "-")) {
            continue;
        } else if (options.destination == null) {
            options.destination = arg;
        }
    }
    return options;
}

fn pathExists(io: std.Io, path: []const u8) bool {
    std.Io.Dir.cwd().access(io, path, .{}) catch return false;
    return true;
}

fn normalizePackageName(allocator: Allocator, input: []const u8) ![]const u8 {
    var needs_normalize = false;
    for (input) |byte| {
        if (std.ascii.isUpper(byte) or byte == ' ' or byte == '"' or byte == '\'') {
            needs_normalize = true;
            break;
        }
    }
    if (!needs_normalize) return input;

    const output = try allocator.alloc(u8, input.len);
    for (input, output) |byte, *normalized| {
        normalized.* = if (byte == ' ' or byte == '"' or byte == '\'') '-' else std.ascii.toLower(byte);
    }
    return output;
}

fn chooseTemplate(init: std.process.Init, stderr: *std.Io.Writer) !Template {
    try stderr.writeAll(
        \\Select a project template:
        \\  1. Blank
        \\  2. React
        \\  3. Library
        \\Selection [1]:
    );
    try stderr.flush();

    var input: [128]u8 = undefined;
    const count = std.Io.File.stdin().readStreaming(init.io, &.{input[0..]}) catch 0;
    const answer = std.mem.trim(u8, input[0..count], " \t\r\n");
    if (answer.len == 0 or answer[0] == '1') return .blank;
    if (answer[0] == '2' or std.ascii.toLower(answer[0]) == 'r') return .react;
    if (answer[0] == '3' or std.ascii.toLower(answer[0]) == 'l') return .library;
    return .blank;
}

fn loadPackageJson(init: std.process.Init) !?Value {
    const allocator = init.arena.allocator();
    const source = std.Io.Dir.cwd().readFileAlloc(
        init.io,
        "package.json",
        allocator,
        .limited(16 * 1024 * 1024),
    ) catch return null;
    if (source.len == 0) return null;
    const normalized = Lockfile.normalizeJsonc(allocator, source) catch return null;
    const root = std.json.parseFromSliceLeaky(Value, allocator, normalized, .{
        .duplicate_field_behavior = .use_last,
    }) catch return null;
    if (root != .object) return null;
    return root;
}

fn stringProperty(root: *const Value, name: []const u8) ?[]const u8 {
    const value = root.object.get(name) orelse return null;
    return if (value == .string) value.string else null;
}

fn isJavaScriptLike(path: []const u8) bool {
    const extensions = [_][]const u8{ ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts" };
    const extension = std.fs.path.extension(path);
    for (extensions) |candidate| {
        if (std.mem.eql(u8, extension, candidate)) return true;
    }
    return false;
}

fn inferEntrypoint(init: std.process.Init, minimal: bool) ![]const u8 {
    if (minimal) return "";
    const candidates = [_][]const u8{
        "index.mts",
        "index.tsx",
        "index.ts",
        "index.jsx",
        "index.mjs",
        "index.js",
        "src/index.mts",
        "src/index.tsx",
        "src/index.ts",
        "src/index.jsx",
        "src/index.mjs",
        "src/index.js",
    };
    for (candidates) |candidate| {
        if (pathExists(init.io, candidate)) return candidate;
    }

    var directory = try std.Io.Dir.cwd().openDir(init.io, ".", .{ .iterate = true });
    defer directory.close(init.io);
    var iterator = directory.iterate();
    while (try iterator.next(init.io)) |entry| {
        if (entry.kind == .file and isJavaScriptLike(entry.name)) return "";
    }
    return "index.ts";
}

fn ensureObject(allocator: Allocator, root: *Value, name: []const u8) !*std.json.ObjectMap {
    const entry = try root.object.getOrPut(allocator, name);
    if (!entry.found_existing or entry.value_ptr.* != .object) {
        entry.value_ptr.* = .{ .object = .empty };
    }
    return &entry.value_ptr.object;
}

fn addStringIfMissing(
    allocator: Allocator,
    object: *std.json.ObjectMap,
    name: []const u8,
    value: []const u8,
) !bool {
    if (object.get(name) != null) return false;
    try object.put(allocator, name, .{ .string = value });
    return true;
}

fn objectHas(root: *const Value, section: []const u8, name: []const u8) bool {
    const value = root.object.get(section) orelse return false;
    return value == .object and value.object.get(name) != null;
}

fn writePackageJson(init: std.process.Init, root: Value) !void {
    var output: std.Io.Writer.Allocating = .init(init.arena.allocator());
    try std.json.Stringify.value(root, .{ .whitespace = .indent_2 }, &output.writer);
    try output.writer.writeByte('\n');
    try std.Io.Dir.cwd().writeFile(init.io, .{ .sub_path = "package.json", .data = output.written() });
}

fn renderReadme(allocator: Allocator, template: []const u8, name: []const u8, entrypoint: ?[]const u8) ![]const u8 {
    var rendered = try std.mem.replaceOwned(u8, allocator, template, "{[name]s}", name);
    rendered = try std.mem.replaceOwned(u8, allocator, rendered, "{[bunVersion]s}", bun_compat_version);
    if (entrypoint) |entry| {
        rendered = try std.mem.replaceOwned(u8, allocator, rendered, "{[entryPoint]s}", entry);
    }
    return rendered;
}

fn writeExclusive(
    init: std.process.Init,
    stderr: *std.Io.Writer,
    path: []const u8,
    contents: []const u8,
) !bool {
    if (std.fs.path.dirname(path)) |parent| {
        if (parent.len > 0 and !std.mem.eql(u8, parent, ".")) {
            try std.Io.Dir.cwd().createDirPath(init.io, parent);
        }
    }
    std.Io.Dir.cwd().writeFile(init.io, .{
        .sub_path = path,
        .data = contents,
        .flags = .{ .exclusive = true },
    }) catch |err| switch (err) {
        error.PathAlreadyExists => {
            try stderr.print(" - {s} (already exists, skipping)\n", .{path});
            return false;
        },
        else => return err,
    };
    try stderr.print(" + {s}\n", .{path});
    return true;
}

fn maybeWriteAgentRule(init: std.process.Init, stderr: *std.Io.Writer) !void {
    if (init.environ_map.get("BUN_AGENT_RULE_DISABLED") != null or
        init.environ_map.get("CURSOR_AGENT_RULE_DISABLED") != null or
        init.environ_map.get("CURSOR_TRACE_ID") == null)
    {
        return;
    }
    _ = try writeExclusive(
        init,
        stderr,
        ".cursor/rules/use-bun-instead-of-node-vite-npm-pnpm.mdc",
        agent_rule,
    );
}

fn runInstall(init: std.process.Init, stdout: *std.Io.Writer, stderr: *std.Io.Writer) !u8 {
    const install_args = [_][:0]const u8{ "cottontail", "install" };
    return package_manager_cli.run(init, &install_args, stdout, stderr);
}

fn templateFiles(template: Template) []const TemplateFile {
    return switch (template) {
        .react => &react_files,
        .react_tailwind => &react_tailwind_files,
        .react_shadcn => &react_shadcn_files,
        else => &.{},
    };
}

fn templateName(template: Template) []const u8 {
    return switch (template) {
        .react => "bun-react-template",
        .react_tailwind => "bun-react-tailwind-template",
        .react_shadcn => "bun-react-tailwind-shadcn-template",
        .blank => "bun-blank-template",
        .library => "bun-typescript-library-template",
    };
}

fn initializeReact(
    init: std.process.Init,
    template: Template,
    stdout: *std.Io.Writer,
    stderr: *std.Io.Writer,
) !u8 {
    try maybeWriteAgentRule(init, stderr);
    const allocator = init.arena.allocator();
    for (templateFiles(template)) |file| {
        const contents = if (std.mem.eql(u8, file.path, "README.md"))
            try renderReadme(allocator, readme_react, templateName(template), null)
        else
            file.contents;
        _ = try writeExclusive(init, stderr, file.path, contents);
    }
    try stderr.writeByte('\n');
    try stderr.flush();
    const install_code = try runInstall(init, stdout, stderr);
    if (install_code != 0) return install_code;
    try stderr.writeAll(
        \\New project configured!
        \\
        \\Development:
        \\    bun dev
        \\
        \\Static site:
        \\    bun run build
        \\
        \\Production:
        \\    bun start
        \\
    );
    try stderr.flush();
    return 0;
}

fn initializeBlank(
    init: std.process.Init,
    options: Options,
    template: Template,
    stdout: *std.Io.Writer,
    stderr: *std.Io.Writer,
) !u8 {
    const allocator = init.arena.allocator();
    const cwd = try std.Io.Dir.cwd().realPathFileAlloc(init.io, ".", allocator);
    const basename = std.fs.path.basename(cwd);
    var name = try normalizePackageName(allocator, if (basename.len > 0) basename else "project");

    const loaded = try loadPackageJson(init);
    const did_load = loaded != null;
    var root: Value = loaded orelse .{ .object = .empty };
    if (stringProperty(&root, "name")) |existing_name| name = existing_name;

    const entrypoint = stringProperty(&root, "module") orelse stringProperty(&root, "main") orelse try inferEntrypoint(init, options.minimal);
    const is_library = template == .library;

    if (!options.minimal) {
        try root.object.put(allocator, "name", .{ .string = name });
        if (entrypoint.len > 0) {
            if (root.object.get("module") != null) {
                try root.object.put(allocator, "module", .{ .string = entrypoint });
                try root.object.put(allocator, "type", .{ .string = "module" });
            } else if (root.object.get("main") != null) {
                try root.object.put(allocator, "main", .{ .string = entrypoint });
            } else {
                try root.object.put(allocator, "module", .{ .string = entrypoint });
                try root.object.put(allocator, "type", .{ .string = "module" });
            }
        }
        if (!is_library) try root.object.put(allocator, "private", .{ .bool = true });
    }

    const dev_dependencies = try ensureObject(allocator, &root, "devDependencies");
    const needs_bun_types = try addStringIfMissing(allocator, dev_dependencies, "@types/bun", "latest");
    var needs_typescript = false;
    if (!options.minimal and
        !objectHas(&root, "devDependencies", "typescript") and
        !objectHas(&root, "peerDependencies", "typescript"))
    {
        const peer_dependencies = try ensureObject(allocator, &root, "peerDependencies");
        needs_typescript = try addStringIfMissing(allocator, peer_dependencies, "typescript", "^5");
    }

    try writePackageJson(init, root);
    try stderr.writeAll(" + package.json\n");

    if (!options.minimal and !pathExists(init.io, ".gitignore")) {
        _ = try writeExclusive(init, stderr, ".gitignore", gitignore_default);
    }
    if (!options.minimal) try maybeWriteAgentRule(init, stderr);

    if (entrypoint.len > 0 and !pathExists(init.io, entrypoint)) {
        _ = try writeExclusive(init, stderr, entrypoint, "console.log(\"Hello via Bun!\");\n");
    }

    if (!pathExists(init.io, "tsconfig.json") and !pathExists(init.io, "jsconfig.json")) {
        const config_name = if (std.mem.eql(u8, std.fs.path.extension(entrypoint), ".js") or
            std.mem.eql(u8, std.fs.path.extension(entrypoint), ".jsx") or
            std.mem.eql(u8, std.fs.path.extension(entrypoint), ".mjs") or
            std.mem.eql(u8, std.fs.path.extension(entrypoint), ".cjs"))
            "jsconfig.json"
        else
            "tsconfig.json";
        _ = try writeExclusive(init, stderr, config_name, tsconfig_default);
    }

    if (!options.minimal and
        !pathExists(init.io, "README.md") and
        !pathExists(init.io, "README") and
        !pathExists(init.io, "README.txt") and
        !pathExists(init.io, "README.mdx"))
    {
        const readme = try renderReadme(allocator, readme_default, name, entrypoint);
        _ = try writeExclusive(init, stderr, "README.md", readme);
    }

    if (!did_load and entrypoint.len > 0) {
        try stderr.print("\nTo get started, run:\n\n    bun run {s}\n\n", .{entrypoint});
    }
    try stderr.flush();

    if (needs_bun_types or needs_typescript) return runInstall(init, stdout, stderr);
    return 0;
}

fn runInner(
    init: std.process.Init,
    args: []const [:0]const u8,
    stdout: *std.Io.Writer,
    stderr: *std.Io.Writer,
) !u8 {
    var options = parseOptions(args);
    if (options.help) {
        try stdout.writeAll(help_text);
        try stdout.flush();
        return 0;
    }

    if (options.destination) |destination| {
        std.Io.Dir.cwd().createDirPath(init.io, destination) catch |err| {
            try stderr.print("Failed to create directory {s}: {s}\n", .{ destination, @errorName(err) });
            try stderr.flush();
            return 1;
        };
        std.process.setCurrentPath(init.io, destination) catch |err| {
            try stderr.print("Failed to change directory to {s}: {s}\n", .{ destination, @errorName(err) });
            try stderr.flush();
            return 1;
        };
    }

    const has_package_json = (try loadPackageJson(init)) != null;
    if (!options.auto_yes) {
        if (has_package_json) {
            try stderr.writeAll("note: package.json already exists, configuring existing project\n");
            options.template = .blank;
        } else {
            options.template = try chooseTemplate(init, stderr);
        }
    }

    return switch (options.template) {
        .react, .react_tailwind, .react_shadcn => initializeReact(init, options.template, stdout, stderr),
        .blank, .library => initializeBlank(init, options, options.template, stdout, stderr),
    };
}

pub fn run(
    init: std.process.Init,
    args: []const [:0]const u8,
    stdout: *std.Io.Writer,
    stderr: *std.Io.Writer,
) !u8 {
    return runInner(init, args, stdout, stderr) catch |err| {
        try stderr.print("error: bun init failed: {s}\n", .{@errorName(err)});
        try stderr.flush();
        return 1;
    };
}

test "init package names follow Bun's ASCII normalization" {
    const allocator = std.testing.allocator;
    const normalized = try normalizePackageName(allocator, "My Project's");
    defer allocator.free(normalized);
    try std.testing.expectEqualStrings("my-project-s", normalized);
}

test "init options select the Bun templates" {
    const args = [_][:0]const u8{ "--minimal", "--react=tailwind", "destination" };
    const options = parseOptions(&args);
    try std.testing.expect(options.minimal);
    try std.testing.expect(options.auto_yes);
    try std.testing.expectEqual(Template.react_tailwind, options.template);
    try std.testing.expectEqualStrings("destination", options.destination.?);
}
