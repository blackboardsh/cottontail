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
    return std.mem.eql(u8, arg, "--user-agent");
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
