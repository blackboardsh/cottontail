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
    scan_import_ranges = 3,
    scan_module_syntax = 4,
};

const TransformConfig = struct {
    loader: compiler.options.Loader = .jsx,
    target: compiler.options.Target = .browser,
    minify_whitespace: bool = false,
    minify_identifiers: bool = false,
    minify_syntax: bool = false,
    dead_code_elimination: bool = true,
    tree_shaking: bool = false,
    trim_unused_imports: bool = false,
    replace_exports: compiler.js_parser.RuntimeFeatures.ReplaceableExport.Map = .{},
    allow_runtime: bool = false,
    inlining: bool = false,
    initial_indent: usize = 0,
    import_meta_main: ?bool = null,
    preserve_use_strict: bool = false,
    structured_errors: bool = false,
    eval_print: bool = false,
    log_level: compiler.logger.Log.Level = .warn,
};

const structured_diagnostics_prefix = "COTTONTAIL_DIAGNOSTICS:";

const DiagnosticPosition = struct {
    file: []const u8,
    namespace: []const u8,
    line: i32,
    column: i32,
    length: usize,
    offset: usize,
    lineText: ?[]const u8,
};

const DiagnosticNote = struct {
    message: []const u8,
    position: ?DiagnosticPosition,
};

const StructuredDiagnostic = struct {
    message: []const u8,
    level: []const u8,
    position: ?DiagnosticPosition,
    notes: []const DiagnosticNote,
};

fn diagnosticPosition(location: ?compiler.logger.Location) ?DiagnosticPosition {
    const value = location orelse return null;
    return .{
        .file = value.file,
        .namespace = value.namespace,
        .line = value.line,
        .column = value.column,
        .length = value.length,
        .offset = value.offset,
        .lineText = value.line_text,
    };
}

fn exportReplacementValue(
    value: std.json.Value,
    allocator: std.mem.Allocator,
) !?compiler.ast.Expr {
    const loc = compiler.logger.Loc.Empty;
    return switch (value) {
        .bool => |flag| compiler.ast.Expr{
            .data = .{ .e_boolean = .{ .value = flag } },
            .loc = loc,
        },
        .integer => |number| compiler.ast.Expr{
            .data = .{ .e_number = .{ .value = @floatFromInt(number) } },
            .loc = loc,
        },
        .float => |number| compiler.ast.Expr{
            .data = .{ .e_number = .{ .value = number } },
            .loc = loc,
        },
        .null => compiler.ast.Expr{
            .data = .{ .e_null = .{} },
            .loc = loc,
        },
        .string => |string| blk: {
            const string_expr = try allocator.create(compiler.ast.E.String);
            string_expr.* = .{ .data = string };
            break :blk compiler.ast.Expr{
                .data = .{ .e_string = string_expr },
                .loc = loc,
            };
        },
        else => null,
    };
}

const ImportResult = struct {
    path: []const u8,
    kind: []const u8,
};

const ImportRangeResult = struct {
    path: []const u8,
    kind: []const u8,
    start: i32,
    end: i32,
};

const ScanResult = struct {
    imports: []const ImportResult,
    exports: []const []const u8,
};

const ModuleSyntaxResult = struct {
    hasTopLevelAwait: bool,
    exportsKind: []const u8,
};

fn setError(error_out: *?[*:0]u8, comptime fmt: []const u8, args: anytype) void {
    const message = std.fmt.allocPrintSentinel(c_allocator, fmt, args, 0) catch {
        error_out.* = null;
        return;
    };
    error_out.* = message.ptr;
}

fn setStructuredLogError(
    error_out: *?[*:0]u8,
    log: *const compiler.logger.Log,
    allocator: std.mem.Allocator,
) !void {
    var diagnostics = std.ArrayList(StructuredDiagnostic).empty;

    for (log.msgs.items) |message| {
        if (message.kind != .err and message.kind != .warn) continue;

        const notes = try allocator.alloc(DiagnosticNote, message.notes.len);
        for (message.notes, notes) |note, *output| {
            output.* = .{
                .message = note.text,
                .position = diagnosticPosition(note.location),
            };
        }
        try diagnostics.append(allocator, .{
            .message = message.data.text,
            .level = message.kind.string(),
            .position = diagnosticPosition(message.data.location),
            .notes = notes,
        });
    }

    if (diagnostics.items.len == 0) return error.NoStructuredDiagnostics;
    const envelope = .{ .errors = diagnostics.items };
    const json = try std.json.Stringify.valueAlloc(allocator, envelope, .{});
    setError(error_out, "{s}{s}", .{ structured_diagnostics_prefix, json });
}

fn setLogError(
    error_out: *?[*:0]u8,
    log: *const compiler.logger.Log,
    fallback: anyerror,
    structured: bool,
    allocator: std.mem.Allocator,
) void {
    if (structured) {
        setStructuredLogError(error_out, log, allocator) catch {};
        if (error_out.* != null) return;
    }
    var output: std.Io.Writer.Allocating = .init(c_allocator);
    defer output.deinit();
    var count: usize = 0;
    for (log.msgs.items) |*message| {
        if (message.kind != .err and message.kind != .warn) continue;
        if (count > 0) output.writer.writeAll("\n\n") catch break;
        message.writeFormat(&output.writer, false) catch break;
        count += 1;
    }
    if (count > 0) {
        setError(error_out, "{s}", .{output.written()});
        return;
    }
    setError(error_out, "JavaScript transform failed: {s}", .{@errorName(fallback)});
}

fn expectCompilerDiagnostic(
    source: []const u8,
    loader: []const u8,
    expected: []const []const u8,
) !void {
    var error_message: ?[*:0]u8 = null;
    const output = process(.scan_imports, source, "", loader, &error_message) catch null;
    defer if (output) |bytes| c_allocator.free(bytes);
    defer if (error_message) |message| ct_transpiler_string_free(message);
    try std.testing.expect(output == null);
    const text = if (error_message) |message| std.mem.span(message) else return error.MissingCompilerDiagnostic;
    for (expected) |fragment| {
        try std.testing.expect(std.mem.indexOf(u8, text, fragment) != null);
    }
}

test "compiler diagnostics parity retains parser recovery errors" {
    const source =
        \\
        \\const object = {
        \\  a(el) {
        \\  }
        \\  b: async function(first) {
        \\
        \\  }
        \\}
    ;
    try expectCompilerDiagnostic(source, "js", &.{
        "5 |   b: async function(first) {",
        "error: Expected \"}\" but found \"b\"",
        ":5:3",
        "error: Expected \";\" but found \":\"",
        ":5:4",
        "error: Expected identifier but found \"(\"",
        ":5:20",
        "error: Expected \"(\" but found \"first\"",
        ":5:21",
        "8 | }",
        "error: Unexpected }",
        ":8:1",
    });

    try expectCompilerDiagnostic("\nb: async function(first) {\n}\n", "js", &.{
        "2 | b: async function(first) {",
        "error: Cannot use a declaration in a single-statement context",
        ":2:4",
        "error: Expected identifier but found \"(\"",
        ":2:18",
        "error: Expected \"(\" but found \"first\"",
        ":2:19",
    });
}

test "compiler diagnostics parity reports invalid identifier escapes" {
    const cases = [_]struct {
        source: []const u8,
        message: []const u8,
    }{
        .{ .source = "const \\x41 = 1;", .message = "Unexpected escape sequence" },
        .{ .source = "const \\\" = 1;", .message = "Unexpected escaped double quote" },
        .{ .source = "const \\' = 1;", .message = "Unexpected escaped single quote" },
        .{ .source = "const \\` = 1;", .message = "Unexpected escaped backtick" },
        .{ .source = "const \\\\ = 1;", .message = "Unexpected escaped backslash" },
        .{ .source = "const \\z = 1;", .message = "Unexpected escape sequence" },
    };
    for (cases) |case| {
        try expectCompilerDiagnostic(case.source, "js", &.{ case.message, ":1:7" });
    }

    var error_message: ?[*:0]u8 = null;
    const output = try process(
        .transform,
        "const \\u0041 = 1; const \\u{42} = 2; console.log(A, B);",
        "",
        "js",
        &error_message,
    );
    defer c_allocator.free(output);
    defer if (error_message) |message| ct_transpiler_string_free(message);
    try std.testing.expect(error_message == null);
    try std.testing.expect(std.mem.indexOf(u8, output, "console.log(A, B)") != null);
}

test "compiler diagnostics parity rejects malformed JSX without crashing" {
    try expectCompilerDiagnostic(
        "export function x(){return<div a=``/>}",
        "tsx",
        &.{
            "error: Expected \"{\" but found \"`\"",
            ":1:34",
            "error: Unexpected >",
            ":1:37",
        },
    );
}

test "compiler diagnostics parity preserves Unicode property regular expressions" {
    var error_message: ?[*:0]u8 = null;
    const output = try process(
        .transform,
        "export const hangul = /\\p{Script=Hangul}/u;",
        "",
        "js",
        &error_message,
    );
    defer c_allocator.free(output);
    defer if (error_message) |message| ct_transpiler_string_free(message);
    try std.testing.expect(error_message == null);
    try std.testing.expect(std.mem.indexOf(u8, output, "\\p{Script=Hangul}") != null);
}

test "compiler diagnostics parity keeps repeated transpiler output deterministic" {
    const source =
        \\// @pragma jsx foo
        \\import { Foo } from "./foo";
        \\const foo = new Foo();
        \\foo.bar();
        \\export default foo;
        \\export const first = "first" + 123 * 2 + [foo];
        \\export const second = "second" + 123 * 2 + [foo];
        \\export const third = "third" + 123 * 2 + [foo];
    ;

    var baseline_error: ?[*:0]u8 = null;
    const baseline = try process(.transform, source, "", "", &baseline_error);
    defer c_allocator.free(baseline);
    defer if (baseline_error) |message| ct_transpiler_string_free(message);
    try std.testing.expect(baseline_error == null);

    for (0..4) |_| {
        var error_message: ?[*:0]u8 = null;
        const output = try process(.transform, source, "", "", &error_message);
        defer c_allocator.free(output);
        defer if (error_message) |message| ct_transpiler_string_free(message);
        try std.testing.expect(error_message == null);
        try std.testing.expectEqualStrings(baseline, output);
    }
}

fn jsonBool(object: std.json.ObjectMap, name: []const u8) ?bool {
    const value = object.get(name) orelse return null;
    return switch (value) {
        .bool => |flag| flag,
        else => null,
    };
}

fn parseLoader(name: []const u8) !compiler.options.Loader {
    return compiler.options.Loader.fromString(name) orelse return error.InvalidLoader;
}

fn parseTarget(name: []const u8) !compiler.options.Target {
    if (std.ascii.eqlIgnoreCase(name, "browser")) return .browser;
    if (std.ascii.eqlIgnoreCase(name, "node")) return .node;
    if (std.ascii.eqlIgnoreCase(name, "bun")) return .bun;
    if (std.ascii.eqlIgnoreCase(name, "bun_macro") or std.ascii.eqlIgnoreCase(name, "macro")) return .bun_macro;
    return error.InvalidTarget;
}

fn parseLogLevel(name: []const u8) !compiler.logger.Log.Level {
    if (std.mem.eql(u8, name, "verbose")) return .verbose;
    if (std.mem.eql(u8, name, "debug")) return .debug;
    if (std.mem.eql(u8, name, "info")) return .info;
    if (std.mem.eql(u8, name, "warn")) return .warn;
    if (std.mem.eql(u8, name, "error")) return .err;
    return error.InvalidLogLevel;
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
        if (object.get("logLevel")) |value| if (value == .string) {
            config.log_level = try parseLogLevel(value.string);
        };
        if (jsonBool(object, "minifyWhitespace")) |value| config.minify_whitespace = value;
        if (jsonBool(object, "deadCodeElimination")) |value| config.dead_code_elimination = value;
        const tree_shaking_option = jsonBool(object, "treeShaking");
        if (tree_shaking_option) |value| config.tree_shaking = value;
        const trim_unused_imports_option = jsonBool(object, "trimUnusedImports");
        if (trim_unused_imports_option) |value| config.trim_unused_imports = value;
        if (jsonBool(object, "allowBunRuntime")) |value| config.allow_runtime = value;
        if (jsonBool(object, "inline")) |value| config.inlining = value;
        if (jsonBool(object, "_cottontailImportMetaMain")) |value| config.import_meta_main = value;
        if (jsonBool(object, "_cottontailPreserveUseStrict")) |value| config.preserve_use_strict = value;
        if (jsonBool(object, "_cottontailStructuredErrors")) |value| config.structured_errors = value;
        if (jsonBool(object, "_cottontailEvalPrint")) |value| config.eval_print = value;
        if (object.get("_cottontailInitialIndent")) |value| switch (value) {
            .integer => |count| {
                if (count < 0 or count > 64) return error.InvalidIndentOption;
                config.initial_indent = @intCast(count);
            },
            else => return error.InvalidIndentOption,
        };

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

        if (object.get("exports")) |exports_value| {
            if (exports_value != .object) return error.InvalidExportsOption;
            const exports = exports_value.object;

            const eliminate_count = if (exports.get("eliminate")) |eliminate|
                if (eliminate == .array) eliminate.array.items.len else return error.InvalidExportsEliminate
            else
                0;
            const replace_count = if (exports.get("replace")) |replace|
                if (replace == .object) replace.object.count() else return error.InvalidExportsReplace
            else
                0;
            try config.replace_exports.ensureUnusedCapacity(arena, eliminate_count + replace_count);

            if (exports.get("eliminate")) |eliminate| {
                for (eliminate.array.items) |name_value| {
                    if (name_value != .string or name_value.string.len == 0) continue;
                    config.replace_exports.putAssumeCapacity(name_value.string, .{ .delete = {} });
                }
            }

            if (exports.get("replace")) |replace| {
                var iterator = replace.object.iterator();
                while (iterator.next()) |entry| {
                    if (!compiler.js_lexer.isIdentifier(entry.key_ptr.*)) return error.InvalidExportIdentifier;
                    const map_entry = config.replace_exports.getOrPutAssumeCapacity(entry.key_ptr.*);
                    if (try exportReplacementValue(entry.value_ptr.*, arena)) |replacement| {
                        map_entry.value_ptr.* = .{ .replace = replacement };
                        continue;
                    }

                    if (entry.value_ptr.* == .array and entry.value_ptr.array.items.len == 2) {
                        const pair = entry.value_ptr.array.items;
                        if (pair[0] == .string and compiler.js_lexer.isIdentifier(pair[0].string)) {
                            if (try exportReplacementValue(pair[1], arena)) |replacement| {
                                map_entry.value_ptr.* = .{ .inject = .{
                                    .name = pair[0].string,
                                    .value = replacement,
                                } };
                                continue;
                            }
                        }
                    }
                    return error.InvalidExportReplacement;
                }
            }

            if (tree_shaking_option == null and config.replace_exports.count() > 0) {
                config.tree_shaking = true;
            }
        }

        // Bun resolves an omitted trimUnusedImports option after export
        // replacement has had a chance to enable tree shaking.
        if (trim_unused_imports_option == null) config.trim_unused_imports = config.tree_shaking;
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
    log.level = config.log_level;

    const source = compiler.logger.Source.initPathString(config.loader.stdinName(), source_code);

    if (config.loader == .html and operation == .scan_imports) {
        var scanner = compiler.bundle_v2.HTMLScanner.init(temporary_allocator, &log, &source);
        defer scanner.deinit();
        scanner.scan(source_code) catch |err| {
            setLogError(error_out, &log, err, config.structured_errors, temporary_allocator);
            return err;
        };
        if (log.errors + log.warnings > 0) {
            setLogError(error_out, &log, error.SyntaxError, config.structured_errors, temporary_allocator);
            return error.SyntaxError;
        }

        var imports = std.ArrayList(ImportResult).empty;
        for (scanner.import_records.slice()) |record| {
            try imports.append(temporary_allocator, .{ .path = record.path.text, .kind = record.kind.label() });
        }
        const json = try std.json.Stringify.valueAlloc(temporary_allocator, imports.items, .{});
        return try c_allocator.dupe(u8, json);
    }

    if (!config.loader.isJavaScriptLike()) {
        setError(error_out, "Loader \"{s}\" is not supported by this transpiler operation", .{@tagName(config.loader)});
        return error.InvalidLoader;
    }

    const define = createDefines(parsed_config.parsed, &log, allocator) catch |err| {
        setLogError(error_out, &log, err, config.structured_errors, temporary_allocator);
        return err;
    };
    defer define.deinit();

    var parser_options = compiler.js_parser.Parser.Options.init(.{}, config.loader);
    var macro_context = compiler.ast.Macro.MacroContext.initStandalone();
    parser_options.macro_context = &macro_context;
    parser_options.transform_only = operation == .transform and !config.allow_runtime;
    parser_options.tree_shaking = config.tree_shaking;
    parser_options.features.allow_runtime = operation != .transform or config.allow_runtime;
    // Scanning reports macro imports but must not execute them. Unlike the
    // bundler, the standalone scanner has no project resolver/macro context.
    parser_options.features.is_macro_runtime = operation != .transform;
    parser_options.features.top_level_await = true;
    // Vanilla JavaScriptCore does not parse TC39 decorators. Bun's parser
    // already contains the complete lowering pass, so transform JavaScript
    // decorators instead of relying on engine-specific syntax support.
    parser_options.features.standard_decorators = !config.loader.isTypeScript();
    parser_options.features.dead_code_elimination = config.dead_code_elimination;
    parser_options.features.trim_unused_imports = config.trim_unused_imports;
    parser_options.features.replace_exports = config.replace_exports;
    parser_options.features.inlining = config.inlining or config.minify_syntax;
    parser_options.features.minify_syntax = config.minify_syntax;
    parser_options.features.minify_identifiers = config.minify_identifiers;
    parser_options.features.minify_whitespace = config.minify_whitespace;
    parser_options.import_meta_main_value = config.import_meta_main;

    var parser = compiler.js_parser.Parser.init(parser_options, &log, &source, define, allocator) catch |err| {
        setLogError(error_out, &log, err, config.structured_errors, temporary_allocator);
        return err;
    };
    const result = parser.parse() catch |err| {
        setLogError(error_out, &log, err, config.structured_errors, temporary_allocator);
        return err;
    };
    // Error recovery can still produce a result tag. Inspect diagnostics before
    // honoring early-return tags such as `already_bundled`, or malformed input
    // can be returned unchanged instead of throwing from Bun.Transpiler.
    if (log.errors + log.warnings > 0) {
        setLogError(error_out, &log, error.SyntaxError, config.structured_errors, temporary_allocator);
        return error.SyntaxError;
    }
    var ast = switch (result) {
        .ast => |ast| ast,
        .already_bundled => {
            if (operation == .transform) return try c_allocator.dupe(u8, source_code);
            const json = switch (operation) {
                .scan_imports, .scan_import_ranges => "[]",
                .scan_module_syntax => "{\"hasTopLevelAwait\":false,\"exportsKind\":\"none\"}",
                else => "{\"imports\":[],\"exports\":[]}",
            };
            return try c_allocator.dupe(u8, json);
        },
        .cached => {
            setError(error_out, "JavaScript transform cache result is unavailable", .{});
            return error.CachedResultUnavailable;
        },
    };
    defer ast.deinit();

    if (config.eval_print) {
        var parts = ast.parts.slice();
        var part_index = parts.len;
        outer: while (part_index > 0) {
            part_index -= 1;
            var statement_index = parts[part_index].stmts.len;
            while (statement_index > 0) {
                statement_index -= 1;
                const statement = &parts[part_index].stmts[statement_index];
                if (statement.data != .s_expr) continue;
                const expression = statement.data.s_expr.value;
                statement.* = compiler.ast.Stmt.alloc(
                    compiler.ast.S.ExportDefault,
                    compiler.ast.S.ExportDefault{
                        .value = .{ .expr = expression },
                        .default_name = .{ .loc = statement.loc, .ref = compiler.ast.Ref.None },
                    },
                    statement.loc,
                );
                break :outer;
            }
        }
    }

    if (operation != .transform) {
        if (operation == .scan_module_syntax) {
            const syntax = ModuleSyntaxResult{
                .hasTopLevelAwait = !ast.top_level_await_keyword.isEmpty(),
                .exportsKind = @tagName(ast.exports_kind),
            };
            const json = try std.json.Stringify.valueAlloc(temporary_allocator, syntax, .{});
            return try c_allocator.dupe(u8, json);
        }

        if (operation == .scan_import_ranges) {
            var imports = std.ArrayList(ImportRangeResult).empty;
            for (ast.import_records.slice()) |record| {
                if (record.flags.is_internal or record.flags.is_unused) continue;
                try imports.append(temporary_allocator, .{
                    .path = record.path.text,
                    .kind = record.kind.label(),
                    .start = record.range.loc.start,
                    .end = record.range.loc.start + record.range.len,
                });
            }
            const json = try std.json.Stringify.valueAlloc(temporary_allocator, imports.items, .{});
            return try c_allocator.dupe(u8, json);
        }

        var imports = std.ArrayList(ImportResult).empty;
        for (ast.import_records.slice()) |record| {
            if (record.flags.is_internal) continue;
            if (config.trim_unused_imports and record.flags.is_unused) continue;
            try imports.append(temporary_allocator, .{ .path = record.path.text, .kind = record.kind.label() });
        }

        if (operation == .scan_imports) {
            const json = try std.json.Stringify.valueAlloc(temporary_allocator, imports.items, .{});
            return try c_allocator.dupe(u8, json);
        }

        const named_exports = try temporary_allocator.dupe([]const u8, ast.named_exports.keys());
        std.mem.sortUnstable([]const u8, named_exports, {}, struct {
            fn lessThan(_: void, left: []const u8, right: []const u8) bool {
                return std.mem.lessThan(u8, left, right);
            }
        }.lessThan);
        const scan_result = ScanResult{
            .imports = imports.items,
            .exports = named_exports,
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
    const print_options = compiler.js_printer.Options{
        .allocator = allocator,
        .target = config.target,
        .transform_only = !config.allow_runtime,
        .minify_whitespace = config.minify_whitespace,
        .minify_identifiers = config.minify_identifiers,
        .minify_syntax = config.minify_syntax,
        .print_dce_annotations = false,
        .mangled_props = null,
        .indent = .{ .count = config.initial_indent },
    };
    const print_result = if (config.target.isBun())
        compiler.js_printer.printAst(
            *compiler.js_printer.BufferPrinter,
            &printer,
            ast,
            symbol_map,
            &source,
            true,
            print_options,
            false,
        )
    else
        compiler.js_printer.printAst(
            *compiler.js_printer.BufferPrinter,
            &printer,
            ast,
            symbol_map,
            &source,
            false,
            print_options,
            false,
        );
    _ = print_result catch |err| {
        setLogError(error_out, &log, err, config.structured_errors, temporary_allocator);
        return err;
    };

    if (config.preserve_use_strict and std.mem.eql(u8, ast.directive orelse "", "use strict")) {
        const indent_len = config.initial_indent * 2;
        const directive = "\"use strict\";\n";
        const output = try c_allocator.alloc(u8, indent_len + directive.len + printer.ctx.written.len);
        @memset(output[0..indent_len], ' ');
        @memcpy(output[indent_len .. indent_len + directive.len], directive);
        @memcpy(output[indent_len + directive.len ..], printer.ctx.written);
        return output;
    }

    return try c_allocator.dupe(u8, printer.ctx.written);
}

pub fn scanImportsJson(source_code: []const u8, loader: []const u8) ![]u8 {
    var error_message: ?[*:0]u8 = null;
    defer if (error_message) |message| ct_transpiler_string_free(message);
    return process(.scan_imports, source_code, "", loader, &error_message);
}

pub fn scanImportRangesJson(source_code: []const u8, loader: []const u8) ![]u8 {
    var error_message: ?[*:0]u8 = null;
    defer if (error_message) |message| ct_transpiler_string_free(message);
    return process(.scan_import_ranges, source_code, "", loader, &error_message);
}

pub fn scanModuleSyntaxJson(source_code: []const u8, loader: []const u8) ![]u8 {
    var error_message: ?[*:0]u8 = null;
    defer if (error_message) |message| ct_transpiler_string_free(message);
    return process(.scan_module_syntax, source_code, "", loader, &error_message);
}

pub fn scanImportsJsonWithError(
    source_code: []const u8,
    loader: []const u8,
    error_out: *?[*:0]u8,
) ![]u8 {
    return process(.scan_imports, source_code, "", loader, error_out);
}

pub fn transformEntrypointImportMetaMain(source_code: []const u8, loader: []const u8) ![]u8 {
    var error_message: ?[*:0]u8 = null;
    defer if (error_message) |message| ct_transpiler_string_free(message);
    return process(.transform, source_code, "{\"_cottontailImportMetaMain\":true}", loader, &error_message);
}

pub fn transformEvalPrintModule(source_code: []const u8, error_out: *?[*:0]u8) ![]u8 {
    const transformed = try process(
        .transform,
        source_code,
        "{\"target\":\"bun\",\"deadCodeElimination\":false,\"allowBunRuntime\":true,\"_cottontailEvalPrint\":true}",
        "tsx",
        error_out,
    );
    const helper_prefix = "jsxDEV_";
    const helper_start = std.mem.indexOf(u8, transformed, helper_prefix) orelse return transformed;
    var helper_end = helper_start + helper_prefix.len;
    while (helper_end < transformed.len and
        (std.ascii.isAlphanumeric(transformed[helper_end]) or transformed[helper_end] == '_' or transformed[helper_end] == '$'))
    {
        helper_end += 1;
    }
    const helper_name = transformed[helper_start..helper_end];
    const prelude = try std.fmt.allocPrint(
        c_allocator,
        "import {{ jsxDEV as {s} }} from \"react/jsx-dev-runtime\";\n",
        .{helper_name},
    );
    defer c_allocator.free(prelude);
    const result = try c_allocator.alloc(u8, prelude.len + transformed.len);
    @memcpy(result[0..prelude.len], prelude);
    @memcpy(result[prelude.len..], transformed);
    c_allocator.free(transformed);
    return result;
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
        3 => .scan_import_ranges,
        4 => .scan_module_syntax,
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

pub export fn ct_transpiler_string_free(ptr: ?[*:0]u8) void {
    if (ptr) |value| c_allocator.free(std.mem.span(value));
}

pub fn forceLink() void {
    _ = &ct_transpiler_process;
    _ = &ct_strip_typescript_types;
    _ = &ct_transpiler_free;
    _ = &ct_transpiler_string_free;
}

test "module syntax scan distinguishes top-level and nested await" {
    const top_level_json = try scanModuleSyntaxJson("const value = await Promise.resolve(1);", "js");
    defer c_allocator.free(top_level_json);
    const nested_json = try scanModuleSyntaxJson("async function nested() { await Promise.resolve(1); }", "js");
    defer c_allocator.free(nested_json);

    const Syntax = struct {
        hasTopLevelAwait: bool,
        exportsKind: []const u8,
    };
    const top_level = try std.json.parseFromSlice(Syntax, std.testing.allocator, top_level_json, .{});
    defer top_level.deinit();
    const nested = try std.json.parseFromSlice(Syntax, std.testing.allocator, nested_json, .{});
    defer nested.deinit();

    try std.testing.expect(top_level.value.hasTopLevelAwait);
    try std.testing.expectEqualStrings("esm", top_level.value.exportsKind);
    try std.testing.expect(!nested.value.hasTopLevelAwait);
}
