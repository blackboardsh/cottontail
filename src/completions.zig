const std = @import("std");

const Shell = enum {
    unknown,
    bash,
    zsh,
    fish,
    powershell,

    fn fromEnvironment(init: std.process.Init) Shell {
        const shell_path = init.environ_map.get("SHELL") orelse
            init.environ_map.get("COMSPEC") orelse return .unknown;
        const basename = std.fs.path.basename(shell_path);
        if (std.mem.eql(u8, basename, "bash")) return .bash;
        if (std.mem.eql(u8, basename, "zsh")) return .zsh;
        if (std.mem.eql(u8, basename, "fish")) return .fish;
        if (std.ascii.eqlIgnoreCase(basename, "pwsh") or
            std.ascii.eqlIgnoreCase(basename, "pwsh.exe") or
            std.ascii.eqlIgnoreCase(basename, "powershell") or
            std.ascii.eqlIgnoreCase(basename, "powershell.exe")) return .powershell;
        return .unknown;
    }

    fn contents(shell: Shell) []const u8 {
        return switch (shell) {
            .bash => @embedFile("completions/bun.bash"),
            .zsh => @embedFile("completions/bun.zsh"),
            .fish => @embedFile("completions/bun.fish"),
            else => "",
        };
    }

    fn filename(shell: Shell) []const u8 {
        return switch (shell) {
            .bash => "bun.completion.bash",
            .zsh => "_bun",
            .fish => "bun.fish",
            else => unreachable,
        };
    }
};

const OutputDirectory = struct {
    dir: std.Io.Dir,
    path: []const u8,
};

fn openDirectory(init: std.process.Init, path: []const u8) ?OutputDirectory {
    const dir = if (std.fs.path.isAbsolute(path))
        std.Io.Dir.openDirAbsolute(init.io, path, .{}) catch return null
    else
        std.Io.Dir.cwd().openDir(init.io, path, .{}) catch return null;
    return .{ .dir = dir, .path = path };
}

fn openJoinedDirectory(init: std.process.Init, parts: []const []const u8) !?OutputDirectory {
    const path = try std.fs.path.join(init.arena.allocator(), parts);
    return openDirectory(init, path);
}

fn defaultOutputDirectory(init: std.process.Init, shell: Shell) !?OutputDirectory {
    switch (shell) {
        .fish => {
            if (init.environ_map.get("XDG_CONFIG_HOME")) |root|
                if (try openJoinedDirectory(init, &.{ root, "fish", "completions" })) |dir| return dir;
            if (init.environ_map.get("XDG_DATA_HOME")) |root|
                if (try openJoinedDirectory(init, &.{ root, "fish", "completions" })) |dir| return dir;
            if (init.environ_map.get("HOME")) |home|
                if (try openJoinedDirectory(init, &.{ home, ".config", "fish", "completions" })) |dir| return dir;
            const fish_dirs = [_][]const u8{
                "/usr/local/share/fish/completions",
                "/opt/homebrew/share/fish/completions",
                "/etc/fish/completions",
            };
            for (fish_dirs) |path| if (openDirectory(init, path)) |dir| return dir;
        },
        .zsh => {
            if (init.environ_map.get("fpath")) |fpath| {
                var paths = std.mem.tokenizeAny(u8, fpath, ": ");
                while (paths.next()) |path| if (openDirectory(init, path)) |dir| return dir;
            }
            if (init.environ_map.get("XDG_DATA_HOME")) |root|
                if (try openJoinedDirectory(init, &.{ root, "zsh-completions" })) |dir| return dir;
            if (init.environ_map.get("BUN_INSTALL")) |root|
                if (openDirectory(init, root)) |dir| return dir;
            if (init.environ_map.get("HOME")) |home| {
                if (try openJoinedDirectory(init, &.{ home, ".oh-my-zsh", "completions" })) |dir| return dir;
                if (try openJoinedDirectory(init, &.{ home, ".bun" })) |dir| return dir;
            }
            const zsh_dirs = [_][]const u8{
                "/usr/local/share/zsh/site-functions",
                "/usr/local/share/zsh/completions",
                "/opt/homebrew/share/zsh/completions",
                "/opt/homebrew/share/zsh/site-functions",
            };
            for (zsh_dirs) |path| if (openDirectory(init, path)) |dir| return dir;
        },
        .bash => {
            if (init.environ_map.get("XDG_DATA_HOME")) |root|
                if (try openJoinedDirectory(init, &.{ root, "bash-completion", "completions" })) |dir| return dir;
            if (init.environ_map.get("XDG_CONFIG_HOME")) |root|
                if (try openJoinedDirectory(init, &.{ root, "bash-completion", "completions" })) |dir| return dir;
            if (init.environ_map.get("HOME")) |home| {
                if (try openJoinedDirectory(init, &.{ home, ".oh-my-bash", "custom", "completions" })) |dir| return dir;
                if (try openJoinedDirectory(init, &.{ home, ".bash_completion.d" })) |dir| return dir;
            }
            const bash_dirs = [_][]const u8{
                "/opt/homebrew/share/bash-completion/completions",
                "/opt/local/share/bash-completion/completions",
            };
            for (bash_dirs) |path| if (openDirectory(init, path)) |dir| return dir;
        },
        else => {},
    }
    return null;
}

fn writePipedOutput(init: std.process.Init, contents: []const u8) !u8 {
    std.Io.File.stdout().writeStreamingAll(init.io, contents) catch |err| switch (err) {
        error.BrokenPipe => return 0,
        else => return err,
    };
    return 0;
}

pub fn run(
    init: std.process.Init,
    args: []const [:0]const u8,
    stderr: *std.Io.Writer,
) !u8 {
    const shell = Shell.fromEnvironment(init);
    switch (shell) {
        .powershell => {
            try stderr.writeAll("error: PowerShell completions are not yet available\n");
            return 1;
        },
        .unknown => {
            try stderr.writeAll("error: Unknown or unsupported shell. Set $SHELL to zsh, fish, or bash.\n");
            return 1;
        },
        else => {},
    }

    const contents = shell.contents();
    const stdout_file = std.Io.File.stdout();
    if (!(stdout_file.isTty(init.io) catch false)) return writePipedOutput(init, contents);

    var output = if (args.len > 0)
        openDirectory(init, args[0]) orelse {
            try stderr.print("error: Could not access completion directory \"{s}\"\n", .{args[0]});
            return 1;
        }
    else
        (try defaultOutputDirectory(init, shell)) orelse {
            try stderr.writeAll(
                "error: Could not find a directory to install completions in.\n" ++
                    "Pipe `cottontail completions` to a file or pass an output directory.\n",
            );
            return 1;
        };
    defer output.dir.close(init.io);

    const file = output.dir.createFile(init.io, shell.filename(), .{ .truncate = true }) catch |err| {
        try stderr.print("error: Could not create completion file in \"{s}\": {s}\n", .{ output.path, @errorName(err) });
        return 1;
    };
    defer file.close(init.io);
    file.writeStreamingAll(init.io, contents) catch |err| {
        try stderr.print("error: Could not write completion file in \"{s}\": {s}\n", .{ output.path, @errorName(err) });
        return 1;
    };
    return 0;
}
