const std = @import("std");
const compiler = @import("cottontail_compiler");

const Allocator = std.mem.Allocator;

const max_source_bytes = 16 * 1024 * 1024;

pub const Analysis = struct {
    dependencies: std.ArrayList([]const u8) = .empty,
    shadcn_components: std.ArrayList([]const u8) = .empty,
    component_export: ?[]const u8 = null,
    uses_tailwind: bool = false,
};

pub fn analyze(init: std.process.Init, entry_absolute: []const u8, stderr: *std.Io.Writer) !Analysis {
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

test "source create detects only direct Tailwind class strings" {
    try std.testing.expect(hasTailwindClasses("<div className=\"grid gap-2\" />"));
    try std.testing.expect(!hasTailwindClasses("<div className={cx(\"hover:scale-105\")} />"));
}

test "source create extracts package roots" {
    try std.testing.expectEqualStrings("react-dom", packageName("react-dom/client").?);
    try std.testing.expectEqualStrings("@scope/pkg", packageName("@scope/pkg/subpath").?);
    try std.testing.expect(packageName("node:fs") == null);
}
