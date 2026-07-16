pub const namespace: string = "macro";
pub const namespaceWithColon: string = namespace ++ ":";

var macro_process_io: std.Io.Threaded = undefined;
var init_macro_process_io = bun.once(initMacroProcessIo);

fn initMacroProcessIo() void {
    macro_process_io = std.Io.Threaded.init(default_allocator, .{});
}

fn macroProcessIo() std.Io {
    init_macro_process_io.call(.{});
    return macro_process_io.io();
}

pub fn isMacroPath(value: string) bool {
    return strings.hasPrefixComptime(value, namespaceWithColon);
}

/// Cottontail keeps Bun's parser-side macro lowering, but evaluates macro
/// modules in an isolated Cottontail process instead of Bun's custom VM. This
/// keeps macros available with stock JavaScriptCore and also isolates macro
/// globals from the build process.
pub const MacroContext = struct {
    resolver: ?*Resolver,
    env: ?*DotEnv.Loader,
    remap: MacroRemap,
    javascript_object: jsc.JSValue = jsc.JSValue.zero,

    pub fn getRemap(this: MacroContext, path: string) ?MacroRemapEntry {
        if (this.remap.entries.len == 0) return null;
        return this.remap.get(path);
    }

    pub fn init(transpiler: *Transpiler) MacroContext {
        return .{
            .resolver = &transpiler.resolver,
            .env = transpiler.env,
            .remap = transpiler.options.macro_remap,
        };
    }

    pub fn initStandalone() MacroContext {
        return .{
            .resolver = null,
            .env = null,
            .remap = .{},
        };
    }

    pub fn call(
        this: *MacroContext,
        import_record_path: string,
        source_dir: string,
        log: *logger.Log,
        source: *const logger.Source,
        import_range: logger.Range,
        caller: Expr,
        function_name: string,
    ) anyerror!Expr {
        _ = this.env;
        _ = this.javascript_object;

        const path_without_macro_prefix = if (isMacroPath(import_record_path))
            import_record_path[namespaceWithColon.len..]
        else
            import_record_path;

        const input_specifier = if (strings.eqlComptime(path_without_macro_prefix, "bun"))
            path_without_macro_prefix
        else if (this.resolver) |resolver| brk: {
            const resolved = resolver.resolve(source_dir, path_without_macro_prefix, .stmt) catch |err| {
                if (err == error.ModuleNotFound) {
                    log.addResolveError(
                        source,
                        import_range,
                        log.msgs.allocator,
                        "Macro \"{s}\" not found",
                        .{import_record_path},
                        .stmt,
                        err,
                    ) catch unreachable;
                } else {
                    log.addRangeErrorFmt(
                        source,
                        import_range,
                        log.msgs.allocator,
                        "{s} resolving macro \"{s}\"",
                        .{ @errorName(err), import_record_path },
                    ) catch unreachable;
                }
                return err;
            };
            break :brk resolved.path_pair.primary.text;
        } else path_without_macro_prefix;

        const args_source = try printMacroArguments(caller);
        defer default_allocator.free(args_source);

        const io = macroProcessIo();
        var executable_buffer: [std.fs.max_path_bytes]u8 = undefined;
        const executable_len = std.process.executablePath(io, &executable_buffer) catch |err| {
            log.addRangeErrorFmt(
                source,
                import_range,
                log.msgs.allocator,
                "Unable to locate Cottontail for macro evaluation: {s}",
                .{@errorName(err)},
            ) catch unreachable;
            return error.MacroFailed;
        };
        const executable = executable_buffer[0..executable_len];
        const argv = [_][]const u8{
            executable,
            "--cottontail-macro-eval",
            input_specifier,
            function_name,
            args_source,
        };
        const result = std.process.run(default_allocator, io, .{
            .argv = &argv,
            .cwd = .{ .path = if (source_dir.len > 0) source_dir else "." },
            .create_no_window = true,
        }) catch |err| {
            log.addRangeErrorFmt(
                source,
                import_range,
                log.msgs.allocator,
                "Unable to evaluate macro \"{s}\": {s}",
                .{ function_name, @errorName(err) },
            ) catch unreachable;
            return error.MacroFailed;
        };
        defer default_allocator.free(result.stdout);
        defer default_allocator.free(result.stderr);

        const succeeded = switch (result.term) {
            .exited => |code| code == 0,
            else => false,
        };
        if (!succeeded) {
            const detail = std.mem.trim(u8, result.stderr, " \t\r\n");
            log.addRangeErrorFmt(
                source,
                import_range,
                log.msgs.allocator,
                "Macro \"{s}\" failed{s}{s}",
                .{ function_name, if (detail.len > 0) ": " else "", detail },
            ) catch unreachable;
            return error.MacroFailed;
        }

        const marker_index = std.mem.lastIndexOf(u8, result.stdout, result_marker) orelse {
            log.addRangeErrorFmt(
                source,
                import_range,
                log.msgs.allocator,
                "Macro \"{s}\" did not return a serializable value",
                .{function_name},
            ) catch unreachable;
            return error.MacroFailed;
        };
        const payload = std.mem.trim(u8, result.stdout[marker_index + result_marker.len ..], " \t\r\n");
        const parsed = std.json.parseFromSlice(std.json.Value, default_allocator, payload, .{}) catch |err| {
            log.addRangeErrorFmt(
                source,
                import_range,
                log.msgs.allocator,
                "Unable to decode macro \"{s}\" result: {s}",
                .{ function_name, @errorName(err) },
            ) catch unreachable;
            return error.MacroFailed;
        };
        defer parsed.deinit();
        return encodedValueToExpr(parsed.value, caller.loc) catch |err| {
            log.addRangeErrorFmt(
                source,
                import_range,
                log.msgs.allocator,
                "Unsupported value returned by macro \"{s}\": {s}",
                .{ function_name, @errorName(err) },
            ) catch unreachable;
            return error.MacroFailed;
        };
    }
};

const result_marker = "\x1eCOTTONTAIL_MACRO_RESULT:";

fn printMacroArguments(caller: Expr) ![]u8 {
    const call = switch (caller.data) {
        .e_call => |value| value,
        else => return error.UnsupportedMacroCall,
    };

    var output: std.ArrayList(u8) = .empty;
    errdefer output.deinit(default_allocator);
    try output.append(default_allocator, '[');
    for (call.args.slice(), 0..) |argument, index| {
        if (index > 0) try output.append(default_allocator, ',');
        try appendMacroArgument(&output, argument);
    }
    try output.append(default_allocator, ']');
    return output.toOwnedSlice(default_allocator);
}

fn appendMacroArgument(output: *std.ArrayList(u8), expr: Expr) !void {
    switch (expr.data) {
        .e_array => |array| {
            try output.append(default_allocator, '[');
            for (array.items.slice(), 0..) |item, index| {
                if (index > 0) try output.append(default_allocator, ',');
                try appendMacroArgument(output, item);
            }
            try output.append(default_allocator, ']');
        },
        .e_object => |object| {
            try output.append(default_allocator, '{');
            for (object.properties.slice(), 0..) |property, index| {
                if (property.kind != .normal or property.class_static_block != null or
                    property.key == null or property.value == null)
                {
                    return error.@"Cannot convert argument type to JS";
                }
                if (index > 0) try output.append(default_allocator, ',');
                try output.append(default_allocator, '[');
                try appendMacroArgument(output, property.key.?);
                try output.appendSlice(default_allocator, "]:");
                try appendMacroArgument(output, property.value.?);
            }
            try output.append(default_allocator, '}');
        },
        .e_string => |value| {
            value.resolveRopeIfNeeded(default_allocator);
            const string_value = try value.stringCloned(default_allocator);
            defer default_allocator.free(string_value);
            const encoded = try std.json.Stringify.valueAlloc(
                default_allocator,
                std.json.Value{ .string = string_value },
                .{},
            );
            defer default_allocator.free(encoded);
            try output.appendSlice(default_allocator, encoded);
        },
        .e_null => try output.appendSlice(default_allocator, "null"),
        .e_undefined => try output.appendSlice(default_allocator, "undefined"),
        .e_boolean, .e_branch_boolean => |value| try output.appendSlice(
            default_allocator,
            if (value.value) "true" else "false",
        ),
        .e_number => |value| {
            if (std.math.isNan(value.value)) {
                try output.appendSlice(default_allocator, "NaN");
            } else if (std.math.isPositiveInf(value.value)) {
                try output.appendSlice(default_allocator, "Infinity");
            } else if (std.math.isNegativeInf(value.value)) {
                try output.appendSlice(default_allocator, "-Infinity");
            } else if (std.math.isNegativeZero(value.value)) {
                try output.appendSlice(default_allocator, "-0");
            } else {
                const encoded = try std.fmt.allocPrint(default_allocator, "{d}", .{value.value});
                defer default_allocator.free(encoded);
                try output.appendSlice(default_allocator, encoded);
            }
        },
        .e_inlined_enum => |value| try appendMacroArgument(output, value.value),
        .e_identifier,
        .e_import_identifier,
        .e_private_identifier,
        .e_commonjs_export_identifier,
        => return error.@"Cannot convert identifier to JS. Try a statically-known value",
        else => return error.@"Cannot convert argument type to JS",
    }
}

fn encodedField(value: std.json.Value, name: []const u8) !std.json.Value {
    if (value != .object) return error.InvalidEncodedValue;
    return value.object.get(name) orelse error.InvalidEncodedValue;
}

fn encodedValueToExpr(value: std.json.Value, loc: logger.Loc) !Expr {
    const tag_value = try encodedField(value, "t");
    if (tag_value != .string) return error.InvalidEncodedValue;
    const tag = tag_value.string;

    if (strings.eqlComptime(tag, "undefined")) return Expr.init(E.Undefined, .{}, loc);
    if (strings.eqlComptime(tag, "null")) return Expr.init(E.Null, .{}, loc);
    if (strings.eqlComptime(tag, "boolean")) {
        const encoded = try encodedField(value, "v");
        if (encoded != .bool) return error.InvalidEncodedValue;
        return Expr.init(E.Boolean, .{ .value = encoded.bool }, loc);
    }
    if (strings.eqlComptime(tag, "number")) {
        const encoded = try encodedField(value, "v");
        if (encoded != .string) return error.InvalidEncodedValue;
        const number = if (strings.eqlComptime(encoded.string, "NaN"))
            std.math.nan(f64)
        else if (strings.eqlComptime(encoded.string, "Infinity"))
            std.math.inf(f64)
        else if (strings.eqlComptime(encoded.string, "-Infinity"))
            -std.math.inf(f64)
        else
            try std.fmt.parseFloat(f64, encoded.string);
        return Expr.init(E.Number, .{ .value = number }, loc);
    }
    if (strings.eqlComptime(tag, "string")) {
        const encoded = try encodedField(value, "v");
        if (encoded != .string) return error.InvalidEncodedValue;
        return Expr.init(E.String, E.String.init(try default_allocator.dupe(u8, encoded.string)), loc);
    }
    if (strings.eqlComptime(tag, "array")) {
        const encoded = try encodedField(value, "v");
        if (encoded != .array) return error.InvalidEncodedValue;
        const items = try default_allocator.alloc(Expr, encoded.array.items.len);
        for (encoded.array.items, 0..) |item, index| items[index] = try encodedValueToExpr(item, loc);
        return Expr.init(E.Array, .{
            .items = ExprNodeList.fromOwnedSlice(items),
            .was_originally_macro = true,
        }, loc);
    }
    if (strings.eqlComptime(tag, "object")) {
        const encoded = try encodedField(value, "v");
        if (encoded != .array) return error.InvalidEncodedValue;
        var properties = try G.Property.List.initCapacity(default_allocator, encoded.array.items.len);
        for (encoded.array.items) |entry| {
            if (entry != .array or entry.array.items.len != 2 or entry.array.items[0] != .string) {
                return error.InvalidEncodedValue;
            }
            try properties.append(default_allocator, .{
                .key = Expr.init(
                    E.String,
                    E.String.init(try default_allocator.dupe(u8, entry.array.items[0].string)),
                    loc,
                ),
                .value = try encodedValueToExpr(entry.array.items[1], loc),
            });
        }
        return Expr.init(E.Object, .{
            .properties = properties,
            .was_originally_macro = true,
        }, loc);
    }
    return error.InvalidEncodedValue;
}

const std = @import("std");
const bun = @import("bun");
const DotEnv = @import("../dotenv/env_loader.zig");
const MacroRemap = @import("../resolver/package_json.zig").MacroMap;
const MacroRemapEntry = @import("../resolver/package_json.zig").MacroImportReplacementMap;
const Resolver = @import("../resolver/resolver.zig").Resolver;
const Transpiler = bun.Transpiler;
const default_allocator = bun.default_allocator;
const logger = bun.logger;
const strings = bun.strings;
const jsc = bun.jsc;
const Expr = bun.ast.Expr;
const ExprNodeList = bun.ast.ExprNodeList;
const E = bun.ast.E;
const G = bun.ast.G;
const string = []const u8;
