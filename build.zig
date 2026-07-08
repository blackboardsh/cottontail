const std = @import("std");

const JsEngine = enum {
    quickjs,
    jsc,
};

fn configureQuickjs(step: *std.Build.Step.Compile, b: *std.Build) void {
    step.root_module.link_libc = true;
    step.root_module.addIncludePath(b.path("src"));
    step.root_module.addIncludePath(b.path("vendors/quickjs"));
    step.root_module.addCSourceFile(.{
        .file = b.path("vendors/quickjs/quickjs-amalgam.c"),
        .flags = &[_][]const u8{"-std=c11"},
    });
    step.root_module.addCSourceFile(.{
        .file = b.path("src/qjs_runner.c"),
        .flags = &[_][]const u8{"-std=c11"},
    });

    if (step.root_module.resolved_target.?.result.os.tag != .windows) {
        step.root_module.linkSystemLibrary("m", .{});
        step.root_module.linkSystemLibrary("ffi", .{});
        step.root_module.linkSystemLibrary("z", .{});
        step.root_module.linkSystemLibrary("pthread", .{});
    }
}

fn configureJsc(step: *std.Build.Step.Compile, b: *std.Build) void {
    step.root_module.link_libc = true;
    step.root_module.addIncludePath(b.path("src"));
    step.root_module.addCSourceFile(.{
        .file = b.path("src/jsc_runner.c"),
        .flags = &[_][]const u8{"-std=c11"},
    });

    if (step.root_module.resolved_target.?.result.os.tag == .macos) {
        step.root_module.linkFramework("JavaScriptCore", .{});
    } else {
        @panic("JavaScriptCore backend is currently wired for macOS only");
    }
}

fn configureJsEngine(step: *std.Build.Step.Compile, b: *std.Build, engine: JsEngine) void {
    switch (engine) {
        .quickjs => configureQuickjs(step, b),
        .jsc => configureJsc(step, b),
    }
}

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});
    const default_engine: JsEngine = if ((target.result.os.tag == .macos) or
        (target.query.os_tag == null and @import("builtin").os.tag == .macos))
        .jsc
    else
        .quickjs;
    const engine = b.option(JsEngine, "engine", "JavaScript engine backend") orelse default_engine;

    const exe = b.addExecutable(.{
        .name = "cottontail",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });

    configureJsEngine(exe, b, engine);

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

    configureJsEngine(unit_tests, b, engine);

    const run_unit_tests = b.addRunArtifact(unit_tests);
    const test_step = b.step("test", "Run unit tests");
    test_step.dependOn(&run_unit_tests.step);
}
