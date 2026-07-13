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
            .x86_64 => "windows-amd64",
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
    // Static JSC uses indirectly referenced LLInt/JIT entry points that the
    // release linker otherwise discards, producing SIGBUS at runtime.
    step.link_gc_sections = false;
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

    const platform_key = jscVendorPlatformKey(resolved_target) orelse {
        std.debug.print(
            "error: no vendored JavaScriptCore target for {s}-{s}\n",
            .{ @tagName(resolved_target.os.tag), @tagName(resolved_target.cpu.arch) },
        );
        std.process.exit(1);
    };
    const vendor_dir = b.fmt("vendors/jsc/{s}/{s}", .{ jsc_vendor_tag, platform_key });
    step.root_module.addIncludePath(b.path(b.fmt("{s}/include", .{vendor_dir})));

    switch (resolved_target.os.tag) {
        .macos => {
            requireJscLibrary(b, vendor_dir, "libJavaScriptCore.a");
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
            step.root_module.linkSystemLibrary("ssl", .{ .preferred_link_mode = .static });
            step.root_module.linkSystemLibrary("crypto", .{ .preferred_link_mode = .static });
        },
        .linux => {
            requireJscLibrary(b, vendor_dir, "libJavaScriptCore.a");
            step.root_module.addObjectFile(b.path(b.fmt("{s}/lib/libJavaScriptCore.a", .{vendor_dir})));
            step.root_module.addObjectFile(b.path(b.fmt("{s}/lib/libWTF.a", .{vendor_dir})));
            step.root_module.addObjectFile(b.path(b.fmt("{s}/lib/libbmalloc.a", .{vendor_dir})));
            step.root_module.link_libcpp = true;
            inline for (&.{
                "atomic", "brotlicommon", "brotlidec", "brotlienc", "dl", "ffi", "icudata", "icui18n",
                "icuuc",  "m",            "pthread",   "resolv",    "z",
            }) |library| step.root_module.linkSystemLibrary(library, .{});
            step.root_module.linkSystemLibrary("ssl", .{ .preferred_link_mode = .static });
            step.root_module.linkSystemLibrary("crypto", .{ .preferred_link_mode = .static });
        },
        .windows => {
            requireJscLibrary(b, vendor_dir, "JavaScriptCore.lib");
            step.root_module.addObjectFile(b.path(b.fmt("{s}/lib/JavaScriptCore.lib", .{vendor_dir})));
            step.root_module.addObjectFile(b.path(b.fmt("{s}/lib/WTF.lib", .{vendor_dir})));
            step.root_module.addObjectFile(b.path(b.fmt("{s}/lib/bmalloc.lib", .{vendor_dir})));
            step.root_module.addObjectFile(b.path(b.fmt("{s}/lib/sicudt.lib", .{vendor_dir})));
            step.root_module.addObjectFile(b.path(b.fmt("{s}/lib/sicuin.lib", .{vendor_dir})));
            step.root_module.addObjectFile(b.path(b.fmt("{s}/lib/sicuuc.lib", .{vendor_dir})));
            inline for (&.{ "advapi32", "bcrypt", "shell32", "userenv", "winmm", "ws2_32" }) |library| {
                step.root_module.linkSystemLibrary(library, .{});
            }
        },
        else => unreachable,
    }
}

fn requireJscLibrary(b: *std.Build, vendor_dir: []const u8, library: []const u8) void {
    const path = b.fmt("{s}/lib/{s}", .{ vendor_dir, library });
    std.Io.Dir.cwd().access(b.graph.io, b.pathFromRoot(path), .{}) catch {
        std.debug.print(
            "error: vendored JavaScriptCore library not found at {s}; run `bun run setup:jsc` first\n",
            .{path},
        );
        std.process.exit(1);
    };
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
