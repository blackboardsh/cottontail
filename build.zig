const std = @import("std");

/// Must match scripts/jsc-manifest.json (the setup script vendors this tag).
const jsc_vendor_tag = "jsc-WebKit-7624.2.5.10.6";

fn jscVendorPlatformKey(target: std.Target) ?[]const u8 {
    return switch (target.os.tag) {
        .macos => switch (target.cpu.arch) {
            .aarch64 => "macos-arm64",
            else => null,
        },
        .linux => switch (target.cpu.arch) {
            .x86_64 => "linux-amd64",
            .aarch64 => "linux-arm64",
            else => null,
        },
        .windows => switch (target.cpu.arch) {
            .aarch64 => "windows-arm64",
            else => null,
        },
        else => null,
    };
}

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
            "-DCOTTONTAIL_VENDORED_JSC=1",
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

    const resolved_target = step.root_module.resolved_target.?.result;

    if (resolved_target.os.tag == .macos) {
        const platform_key = jscVendorPlatformKey(resolved_target) orelse {
            std.debug.print(
                "error: no vendored JavaScriptCore asset for this target; supported: macos-arm64, linux-amd64, linux-arm64, windows-arm64\n",
                .{},
            );
            std.process.exit(1);
        };
        const vendor_dir = b.fmt("vendors/jsc/{s}/{s}", .{ jsc_vendor_tag, platform_key });
        std.Io.Dir.cwd().access(b.graph.io, b.pathFromRoot(b.fmt("{s}/lib/libJavaScriptCore.a", .{vendor_dir})), .{}) catch {
            std.debug.print(
                "error: vendored JavaScriptCore not found at {s}; run `bun run setup` (or `node scripts/setup-jsc.js`) first\n",
                .{vendor_dir},
            );
            std.process.exit(1);
        };
        // The vendored build is a JSCOnly static build: link the archives
        // directly plus the system pieces the jsc binary itself depends on
        // (Apple libc++, libicucore for i18n, Foundation/objc for CF glue).
        step.root_module.addIncludePath(b.path(b.fmt("{s}/include", .{vendor_dir})));
        step.root_module.addObjectFile(b.path(b.fmt("{s}/lib/libJavaScriptCore.a", .{vendor_dir})));
        step.root_module.addObjectFile(b.path(b.fmt("{s}/lib/libWTF.a", .{vendor_dir})));
        step.root_module.addObjectFile(b.path(b.fmt("{s}/lib/libbmalloc.a", .{vendor_dir})));
        step.root_module.link_libcpp = true;
        step.root_module.linkSystemLibrary("icucore", .{});
        step.root_module.linkSystemLibrary("objc", .{});
        step.root_module.linkFramework("Foundation", .{});
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
        std.debug.print(
            "error: cottontail currently links the vendored JavaScriptCore on macOS only. Linux/Windows wiring against the vendored static JSC build (vendors/jsc) is coming.\n",
            .{},
        );
        std.process.exit(1);
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
