const std = @import("std");
const compiler = @import("cottontail_compiler");

const c_allocator = std.heap.c_allocator;

comptime {
    _ = @sizeOf(compiler.Transpiler);
    _ = @sizeOf(compiler.bundle_v2.BundleV2);
}

const Operation = enum(c_int) {
    transform = 0,
    scan = 1,
    scan_imports = 2,
};

const TransformConfig = struct {
    loader: compiler.options.Loader = .jsx,
    target: compiler.options.Target = .browser,
    minify_whitespace: bool = false,
    minify_identifiers: bool = false,
    minify_syntax: bool = false,
    dead_code_elimination: bool = true,
    tree_shaking: bool = false,
    trim_unused_imports: ?bool = null,
    allow_runtime: bool = false,
    inlining: bool = false,
};

const ImportResult = struct {
    path: []const u8,
    kind: []const u8,
};

const ScanResult = struct {
    imports: []const ImportResult,
    exports: []const []const u8,
};

fn setError(error_out: *?[*:0]u8, comptime fmt: []const u8, args: anytype) void {
    const message = std.fmt.allocPrintSentinel(c_allocator, fmt, args, 0) catch {
        error_out.* = null;
        return;
    };
    error_out.* = message.ptr;
}

fn setLogError(error_out: *?[*:0]u8, log: *const compiler.logger.Log, fallback: anyerror) void {
    for (log.msgs.items) |message| {
        if (message.kind == .err) {
            setError(error_out, "{s}", .{message.data.text});
            return;
        }
    }
    setError(error_out, "JavaScript transform failed: {s}", .{@errorName(fallback)});
}

fn jsonBool(object: std.json.ObjectMap, name: []const u8) ?bool {
    const value = object.get(name) orelse return null;
    return switch (value) {
        .bool => |flag| flag,
        else => null,
    };
}

fn parseLoader(name: []const u8) !compiler.options.Loader {
    const loader = compiler.options.Loader.fromString(name) orelse return error.InvalidLoader;
    if (!loader.isJavaScriptLike()) return error.InvalidLoader;
    return loader;
}

fn parseTarget(name: []const u8) !compiler.options.Target {
    if (std.ascii.eqlIgnoreCase(name, "browser")) return .browser;
    if (std.ascii.eqlIgnoreCase(name, "node")) return .node;
    if (std.ascii.eqlIgnoreCase(name, "bun")) return .bun;
    if (std.ascii.eqlIgnoreCase(name, "bun_macro") or std.ascii.eqlIgnoreCase(name, "macro")) return .bun_macro;
    return error.InvalidTarget;
}

fn parseConfig(options_json: []const u8, loader_override: []const u8, arena: std.mem.Allocator) !struct {
    config: TransformConfig,
    parsed: ?std.json.Parsed(std.json.Value),
} {
    var config: TransformConfig = .{};
    var parsed: ?std.json.Parsed(std.json.Value) = null;

    if (options_json.len > 0) {
        parsed = try std.json.parseFromSlice(std.json.Value, arena, options_json, .{});
        if (parsed.?.value != .object) return error.InvalidOptions;
        const object = parsed.?.value.object;

        if (object.get("loader")) |value| if (value == .string) {
            config.loader = try parseLoader(value.string);
        };
        if (object.get("target")) |value| if (value == .string) {
            config.target = try parseTarget(value.string);
        };
        if (jsonBool(object, "minifyWhitespace")) |value| config.minify_whitespace = value;
        if (jsonBool(object, "deadCodeElimination")) |value| config.dead_code_elimination = value;
        if (jsonBool(object, "treeShaking")) |value| config.tree_shaking = value;
        if (jsonBool(object, "trimUnusedImports")) |value| config.trim_unused_imports = value;
        if (jsonBool(object, "allowBunRuntime")) |value| config.allow_runtime = value;
        if (jsonBool(object, "inline")) |value| config.inlining = value;

        if (object.get("minify")) |value| switch (value) {
            .bool => |flag| {
                config.minify_whitespace = flag;
                config.minify_identifiers = flag;
                config.minify_syntax = flag;
            },
            .object => |minify| {
                if (jsonBool(minify, "whitespace")) |flag| config.minify_whitespace = flag;
                if (jsonBool(minify, "identifiers")) |flag| config.minify_identifiers = flag;
                if (jsonBool(minify, "syntax")) |flag| config.minify_syntax = flag;
            },
            else => return error.InvalidMinifyOption,
        };
    }

    if (loader_override.len > 0) config.loader = try parseLoader(loader_override);
    return .{ .config = config, .parsed = parsed };
}

fn createDefines(
    parsed: ?std.json.Parsed(std.json.Value),
    log: *compiler.logger.Log,
    allocator: std.mem.Allocator,
) !*compiler.Define {
    var raw = compiler.defines.RawDefines.init(allocator);
    defer raw.deinit();

    if (parsed) |document| {
        if (document.value.object.get("define")) |define_value| {
            if (define_value != .object) return error.InvalidDefineOption;
            try raw.ensureTotalCapacity(define_value.object.count());
            var iterator = define_value.object.iterator();
            while (iterator.next()) |entry| {
                if (entry.value_ptr.* != .string) return error.InvalidDefineValue;
                raw.putAssumeCapacity(entry.key_ptr.*, entry.value_ptr.string);
            }
        }
    }

    var user_defines = try compiler.defines.DefineData.fromInput(raw, &.{}, log, allocator);
    defer user_defines.deinit();
    return try compiler.Define.init(allocator, user_defines, null, false, false);
}

fn process(
    operation: Operation,
    source_code: []const u8,
    options_json: []const u8,
    loader_override: []const u8,
    error_out: *?[*:0]u8,
) ![]u8 {
    var arena_state = std.heap.ArenaAllocator.init(c_allocator);
    defer arena_state.deinit();
    const temporary_allocator = arena_state.allocator();
    const allocator = compiler.default_allocator;

    compiler.ast.Expr.Data.Store.create();
    compiler.ast.Stmt.Data.Store.create();
    defer compiler.ast.Expr.Data.Store.reset();
    defer compiler.ast.Stmt.Data.Store.reset();

    const parsed_config = parseConfig(options_json, loader_override, temporary_allocator) catch |err| {
        setError(error_out, "Invalid Bun.Transpiler options: {s}", .{@errorName(err)});
        return err;
    };
    const config = parsed_config.config;

    var log = compiler.logger.Log.init(allocator);
    defer log.deinit();

    const source = compiler.logger.Source.initPathString(config.loader.stdinName(), source_code);
    const define = createDefines(parsed_config.parsed, &log, allocator) catch |err| {
        setLogError(error_out, &log, err);
        return err;
    };
    defer define.deinit();

    var parser_options = compiler.js_parser.Parser.Options.init(.{}, config.loader);
    parser_options.transform_only = operation == .transform and !config.allow_runtime;
    parser_options.tree_shaking = config.tree_shaking;
    parser_options.features.allow_runtime = operation != .transform or config.allow_runtime;
    parser_options.features.top_level_await = true;
    // Vanilla JavaScriptCore does not parse TC39 decorators. Bun's parser
    // already contains the complete lowering pass, so transform JavaScript
    // decorators instead of relying on engine-specific syntax support.
    parser_options.features.standard_decorators = !config.loader.isTypeScript();
    parser_options.features.dead_code_elimination = config.dead_code_elimination;
    parser_options.features.trim_unused_imports = config.trim_unused_imports orelse config.loader.isTypeScript();
    parser_options.features.inlining = config.inlining or config.minify_syntax;
    parser_options.features.minify_syntax = config.minify_syntax;
    parser_options.features.minify_identifiers = config.minify_identifiers;
    parser_options.features.minify_whitespace = config.minify_whitespace;

    var parser = compiler.js_parser.Parser.init(parser_options, &log, &source, define, allocator) catch |err| {
        setLogError(error_out, &log, err);
        return err;
    };
    const result = parser.parse() catch |err| {
        setLogError(error_out, &log, err);
        return err;
    };
    var ast = switch (result) {
        .ast => |ast| ast,
        .already_bundled => {
            if (operation == .transform) return try c_allocator.dupe(u8, source_code);
            const json = if (operation == .scan_imports) "[]" else "{\"imports\":[],\"exports\":[]}";
            return try c_allocator.dupe(u8, json);
        },
        .cached => {
            setError(error_out, "JavaScript transform cache result is unavailable", .{});
            return error.CachedResultUnavailable;
        },
    };
    defer ast.deinit();

    if (log.errors > 0) {
        setLogError(error_out, &log, error.SyntaxError);
        return error.SyntaxError;
    }

    if (operation != .transform) {
        var imports = std.ArrayList(ImportResult).empty;
        for (ast.import_records.slice()) |record| {
            if (record.flags.is_internal) continue;
            if ((config.trim_unused_imports orelse false) and record.flags.is_unused) continue;
            try imports.append(temporary_allocator, .{ .path = record.path.text, .kind = record.kind.label() });
        }

        if (operation == .scan_imports) {
            const json = try std.json.Stringify.valueAlloc(temporary_allocator, imports.items, .{});
            return try c_allocator.dupe(u8, json);
        }

        const scan_result = ScanResult{
            .imports = imports.items,
            .exports = ast.named_exports.keys(),
        };
        const json = try std.json.Stringify.valueAlloc(temporary_allocator, scan_result, .{});
        return try c_allocator.dupe(u8, json);
    }

    var buffer_writer = compiler.js_printer.BufferWriter.init(allocator);
    defer buffer_writer.buffer.deinit();
    var printer = compiler.js_printer.BufferPrinter.init(buffer_writer);

    const symbol_list = compiler.ast.Symbol.List.fromBorrowedSliceDangerous(ast.symbols.slice());
    const nested_symbols = compiler.ast.Symbol.NestedList.fromBorrowedSliceDangerous(&.{symbol_list});
    const symbol_map = compiler.ast.Symbol.Map.initList(nested_symbols);
    _ = compiler.js_printer.printAst(
        *compiler.js_printer.BufferPrinter,
        &printer,
        ast,
        symbol_map,
        &source,
        true,
        .{
            .allocator = allocator,
            .target = config.target,
            .transform_only = !config.allow_runtime,
            .minify_whitespace = config.minify_whitespace,
            .minify_identifiers = config.minify_identifiers,
            .minify_syntax = config.minify_syntax,
            .mangled_props = null,
        },
        false,
    ) catch |err| {
        setLogError(error_out, &log, err);
        return err;
    };

    return try c_allocator.dupe(u8, printer.ctx.written);
}

export fn ct_transpiler_process(
    operation_value: c_int,
    source_ptr: ?[*]const u8,
    source_len: usize,
    options_ptr: ?[*]const u8,
    options_len: usize,
    loader_ptr: ?[*]const u8,
    loader_len: usize,
    out_len: *usize,
    error_out: *?[*:0]u8,
) ?[*]u8 {
    out_len.* = 0;
    error_out.* = null;

    const operation: Operation = switch (operation_value) {
        0 => .transform,
        1 => .scan,
        2 => .scan_imports,
        else => {
            setError(error_out, "Unknown transpiler operation", .{});
            return null;
        },
    };
    const source = if (source_ptr) |ptr| ptr[0..source_len] else if (source_len == 0) "" else {
        setError(error_out, "source pointer is null", .{});
        return null;
    };
    const options = if (options_ptr) |ptr| ptr[0..options_len] else if (options_len == 0) "" else {
        setError(error_out, "options pointer is null", .{});
        return null;
    };
    const loader = if (loader_ptr) |ptr| ptr[0..loader_len] else if (loader_len == 0) "" else {
        setError(error_out, "loader pointer is null", .{});
        return null;
    };

    const output = process(operation, source, options, loader, error_out) catch return null;
    out_len.* = output.len;
    return output.ptr;
}

export fn ct_strip_typescript_types(
    source_ptr: ?[*]const u8,
    source_len: usize,
    mode: c_int,
    out_len: *usize,
    error_out: *?[*:0]u8,
) ?[*]u8 {
    _ = mode;
    return ct_transpiler_process(@intFromEnum(Operation.transform), source_ptr, source_len, "{}", 2, "ts", 2, out_len, error_out);
}

export fn ct_transpiler_free(ptr: ?[*]u8, len: usize) void {
    if (ptr) |value| c_allocator.free(value[0..len]);
}

export fn ct_transpiler_string_free(ptr: ?[*:0]u8) void {
    if (ptr) |value| c_allocator.free(std.mem.span(value));
}

pub fn forceLink() void {
    _ = &ct_transpiler_process;
    _ = &ct_strip_typescript_types;
    _ = &ct_transpiler_free;
    _ = &ct_transpiler_string_free;
}
