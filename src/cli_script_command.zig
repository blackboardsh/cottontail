const std = @import("std");
const builtin = @import("builtin");

const yarn_commands = [_][]const u8{
    "access",              "add",                "audit",   "autoclean",           "bin",
    "cache",               "check",              "config",  "create",              "dedupe",
    "dlx",                 "exec",               "explain", "generate-lock-entry", "generateLockEntry",
    "global",              "help",               "import",  "info",                "init",
    "install",             "licenses",           "link",    "list",                "login",
    "logout",              "node",               "npm",     "outdated",            "owner",
    "pack",                "patch",              "plugin",  "policies",            "publish",
    "rebuild",             "remove",             "run",     "set",                 "tag",
    "team",                "unlink",             "unplug",  "up",                  "upgrade",
    "upgrade-interactive", "upgradeInteractive", "version", "versions",            "why",
    "workspace",           "workspaces",
};

fn isYarnCommand(command: []const u8) bool {
    for (yarn_commands) |candidate| {
        if (std.mem.eql(u8, command, candidate)) return true;
    }
    return false;
}

fn quoteExecutable(allocator: std.mem.Allocator, executable: []const u8) ![]const u8 {
    if (builtin.os.tag == .windows) return std.fmt.allocPrint(allocator, "\"{s}\"", .{executable});

    var quoted = std.array_list.Managed(u8).init(allocator);
    try quoted.append('\'');
    for (executable) |byte| {
        if (byte == '\'') {
            try quoted.appendSlice("'\\''");
        } else {
            try quoted.append(byte);
        }
    }
    try quoted.append('\'');
    return try quoted.toOwnedSlice();
}

fn commandTokenMatches(remainder: []const u8, command: []const u8) bool {
    if (!std.mem.startsWith(u8, remainder, command)) return false;
    return remainder.len == command.len or std.ascii.isWhitespace(remainder[command.len]);
}

/// Bun routes nested package-manager script calls back through `bun run`.
/// Cottontail also replaces a literal `bun` executable because its stock-JSC
/// binary is normally installed under a different name.
pub fn replacePackageManagerRun(
    allocator: std.mem.Allocator,
    io: std.Io,
    script: []const u8,
) ![]const u8 {
    const executable = try std.process.executablePathAlloc(io, allocator);
    defer allocator.free(executable);
    const bun_command = try quoteExecutable(allocator, executable);
    defer allocator.free(bun_command);

    var rewritten = try std.array_list.Managed(u8).initCapacity(allocator, script.len + bun_command.len);
    var entry_index: usize = 0;
    var delimiter: u8 = ' ';
    var command_start = true;
    var quote: ?u8 = null;
    var escaped = false;

    while (entry_index < script.len) {
        const remainder = script[entry_index..];
        if (delimiter != 0) {
            if (command_start and quote == null and commandTokenMatches(remainder, "bun")) {
                try rewritten.appendSlice(bun_command);
                entry_index += "bun".len;
                delimiter = 0;
                command_start = false;
                continue;
            }
            if (std.mem.startsWith(u8, remainder, "npm run ")) {
                try rewritten.appendSlice(bun_command);
                try rewritten.appendSlice(" run ");
                entry_index += "npm run ".len;
                delimiter = 0;
                command_start = false;
                continue;
            }
            if (std.mem.startsWith(u8, remainder, "npx ")) {
                try rewritten.appendSlice(bun_command);
                try rewritten.appendSlice(" x ");
                entry_index += "npx ".len;
                delimiter = 0;
                command_start = false;
                continue;
            }
            if (std.mem.startsWith(u8, remainder, "pnpm run ")) {
                try rewritten.appendSlice(bun_command);
                try rewritten.appendSlice(" run ");
                entry_index += "pnpm run ".len;
                delimiter = 0;
                command_start = false;
                continue;
            }
            if (std.mem.startsWith(u8, remainder, "pnpm dlx ")) {
                try rewritten.appendSlice(bun_command);
                try rewritten.appendSlice(" x ");
                entry_index += "pnpm dlx ".len;
                delimiter = 0;
                command_start = false;
                continue;
            }
            if (std.mem.startsWith(u8, remainder, "pnpx ")) {
                try rewritten.appendSlice(bun_command);
                try rewritten.appendSlice(" x ");
                entry_index += "pnpx ".len;
                delimiter = 0;
                command_start = false;
                continue;
            }
            if (std.mem.startsWith(u8, remainder, "yarn ")) {
                const after_yarn = remainder["yarn ".len..];
                const command_end = std.mem.indexOfScalar(u8, after_yarn, ' ') orelse after_yarn.len;
                const yarn_command = after_yarn[0..command_end];
                if (std.mem.eql(u8, yarn_command, "run")) {
                    try rewritten.appendSlice(bun_command);
                    try rewritten.appendSlice(" run");
                    entry_index += "yarn run".len;
                    command_start = false;
                    continue;
                }
                if (!std.mem.eql(u8, yarn_command, "npm") and
                    !std.mem.startsWith(u8, yarn_command, "-") and
                    !isYarnCommand(yarn_command))
                {
                    try rewritten.appendSlice(bun_command);
                    try rewritten.appendSlice(" run ");
                    try rewritten.appendSlice(yarn_command);
                    entry_index += "yarn ".len + yarn_command.len;
                    delimiter = 0;
                    command_start = false;
                    continue;
                }
            }
        }

        const byte = script[entry_index];
        try rewritten.append(byte);
        if (escaped) {
            escaped = false;
        } else if (quote) |active_quote| {
            if (byte == active_quote) quote = null else if (byte == '\\' and active_quote == '"') escaped = true;
        } else switch (byte) {
            '\\' => escaped = true,
            '\'', '"' => {
                quote = byte;
                command_start = false;
            },
            ';', '|', '&', '(', '\n', '\r' => command_start = true,
            ' ', '\t' => {},
            else => command_start = false,
        }
        delimiter = switch (byte) {
            ' ', '\t', '\r', '\n', '\'', '"' => byte,
            else => 0,
        };
        entry_index += 1;
    }

    return try rewritten.toOwnedSlice();
}

test "rewrite nested package manager commands" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const rewritten = try replacePackageManagerRun(
        arena.allocator(),
        std.testing.io,
        "npm run build && npx tool && pnpm dlx other",
    );
    try std.testing.expect(std.mem.indexOf(u8, rewritten, "npm run") == null);
    try std.testing.expect(std.mem.indexOf(u8, rewritten, "npx ") == null);
    try std.testing.expect(std.mem.indexOf(u8, rewritten, "pnpm dlx") == null);
    try std.testing.expect(std.mem.indexOf(u8, rewritten, " run build") != null);
    try std.testing.expect(std.mem.indexOf(u8, rewritten, " x tool") != null);

    const literal_bun = try replacePackageManagerRun(
        arena.allocator(),
        std.testing.io,
        "echo \"bun foo\" && bun probe.js",
    );
    try std.testing.expect(std.mem.startsWith(u8, literal_bun, "echo \"bun foo\" && "));
    try std.testing.expect(std.mem.indexOf(u8, literal_bun, "&& bun probe.js") == null);
}
