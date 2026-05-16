const std = @import("std");

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

    configureQuickjs(exe, b);

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

    configureQuickjs(unit_tests, b);

    const run_unit_tests = b.addRunArtifact(unit_tests);
    const test_step = b.step("test", "Run unit tests");
    test_step.dependOn(&run_unit_tests.step);
}
