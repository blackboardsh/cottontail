const std = @import("std");

pub const StartupOptions = struct {
    sql_preconnect: bool = false,
    user_agent: ?[]const u8 = null,
    fetch_preconnect: std.ArrayList([]const u8) = .empty,

    pub fn parse(allocator: std.mem.Allocator, exec_args: []const [:0]const u8) !StartupOptions {
        var options: StartupOptions = .{};
        var index: usize = 0;
        while (index < exec_args.len) : (index += 1) {
            const arg: []const u8 = exec_args[index];
            if (std.mem.eql(u8, arg, "--sql-preconnect")) {
                options.sql_preconnect = true;
                continue;
            }
            if (std.mem.startsWith(u8, arg, "--user-agent=")) {
                options.user_agent = arg["--user-agent=".len..];
                continue;
            }
            if (std.mem.eql(u8, arg, "--user-agent") and index + 1 < exec_args.len) {
                index += 1;
                options.user_agent = exec_args[index];
                continue;
            }
            if (std.mem.startsWith(u8, arg, "--fetch-preconnect=")) {
                try options.fetch_preconnect.append(allocator, arg["--fetch-preconnect=".len..]);
                continue;
            }
            if (std.mem.eql(u8, arg, "--fetch-preconnect") and index + 1 < exec_args.len) {
                index += 1;
                try options.fetch_preconnect.append(allocator, exec_args[index]);
            }
        }
        return options;
    }

    pub fn requiresFullRuntime(self: *const StartupOptions) bool {
        return self.fetch_preconnect.items.len > 0;
    }

    pub fn appendSource(
        self: *const StartupOptions,
        allocator: std.mem.Allocator,
        output: *std.ArrayList(u8),
        sql_module_path: ?[]const u8,
    ) !void {
        if (self.user_agent) |user_agent| {
            if (user_agent.len > 0) {
                const literal = try jsonStringLiteral(allocator, user_agent);
                try output.appendSlice(allocator, "globalThis.__cottontailDefaultUserAgent = ");
                try output.appendSlice(allocator, literal);
                try output.appendSlice(allocator, ";\n");
            }
        }

        if (self.sql_preconnect) {
            const module_path = sql_module_path orelse return error.MissingSqlRuntimeModule;
            try output.appendSlice(allocator, "const { sql: __ctSqlPreconnect } = await import(");
            try output.appendSlice(allocator, try jsonStringLiteral(allocator, module_path));
            try output.appendSlice(allocator, ");\nvoid __ctSqlPreconnect.connect();\n");
        }

        for (self.fetch_preconnect.items) |url| {
            try output.appendSlice(allocator, "globalThis.fetch.preconnect(");
            try output.appendSlice(allocator, try jsonStringLiteral(allocator, url));
            try output.appendSlice(allocator, ");\n");
        }
    }
};

pub fn flagTakesValue(arg: []const u8) bool {
    if (std.mem.indexOfScalar(u8, arg, '=') != null) return false;
    if (runtimeDefineFlagTakesValue(arg)) return true;
    for ([_][]const u8{
        "-r",
        "--require",
        "--import",
        "--loader",
        "--experimental-loader",
        "--conditions",
        "--feature",
        "--fetch-preconnect",
        "--console-depth",
        "--cpu-prof-dir",
        "--cpu-prof-name",
        "--cpu-prof-interval",
        "--heap-prof-dir",
        "--heap-prof-name",
        "--input-type",
        "--experimental-default-type",
        "--inspect-publish-uid",
        "--icu-data-dir",
        "--preload",
        "--env-file",
        "--env-file-if-exists",
        "--user-agent",
        "--tsconfig-override",
        "--diagnostic-dir",
        "--redirect-warnings",
        "--snapshot-blob",
        "--allow-fs-read",
        "--allow-fs-write",
        "--test-name-pattern",
        "--test-reporter",
        "--test-reporter-destination",
        "--test-shard",
    }) |candidate| {
        if (std.mem.eql(u8, arg, candidate)) return true;
    }
    return false;
}

pub fn executionFlagTakesValue(arg: []const u8) bool {
    if (flagTakesValue(arg)) return true;
    if (std.mem.indexOfScalar(u8, arg, '=') != null) return false;
    for ([_][]const u8{
        "-c",
        "-e",
        "-p",
        "--config",
        "--cwd",
        "--elide-lines",
        "--eval",
        "--filter",
        "--port",
        "--print",
        "--shell",
    }) |candidate| {
        if (std.mem.eql(u8, arg, candidate)) return true;
    }
    return false;
}

pub const RuntimeDefine = struct {
    key: []const u8,
    value: []const u8,
};

pub const RuntimeDefineError = error{
    MissingRuntimeDefineValue,
    InvalidRuntimeDefineValue,
};

pub fn runtimeDefineFlagTakesValue(arg: []const u8) bool {
    return std.mem.eql(u8, arg, "-d") or std.mem.eql(u8, arg, "--define");
}

pub fn inlineRuntimeDefinePayload(arg: []const u8) ?[]const u8 {
    if (std.mem.startsWith(u8, arg, "--define=")) return arg["--define=".len..];
    // Retain Cottontail's build-CLI spelling in runtime mode too.
    if (std.mem.startsWith(u8, arg, "--define:")) return arg["--define:".len..];
    if (std.mem.startsWith(u8, arg, "-d=")) return arg["-d=".len..];
    if (arg.len > "-d".len and std.mem.startsWith(u8, arg, "-d")) return arg["-d".len..];
    return null;
}

pub fn isRuntimeDefineFlag(arg: []const u8) bool {
    return runtimeDefineFlagTakesValue(arg) or inlineRuntimeDefinePayload(arg) != null;
}

pub fn parseRuntimeDefine(payload: []const u8) ?RuntimeDefine {
    const colon = std.mem.indexOfScalar(u8, payload, ':') orelse std.math.maxInt(usize);
    const equals = std.mem.indexOfScalar(u8, payload, '=') orelse std.math.maxInt(usize);
    const separator = @min(colon, equals);
    if (separator == std.math.maxInt(usize)) return null;
    return .{ .key = payload[0..separator], .value = payload[separator + 1 ..] };
}

pub fn runtimeDefineSpan(args: []const [:0]const u8, index: usize) RuntimeDefineError!usize {
    const arg: []const u8 = args[index];
    const payload = inlineRuntimeDefinePayload(arg) orelse payload: {
        if (!runtimeDefineFlagTakesValue(arg)) return 0;
        if (index + 1 >= args.len) return error.MissingRuntimeDefineValue;
        break :payload args[index + 1];
    };
    if (parseRuntimeDefine(payload) == null) return error.InvalidRuntimeDefineValue;
    return if (runtimeDefineFlagTakesValue(arg)) 2 else 1;
}

pub fn collectRuntimeDefines(
    allocator: std.mem.Allocator,
    keys: *std.ArrayList([]const u8),
    values: *std.ArrayList([]const u8),
    exec_args: []const [:0]const u8,
) !void {
    var index: usize = 0;
    while (index < exec_args.len) {
        const span = try runtimeDefineSpan(exec_args, index);
        if (span == 0) {
            index += if (executionFlagTakesValue(exec_args[index]) and index + 1 < exec_args.len) 2 else 1;
            continue;
        }
        const payload = inlineRuntimeDefinePayload(exec_args[index]) orelse exec_args[index + 1];
        const define = parseRuntimeDefine(payload).?;
        try keys.append(allocator, define.key);
        try values.append(allocator, define.value);
        index += span;
    }
}

pub fn runtimeTranspilerCacheEnabled(environ: *const std.process.Environ.Map) bool {
    const value = environ.get("BUN_RUNTIME_TRANSPILER_CACHE_PATH") orelse return false;
    return value.len > 0 and !(value.len == 1 and value[0] == '0');
}

fn jsonStringLiteral(allocator: std.mem.Allocator, value: []const u8) ![]const u8 {
    return std.json.Stringify.valueAlloc(allocator, std.json.Value{ .string = value }, .{});
}

test "startup options preserve the last user agent and collect preconnects" {
    const args = [_][:0]const u8{
        "--user-agent",
        "first",
        "--sql-preconnect",
        "--fetch-preconnect=https://example.com",
        "--user-agent=second",
    };
    var options = try StartupOptions.parse(std.testing.allocator, &args);
    defer options.fetch_preconnect.deinit(std.testing.allocator);
    try std.testing.expect(options.sql_preconnect);
    try std.testing.expectEqualStrings("second", options.user_agent.?);
    try std.testing.expectEqual(@as(usize, 1), options.fetch_preconnect.items.len);
    try std.testing.expect(options.requiresFullRuntime());
}

test "runtime defines accept long short equals and colon forms" {
    const args = [_][:0]const u8{
        "--define",
        "import.meta.url=\"spaced\"",
        "--define=import.meta.path:\"inline\"",
        "--define:IMPORT_META=\"colon-prefix\"",
        "-d",
        "process.env.SHORT=\"spaced-short\"",
        "-dPROCESS_SHORT:\"attached-short\"",
        "-d=PROCESS_EQUALS:\"equals-short\"",
    };
    var keys: std.ArrayList([]const u8) = .empty;
    var values: std.ArrayList([]const u8) = .empty;
    defer keys.deinit(std.testing.allocator);
    defer values.deinit(std.testing.allocator);

    try collectRuntimeDefines(std.testing.allocator, &keys, &values, &args);
    const expected_keys = [_][]const u8{
        "import.meta.url",
        "import.meta.path",
        "IMPORT_META",
        "process.env.SHORT",
        "PROCESS_SHORT",
        "PROCESS_EQUALS",
    };
    const expected_values = [_][]const u8{
        "\"spaced\"",
        "\"inline\"",
        "\"colon-prefix\"",
        "\"spaced-short\"",
        "\"attached-short\"",
        "\"equals-short\"",
    };
    try std.testing.expectEqual(expected_keys.len, keys.items.len);
    try std.testing.expectEqual(expected_values.len, values.items.len);
    for (expected_keys, keys.items) |expected, actual| try std.testing.expectEqualStrings(expected, actual);
    for (expected_values, values.items) |expected, actual| try std.testing.expectEqualStrings(expected, actual);
}

test "runtime define parsing rejects missing separators and values" {
    const invalid_spaced = [_][:0]const u8{ "--define", "NO_SEPARATOR" };
    const invalid_inline = [_][:0]const u8{"--define=NO_SEPARATOR"};
    const missing_long = [_][:0]const u8{"--define"};
    const missing_short = [_][:0]const u8{"-d"};

    try std.testing.expectError(error.InvalidRuntimeDefineValue, runtimeDefineSpan(&invalid_spaced, 0));
    try std.testing.expectError(error.InvalidRuntimeDefineValue, runtimeDefineSpan(&invalid_inline, 0));
    try std.testing.expectError(error.MissingRuntimeDefineValue, runtimeDefineSpan(&missing_long, 0));
    try std.testing.expectError(error.MissingRuntimeDefineValue, runtimeDefineSpan(&missing_short, 0));
}

test "runtime define collection does not inspect other flag values" {
    const args = [_][:0]const u8{
        "-e",
        "--define=NOT_A_FLAG",
        "--user-agent",
        "--define=ALSO_NOT_A_FLAG",
        "--define",
        "REAL_DEFINE:1",
    };
    var keys: std.ArrayList([]const u8) = .empty;
    var values: std.ArrayList([]const u8) = .empty;
    defer keys.deinit(std.testing.allocator);
    defer values.deinit(std.testing.allocator);

    try collectRuntimeDefines(std.testing.allocator, &keys, &values, &args);
    try std.testing.expectEqual(@as(usize, 1), keys.items.len);
    try std.testing.expectEqual(@as(usize, 1), values.items.len);
    try std.testing.expectEqualStrings("REAL_DEFINE", keys.items[0]);
    try std.testing.expectEqualStrings("1", values.items[0]);
}
