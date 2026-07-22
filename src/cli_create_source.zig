const std = @import("std");
const compiler = @import("cottontail_compiler");

const Bunx = @import("package_manager_bunx.zig");
const PackageManager = @import("package_manager_cli.zig");

const Allocator = std.mem.Allocator;

const max_source_bytes = 16 * 1024 * 1024;

const shared_build_ts = @embedFile("compiler/src/cli/create/projects/react-shadcn-spa/REPLACE_ME_WITH_YOUR_APP_FILE_NAME.build.ts");
const shared_client_tsx = @embedFile("compiler/src/cli/create/projects/react-shadcn-spa/REPLACE_ME_WITH_YOUR_APP_FILE_NAME.client.tsx");
const shared_html = @embedFile("compiler/src/cli/create/projects/react-shadcn-spa/REPLACE_ME_WITH_YOUR_APP_FILE_NAME.html");
const shared_package_json = @embedFile("compiler/src/cli/create/projects/react-shadcn-spa/package.json");
const shared_bunfig_toml = @embedFile("compiler/src/cli/create/projects/react-shadcn-spa/bunfig.toml");

const TemplateKind = enum {
    react,
    react_tailwind,
    react_shadcn,

    fn label(self: TemplateKind) []const u8 {
        return switch (self) {
            .react => "React",
            .react_tailwind => "React + Tailwind",
            .react_shadcn => "React + shadcn/ui + Tailwind",
        };
    }
};

const Reason = enum {
    shadcn,
    bun,
    css,
    tsc,
    build,
    html,
    npm,
};

const TemplateFile = struct {
    path: []const u8,
    contents: []const u8,
    reason: Reason,
    overwrite: bool = true,
};

const react_files = [_]TemplateFile{
    .{ .path = "REPLACE_ME_WITH_YOUR_APP_FILE_NAME.build.ts", .contents = shared_build_ts, .reason = .build },
    .{
        .path = "REPLACE_ME_WITH_YOUR_APP_FILE_NAME.css",
        .contents = @embedFile("compiler/src/cli/create/projects/react-spa/REPLACE_ME_WITH_YOUR_APP_FILE_NAME.css"),
        .reason = .css,
        .overwrite = false,
    },
    .{ .path = "REPLACE_ME_WITH_YOUR_APP_FILE_NAME.html", .contents = shared_html, .reason = .html },
    .{ .path = "REPLACE_ME_WITH_YOUR_APP_FILE_NAME.client.tsx", .contents = shared_client_tsx, .reason = .bun },
    .{
        .path = "package.json",
        .contents = @embedFile("compiler/src/cli/create/projects/react-spa/package.json"),
        .reason = .npm,
        .overwrite = false,
    },
};

const react_tailwind_files = [_]TemplateFile{
    .{ .path = "REPLACE_ME_WITH_YOUR_APP_FILE_NAME.build.ts", .contents = shared_build_ts, .reason = .build },
    .{
        .path = "REPLACE_ME_WITH_YOUR_APP_FILE_NAME.css",
        .contents = @embedFile("compiler/src/cli/create/projects/react-tailwind-spa/REPLACE_ME_WITH_YOUR_APP_FILE_NAME.css"),
        .reason = .css,
    },
    .{ .path = "REPLACE_ME_WITH_YOUR_APP_FILE_NAME.html", .contents = shared_html, .reason = .html },
    .{ .path = "REPLACE_ME_WITH_YOUR_APP_FILE_NAME.client.tsx", .contents = shared_client_tsx, .reason = .bun },
    .{ .path = "bunfig.toml", .contents = shared_bunfig_toml, .reason = .bun, .overwrite = false },
    .{ .path = "package.json", .contents = shared_package_json, .reason = .npm, .overwrite = false },
};

const react_shadcn_files = [_]TemplateFile{
    .{
        .path = "lib/utils.ts",
        .contents = @embedFile("compiler/src/cli/create/projects/react-shadcn-spa/lib/utils.ts"),
        .reason = .shadcn,
    },
    .{
        .path = "index.css",
        .contents = @embedFile("compiler/src/cli/create/projects/react-shadcn-spa/styles/index.css"),
        .reason = .shadcn,
    },
    .{ .path = "REPLACE_ME_WITH_YOUR_APP_FILE_NAME.build.ts", .contents = shared_build_ts, .reason = .bun },
    .{ .path = "REPLACE_ME_WITH_YOUR_APP_FILE_NAME.client.tsx", .contents = shared_client_tsx, .reason = .bun },
    .{
        .path = "REPLACE_ME_WITH_YOUR_APP_FILE_NAME.css",
        .contents = @embedFile("compiler/src/cli/create/projects/react-shadcn-spa/REPLACE_ME_WITH_YOUR_APP_FILE_NAME.css"),
        .reason = .css,
    },
    .{ .path = "REPLACE_ME_WITH_YOUR_APP_FILE_NAME.html", .contents = shared_html, .reason = .html },
    .{
        .path = "styles/globals.css",
        .contents = @embedFile("compiler/src/cli/create/projects/react-shadcn-spa/styles/globals.css"),
        .reason = .shadcn,
    },
    .{ .path = "bunfig.toml", .contents = shared_bunfig_toml, .reason = .bun, .overwrite = false },
    .{ .path = "package.json", .contents = shared_package_json, .reason = .npm, .overwrite = false },
    .{
        .path = "tsconfig.json",
        .contents = @embedFile("compiler/src/cli/create/projects/react-shadcn-spa/tsconfig.json"),
        .reason = .tsc,
        .overwrite = false,
    },
    .{
        .path = "components.json",
        .contents = @embedFile("compiler/src/cli/create/projects/react-shadcn-spa/components.json"),
        .reason = .shadcn,
        .overwrite = false,
    },
};

const Analysis = struct {
    dependencies: std.ArrayList([]const u8) = .empty,
    shadcn_components: std.ArrayList([]const u8) = .empty,
    component_export: ?[]const u8 = null,
    uses_tailwind: bool = false,
};

pub const Result = union(enum) {
    exit_code: u8,
    start_dev,
};

pub fn tryRun(
    init: std.process.Init,
    args: []const [:0]const u8,
    stdout: *std.Io.Writer,
    stderr: *std.Io.Writer,
) !?Result {
    const entry_argument = sourceEntryArgument(args) orelse return null;
    const extension = std.fs.path.extension(entry_argument);
    if (!std.ascii.eqlIgnoreCase(extension, ".jsx") and !std.ascii.eqlIgnoreCase(extension, ".tsx")) return null;

    const stat = std.Io.Dir.cwd().statFile(init.io, entry_argument, .{}) catch return null;
    if (stat.kind != .file) return null;

    const code = run(init, args[0], entry_argument, stdout, stderr) catch |err| {
        if (err != error.CreateErrorReported) {
            try stderr.print("error: bun create failed: {s}\n", .{@errorName(err)});
        }
        try stderr.flush();
        return Result{ .exit_code = 1 };
    };
    return code;
}

fn sourceEntryArgument(args: []const [:0]const u8) ?[]const u8 {
    if (args.len <= 2) return null;
    var positional_mode = false;
    for (args[2..]) |arg_z| {
        const arg: []const u8 = arg_z;
        if (!positional_mode and std.mem.eql(u8, arg, "--")) {
            positional_mode = true;
            continue;
        }
        if (!positional_mode and std.mem.startsWith(u8, arg, "-")) continue;
        return arg;
    }
    return null;
}

fn run(
    init: std.process.Init,
    executable_arg: [:0]const u8,
    entry_argument: []const u8,
    stdout: *std.Io.Writer,
    stderr: *std.Io.Writer,
) !Result {
    const allocator = init.arena.allocator();
    const cwd = try std.Io.Dir.cwd().realPathFileAlloc(init.io, ".", allocator);
    const entry_absolute = try std.fs.path.resolve(allocator, &.{ cwd, entry_argument });
    var analysis = try analyze(init, entry_absolute, stderr);

    const component_export = analysis.component_export orelse {
        try stderr.print("error: No component export found in \"{s}\"\n", .{entry_argument});
        try stderr.writeAll(
            "Please add an export to your file. For example:\n\n" ++
                "   export default function MyApp() {\n" ++
                "     return <div>Hello World</div>;\n" ++
                "   }\n\n",
        );
        try stderr.flush();
        return .{ .exit_code = 1 };
    };

    const has_tailwind_dependency = containsDependency(analysis.dependencies.items, "tailwindcss") or
        containsDependency(analysis.dependencies.items, "bun-plugin-tailwind");
    const inject_tailwind = !has_tailwind_dependency and analysis.uses_tailwind;
    if (inject_tailwind) {
        try appendUnique(allocator, &analysis.dependencies, "tailwindcss");
        try appendUnique(allocator, &analysis.dependencies, "bun-plugin-tailwind");
    }

    const inject_shadcn = analysis.shadcn_components.items.len > 0;
    if (inject_shadcn) try addShadcnDependencies(allocator, &analysis.dependencies);

    try forceReact19Dependencies(allocator, &analysis.dependencies);

    const template: TemplateKind = if (inject_shadcn)
        .react_shadcn
    else if (has_tailwind_dependency or inject_tailwind)
        .react_tailwind
    else
        .react;

    const relative_entry = try relativeModulePath(allocator, cwd, entry_absolute);
    const extension = std.fs.path.extension(relative_entry);
    const relative_name = relative_entry[0 .. relative_entry.len - extension.len];
    const basename = std.fs.path.basename(relative_name);

    const generated_files = try generateFiles(init, template, basename, relative_name, component_export, stdout);
    if (analysis.dependencies.items.len > 0) {
        const install_code = try installDependencies(
            init,
            executable_arg,
            analysis.dependencies.items,
            stdout,
            stderr,
        );
        if (install_code != 0) return .{ .exit_code = install_code };
    }

    if (template == .react_shadcn and analysis.shadcn_components.items.len > 0) {
        const shadcn_code = try installShadcnComponents(
            init,
            executable_arg,
            relative_name,
            analysis.shadcn_components.items,
            stdout,
            stderr,
        );
        if (shadcn_code != 0) return .{ .exit_code = shadcn_code };
    }

    if (generated_files) try printConfigured(stdout, template);
    try stdout.flush();
    try stderr.flush();

    return .start_dev;
}

fn analyze(init: std.process.Init, entry_absolute: []const u8, stderr: *std.Io.Writer) !Analysis {
    const allocator = init.arena.allocator();
    compiler.ast.Expr.Data.Store.create();
    compiler.ast.Stmt.Data.Store.create();
    defer compiler.ast.Expr.Data.Store.reset();
    defer compiler.ast.Stmt.Data.Store.reset();

    var result: Analysis = .{};
    var queue: std.ArrayList([]const u8) = .empty;
    var seen = std.StringHashMap(void).init(allocator);
    try queue.append(allocator, entry_absolute);

    var cursor: usize = 0;
    while (cursor < queue.items.len) : (cursor += 1) {
        const path = queue.items[cursor];
        if (seen.contains(path)) continue;
        try seen.put(try allocator.dupe(u8, path), {});

        const loader = loaderForPath(path) orelse continue;
        const contents = std.Io.Dir.cwd().readFileAlloc(
            init.io,
            path,
            allocator,
            .limited(max_source_bytes),
        ) catch |err| {
            try stderr.print("error: unable to read {s}: {s}\n", .{ path, @errorName(err) });
            return error.CreateErrorReported;
        };

        if (loader == .html) {
            if (hasTailwindClassesInHtml(contents)) result.uses_tailwind = true;
            continue;
        }
        if (!loader.isJavaScriptLike()) continue;

        const scans_react_features = loader == .jsx or loader == .tsx;
        if (scans_react_features and hasTailwindClasses(contents)) result.uses_tailwind = true;

        const parser_allocator = compiler.default_allocator;
        var log = compiler.logger.Log.init(parser_allocator);
        defer log.deinit();
        const source = compiler.logger.Source.initPathString(path, contents);
        const define = try compiler.Define.init(parser_allocator, null, null, false, false);
        defer define.deinit();
        var parser_options = compiler.js_parser.Parser.Options.init(.{}, loader);
        var macro_context = compiler.ast.Macro.MacroContext.initStandalone();
        parser_options.macro_context = &macro_context;
        parser_options.bundle = false;
        parser_options.features.top_level_await = true;
        parser_options.features.is_macro_runtime = true;
        var parser = try compiler.js_parser.Parser.init(parser_options, &log, &source, define, parser_allocator);
        const parsed = parser.parse() catch |err| {
            log.print(stderr) catch {};
            if (log.errors == 0) try stderr.print("error: unable to parse {s}: {s}\n", .{ path, @errorName(err) });
            return error.CreateErrorReported;
        };
        var ast = switch (parsed) {
            .ast => |ast| ast,
            .already_bundled, .cached => return error.CreateErrorReported,
        };
        defer ast.deinit();
        if (log.errors > 0) {
            log.print(stderr) catch {};
            return error.CreateErrorReported;
        }

        if (cursor == 0) {
            result.component_export = try chooseComponentExport(
                allocator,
                ast.named_exports.keys(),
                std.fs.path.basename(path),
            );
        }

        for (ast.import_records.slice()) |record| {
            if (record.flags.is_internal or record.flags.is_unused) continue;
            const specifier = stripImportSuffix(record.path.text);
            if (specifier.len == 0) continue;
            if (scans_react_features and std.mem.startsWith(u8, specifier, "@/components/ui/")) {
                const component = specifier["@/components/ui/".len..];
                if (component.len > 0) try appendUnique(allocator, &result.shadcn_components, component);
                continue;
            }
            if (isLocalSpecifier(specifier)) {
                if (try resolveLocalImport(init.io, allocator, path, specifier)) |resolved| {
                    if (loaderForPath(resolved) != null) try queue.append(allocator, resolved);
                }
                continue;
            }
            const package = packageName(specifier) orelse continue;
            if (std.mem.eql(u8, package, "react") or std.mem.eql(u8, package, "react-dom")) continue;
            try appendUnique(allocator, &result.dependencies, package);
        }
    }
    return result;
}

fn loaderForPath(path: []const u8) ?compiler.options.Loader {
    return compiler.options.defaultLoaders.get(std.fs.path.extension(path));
}

fn stripImportSuffix(specifier: []const u8) []const u8 {
    var end = specifier.len;
    if (std.mem.indexOfScalar(u8, specifier, '?')) |index| end = @min(end, index);
    if (std.mem.indexOfScalar(u8, specifier, '#')) |index| end = @min(end, index);
    return specifier[0..end];
}

fn isLocalSpecifier(specifier: []const u8) bool {
    return std.fs.path.isAbsolute(specifier) or
        std.mem.eql(u8, specifier, ".") or
        std.mem.eql(u8, specifier, "..") or
        std.mem.startsWith(u8, specifier, "./") or
        std.mem.startsWith(u8, specifier, "../");
}

fn resolveLocalImport(
    io: std.Io,
    allocator: Allocator,
    importer: []const u8,
    specifier: []const u8,
) !?[]const u8 {
    const base = if (std.fs.path.isAbsolute(specifier))
        try std.fs.path.resolve(allocator, &.{specifier})
    else
        try std.fs.path.resolve(allocator, &.{ std.fs.path.dirname(importer) orelse ".", specifier });

    if (fileExists(io, base)) return base;
    const extensions = [_][]const u8{ ".tsx", ".ts", ".jsx", ".js", ".mts", ".mjs", ".cts", ".cjs", ".html", ".css" };
    if (std.fs.path.extension(base).len == 0) {
        for (extensions) |extension| {
            const candidate = try std.fmt.allocPrint(allocator, "{s}{s}", .{ base, extension });
            if (fileExists(io, candidate)) return candidate;
        }
    }
    if (directoryExists(io, base)) {
        for (extensions) |extension| {
            const filename = try std.fmt.allocPrint(allocator, "index{s}", .{extension});
            const candidate = try std.fs.path.join(allocator, &.{ base, filename });
            if (fileExists(io, candidate)) return candidate;
        }
    }
    return null;
}

fn fileExists(io: std.Io, path: []const u8) bool {
    const stat = std.Io.Dir.cwd().statFile(io, path, .{}) catch return false;
    return stat.kind == .file;
}

fn directoryExists(io: std.Io, path: []const u8) bool {
    const stat = std.Io.Dir.cwd().statFile(io, path, .{}) catch return false;
    return stat.kind == .directory;
}

fn packageName(specifier: []const u8) ?[]const u8 {
    if (specifier.len == 0 or specifier[0] == '#' or
        std.mem.startsWith(u8, specifier, "node:") or
        std.mem.startsWith(u8, specifier, "bun:") or
        std.mem.startsWith(u8, specifier, "data:") or
        std.mem.startsWith(u8, specifier, "file:") or
        std.mem.startsWith(u8, specifier, "http:") or
        std.mem.startsWith(u8, specifier, "https:"))
    {
        return null;
    }
    if (compiler.jsc.ModuleLoader.HardcodedModule.map.get(specifier) != null) return null;
    if (specifier[0] == '@') {
        const scope_end = std.mem.indexOfScalar(u8, specifier, '/') orelse return null;
        const package_end = std.mem.indexOfScalarPos(u8, specifier, scope_end + 1, '/') orelse specifier.len;
        if (scope_end + 1 == package_end) return null;
        return specifier[0..package_end];
    }
    const package_end = std.mem.indexOfScalar(u8, specifier, '/') orelse specifier.len;
    const name = specifier[0..package_end];
    return if (name.len > 0 and std.mem.indexOfScalar(u8, name, ':') == null) name else null;
}

fn hasTailwindClasses(source: []const u8) bool {
    const patterns = [_][]const u8{
        "bg-",      "text-",  "p-",     "m-",     "flex",   "grid", "border",
        "rounded",  "shadow", "hover:", "focus:", "dark:",  "sm:",  "md:",
        "lg:",      "xl:",    "w-",     "h-",     "space-", "gap-", "items-",
        "justify-", "font-",
    };
    var remaining = source;
    while (std.mem.indexOf(u8, remaining, "className=")) |index| {
        remaining = remaining[index + "className=".len ..];
        if (remaining.len == 0) break;
        const quote = remaining[0];
        if (quote != '\'' and quote != '"') {
            remaining = remaining[1..];
            continue;
        }
        remaining = remaining[1..];
        const end = std.mem.indexOfScalar(u8, remaining, quote) orelse break;
        const class_name = remaining[0..end];
        for (patterns) |pattern| {
            if (std.mem.indexOf(u8, class_name, pattern) != null) return true;
        }
        remaining = remaining[end + 1 ..];
    }
    return false;
}

fn hasTailwindClassesInHtml(source: []const u8) bool {
    const patterns = [_][]const u8{
        "bg-",      "text-",  "p-",     "m-",     "flex",   "grid", "border",
        "rounded",  "shadow", "hover:", "focus:", "dark:",  "sm:",  "md:",
        "lg:",      "xl:",    "w-",     "h-",     "space-", "gap-", "items-",
        "justify-", "font-",
    };
    var cursor: usize = 0;
    while (std.mem.indexOfPos(u8, source, cursor, "class")) |index| {
        cursor = index + "class".len;
        if (index > 0 and (std.ascii.isAlphanumeric(source[index - 1]) or source[index - 1] == '-' or source[index - 1] == '_')) continue;

        while (cursor < source.len and std.ascii.isWhitespace(source[cursor])) : (cursor += 1) {}
        if (cursor >= source.len or source[cursor] != '=') continue;
        cursor += 1;
        while (cursor < source.len and std.ascii.isWhitespace(source[cursor])) : (cursor += 1) {}
        if (cursor >= source.len or (source[cursor] != '\'' and source[cursor] != '"')) continue;

        const quote = source[cursor];
        cursor += 1;
        const end = std.mem.indexOfScalarPos(u8, source, cursor, quote) orelse return false;
        const class_name = source[cursor..end];
        for (patterns) |pattern| {
            if (std.mem.indexOf(u8, class_name, pattern) != null) return true;
        }
        cursor = end + 1;
    }
    return false;
}

fn chooseComponentExport(
    allocator: Allocator,
    exports: []const []const u8,
    filename_with_extension: []const u8,
) !?[]const u8 {
    for (exports) |name| if (std.mem.eql(u8, name, "default")) return try allocator.dupe(u8, name);
    if (exports.len == 1) return try allocator.dupe(u8, exports[0]);
    if (exports.len == 0) return null;

    const extension = std.fs.path.extension(filename_with_extension);
    const filename = filename_with_extension[0 .. filename_with_extension.len - extension.len];
    if (filename.len == 0) return null;

    if (std.ascii.isUpper(filename[0]) and compiler.js_lexer.isIdentifier(filename)) {
        for (exports) |name| if (std.mem.eql(u8, name, filename)) return try allocator.dupe(u8, name);
    }

    if (std.ascii.isLower(filename[0])) {
        const candidate = try allocator.dupe(u8, filename);
        candidate[0] = std.ascii.toUpper(candidate[0]);
        if (compiler.js_lexer.isIdentifier(candidate)) {
            for (exports) |name| if (std.mem.eql(u8, name, candidate)) return try allocator.dupe(u8, name);
        }

        var input_index: usize = 0;
        var output_index: usize = 0;
        var capitalize_next = false;
        while (input_index < candidate.len) : (input_index += 1) {
            const byte = candidate[input_index];
            if (byte == ' ' or byte == '-' or byte == '_' or
                (output_index == 0 and !compiler.js_lexer.isIdentifierStart(byte)))
            {
                capitalize_next = true;
                continue;
            }
            candidate[output_index] = if ((output_index == 0 or capitalize_next) and std.ascii.isLower(byte))
                std.ascii.toUpper(byte)
            else
                byte;
            output_index += 1;
            capitalize_next = false;
        }
        for (exports) |name| {
            if (std.mem.eql(u8, name, candidate[0..output_index])) return try allocator.dupe(u8, name);
        }

        if (output_index > 1) {
            for (candidate[1..output_index]) |*byte| byte.* = std.ascii.toLower(byte.*);
        }
        for (exports) |name| {
            if (std.mem.eql(u8, name, candidate[0..output_index])) return try allocator.dupe(u8, name);
        }
    }

    const valid_identifier = try compiler.MutableString.ensureValidIdentifier(filename, allocator);
    for (exports) |name| {
        if (std.mem.eql(u8, name, valid_identifier)) return try allocator.dupe(u8, name);
    }
    for (exports) |name| {
        if (name.len > 0 and std.ascii.isUpper(name[0])) return try allocator.dupe(u8, name);
    }
    return try allocator.dupe(u8, exports[0]);
}

fn appendUnique(allocator: Allocator, list: *std.ArrayList([]const u8), value: []const u8) !void {
    for (list.items) |existing| if (std.mem.eql(u8, existing, value)) return;
    try list.append(allocator, try allocator.dupe(u8, value));
}

fn containsDependency(dependencies: []const []const u8, dependency: []const u8) bool {
    for (dependencies) |item| if (std.mem.eql(u8, item, dependency)) return true;
    return false;
}

fn addShadcnDependencies(allocator: Allocator, dependencies: *std.ArrayList([]const u8)) !void {
    try appendUnique(allocator, dependencies, "tailwindcss-animate");
    try appendUnique(allocator, dependencies, "class-variance-authority");
    try appendUnique(allocator, dependencies, "clsx");
    try appendUnique(allocator, dependencies, "tailwind-merge");
    try appendUnique(allocator, dependencies, "lucide-react");
}

fn forceReact19Dependencies(allocator: Allocator, dependencies: *std.ArrayList([]const u8)) !void {
    removeDependency(dependencies, "react");
    removeDependency(dependencies, "react-dom");
    try appendUnique(allocator, dependencies, "react-dom@19");
    try appendUnique(allocator, dependencies, "react@19");
}

fn removeDependency(dependencies: *std.ArrayList([]const u8), dependency: []const u8) void {
    var index: usize = 0;
    while (index < dependencies.items.len) {
        if (std.mem.eql(u8, dependencies.items[index], dependency)) {
            _ = dependencies.orderedRemove(index);
        } else {
            index += 1;
        }
    }
}

fn relativeModulePath(allocator: Allocator, cwd: []const u8, absolute: []const u8) ![]const u8 {
    const native = try std.fs.path.relative(allocator, cwd, null, cwd, absolute);
    if (std.fs.path.sep == '/') return native;
    const portable = try allocator.dupe(u8, native);
    std.mem.replaceScalar(u8, portable, '\\', '/');
    return portable;
}

fn templateFiles(template: TemplateKind) []const TemplateFile {
    return switch (template) {
        .react => &react_files,
        .react_tailwind => &react_tailwind_files,
        .react_shadcn => &react_shadcn_files,
    };
}

fn renderTemplate(
    allocator: Allocator,
    input: []const u8,
    basename: []const u8,
    relative_name: []const u8,
    component_export: []const u8,
) ![]const u8 {
    var output = try std.mem.replaceOwned(
        u8,
        allocator,
        input,
        "REPLACE_ME_WITH_YOUR_REACT_COMPONENT_EXPORT",
        component_export,
    );
    output = try std.mem.replaceOwned(u8, allocator, output, "REPLACE_ME_WITH_YOUR_APP_BASE_NAME", basename);
    output = try std.mem.replaceOwned(u8, allocator, output, "REPLACE_ME_WITH_YOUR_APP_FILE_NAME", relative_name);
    return output;
}

fn generateFiles(
    init: std.process.Init,
    template: TemplateKind,
    basename: []const u8,
    relative_name: []const u8,
    component_export: []const u8,
    stdout: *std.Io.Writer,
) !bool {
    const allocator = init.arena.allocator();
    const files = templateFiles(template);
    var paths = try allocator.alloc([]const u8, files.len);
    var created = try allocator.alloc(bool, files.len);
    @memset(created, false);
    var max_path_len: usize = 0;
    for (files, 0..) |file, index| {
        paths[index] = try renderTemplate(allocator, file.path, basename, relative_name, component_export);
    }

    for (files, paths, 0..) |file, path, index| {
        if (!file.overwrite and fileExists(init.io, path)) continue;
        const contents = try renderTemplate(allocator, file.contents, basename, relative_name, component_export);
        if (try writeChangedFile(init, path, contents)) {
            created[index] = true;
            max_path_len = @max(max_path_len, path.len);
        }
    }

    var generated = false;
    for (files, paths, created) |file, path, was_created| {
        if (was_created) {
            generated = true;
            try stdout.print(" create  {s}", .{path});
            var padding = max_path_len - path.len;
            while (padding > 0) : (padding -= 1) try stdout.writeByte(' ');
            try stdout.print("   {s}\n", .{@tagName(file.reason)});
        }
    }
    return generated;
}

fn writeChangedFile(init: std.process.Init, path: []const u8, contents: []const u8) !bool {
    if (std.Io.Dir.cwd().readFileAlloc(
        init.io,
        path,
        init.arena.allocator(),
        .limited(max_source_bytes),
    ) catch null) |existing| {
        if (std.mem.eql(u8, existing, contents)) return false;
    }
    if (std.fs.path.dirname(path)) |parent| {
        if (parent.len > 0 and !std.mem.eql(u8, parent, ".")) {
            try std.Io.Dir.cwd().createDirPath(init.io, parent);
        }
    }
    try std.Io.Dir.cwd().writeFile(init.io, .{ .sub_path = path, .data = contents });
    return true;
}

fn installDependencies(
    init: std.process.Init,
    executable_arg: [:0]const u8,
    dependencies: []const []const u8,
    stdout: *std.Io.Writer,
    stderr: *std.Io.Writer,
) !u8 {
    const allocator = init.arena.allocator();
    try stdout.print("\n📦 Auto-installing {d} detected dependencies\n$ bun --only-missing install", .{dependencies.len});
    for (dependencies) |dependency| try stdout.print(" {s}", .{dependency});
    try stdout.writeByte('\n');
    try stdout.flush();

    const args = try allocator.alloc([:0]const u8, dependencies.len + 3);
    args[0] = executable_arg;
    args[1] = "install";
    args[2] = "--only-missing";
    for (dependencies, args[3..]) |dependency, *arg| arg.* = try allocator.dupeZ(u8, dependency);
    return PackageManager.run(init, args, stdout, stderr);
}

fn installShadcnComponents(
    init: std.process.Init,
    executable_arg: [:0]const u8,
    relative_name: []const u8,
    components: []const []const u8,
    stdout: *std.Io.Writer,
    stderr: *std.Io.Writer,
) !u8 {
    const allocator = init.arena.allocator();
    const use_src_dir = std.mem.indexOf(u8, relative_name, "/src") != null;
    try stdout.writeAll("\n😎 Setting up shadcn/ui components\n$ bun x shadcn@canary add");
    if (use_src_dir) try stdout.writeAll(" --src-dir");
    try stdout.writeAll(" -y");
    for (components) |component| try stdout.print(" {s}", .{component});
    try stdout.writeByte('\n');
    try stdout.flush();

    var args: std.ArrayList([:0]const u8) = .empty;
    try args.append(allocator, executable_arg);
    try args.append(allocator, "x");
    try args.append(allocator, "shadcn@canary");
    try args.append(allocator, "add");
    if (use_src_dir) try args.append(allocator, "--src-dir");
    try args.append(allocator, "-y");
    for (components) |component| try args.append(allocator, try allocator.dupeZ(u8, component));
    const code = try Bunx.run(init, args.items, .{ .args_start = 2 }, stdout, stderr);
    if (code == 0) try stdout.writeByte('\n');
    return code;
}

fn printConfigured(stdout: *std.Io.Writer, template: TemplateKind) !void {
    try stdout.print(
        "--------------------------------\n" ++
            "✨ {s} project configured\n\n" ++
            "Development - frontend dev server with hot reload\n\n" ++
            "  bun dev\n\n" ++
            "Production - build optimized assets\n\n" ++
            "  bun run build\n\n" ++
            "Happy bunning! 🐇\n",
        .{template.label()},
    );
}

test "source create detects only direct Tailwind class strings" {
    try std.testing.expect(hasTailwindClasses("<div className=\"grid gap-2\" />"));
    try std.testing.expect(!hasTailwindClasses("<div className={cx(\"hover:scale-105\")} />"));
}

test "source create extracts package roots" {
    try std.testing.expectEqualStrings("react-dom", packageName("react-dom/client").?);
    try std.testing.expectEqualStrings("@scope/pkg", packageName("@scope/pkg/subpath").?);
    try std.testing.expect(packageName("node:fs") == null);
}
