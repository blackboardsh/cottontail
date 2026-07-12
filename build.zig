const std = @import("std");

fn createBunVendorModule(b: *std.Build, target: std.Build.ResolvedTarget, optimize: std.builtin.OptimizeMode) *std.Build.Module {
    const build_options_module = b.createModule(.{
        .root_source_file = b.path("vendors/bun-zig/src/build_options.zig"),
        .target = target,
        .optimize = optimize,
    });
    const bun_module = b.createModule(.{
        .root_source_file = b.path("vendors/bun-zig/src/root.zig"),
        .target = target,
        .optimize = optimize,
    });
    bun_module.addImport("build_options", build_options_module);
    bun_module.addImport("bun", bun_module);
    return bun_module;
}

fn configureJsc(step: *std.Build.Step.Compile, b: *std.Build) void {
    step.rdynamic = true;
    step.root_module.link_libc = true;
    step.root_module.addIncludePath(b.path("src"));
    step.root_module.addIncludePath(b.path("vendors/bun-zig/src/jsc/bindings/sqlite"));
    step.root_module.addCSourceFile(.{
        .file = b.path("src/jsc_runner.c"),
        .flags = &[_][]const u8{
            "-std=c11",
            "-Wno-deprecated-declarations",
            "-DSQLITE_ENABLE_COLUMN_METADATA",
            "-DSQLITE_ENABLE_FTS5",
            "-DSQLITE_ENABLE_SESSION",
            "-DSQLITE_ENABLE_PREUPDATE_HOOK",
        },
    });
    step.root_module.addCSourceFile(.{
        .file = b.path("vendors/bun-zig/src/jsc/bindings/sqlite/sqlite3.c"),
        .flags = &[_][]const u8{
            "-std=c11",
            "-Wno-deprecated-declarations",
            "-DSQLITE_ENABLE_COLUMN_METADATA",
            "-DSQLITE_ENABLE_FTS5",
            "-DSQLITE_ENABLE_SESSION",
            "-DSQLITE_ENABLE_PREUPDATE_HOOK",
            "-DSQLITE_THREADSAFE=1",
        },
    });

    if (step.root_module.resolved_target.?.result.os.tag == .macos) {
        step.root_module.linkFramework("JavaScriptCore", .{});
        step.root_module.linkSystemLibrary("ffi", .{});
        step.root_module.linkSystemLibrary("compression", .{});
        step.root_module.linkSystemLibrary("pthread", .{});
        step.root_module.linkSystemLibrary("resolv", .{});
        step.root_module.linkSystemLibrary("z", .{});
        step.root_module.addSystemIncludePath(.{ .cwd_relative = "/opt/homebrew/include" });
        step.root_module.addSystemIncludePath(.{ .cwd_relative = "/usr/local/include" });
        step.root_module.addLibraryPath(.{ .cwd_relative = "/opt/homebrew/lib" });
        step.root_module.addLibraryPath(.{ .cwd_relative = "/usr/local/lib" });
        step.root_module.linkSystemLibrary("crypto", .{});
        step.root_module.linkSystemLibrary("ssl", .{});
    } else {
        @panic("Cottontail currently wires JavaScriptCore through the macOS system framework only");
    }
}

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const exe = b.addExecutable(.{
        .name = "cottontail",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });
    exe.root_module.addImport("bun", createBunVendorModule(b, target, optimize));

    configureJsc(exe, b);

    b.installArtifact(exe);

    const run_cmd = b.addRunArtifact(exe);
    run_cmd.step.dependOn(b.getInstallStep());
    if (b.args) |args| {
        run_cmd.addArgs(args);
    }

    const run_step = b.step("run", "Build and run cottontail");
    run_step.dependOn(&run_cmd.step);

    const unit_tests = b.addTest(.{
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });
    unit_tests.root_module.addImport("bun", createBunVendorModule(b, target, optimize));

    configureJsc(unit_tests, b);

    const run_unit_tests = b.addRunArtifact(unit_tests);
    const test_step = b.step("test", "Run unit tests");
    test_step.dependOn(&run_unit_tests.step);
}
