const std = @import("std");
const cottontail_version = @import("src/version.zig").version;
const builtin = @import("builtin");

const libuv_common_sources = &.{
    "src/fs-poll.c",
    "src/idna.c",
    "src/inet.c",
    "src/random.c",
    "src/strscpy.c",
    "src/strtok.c",
    "src/thread-common.c",
    "src/threadpool.c",
    "src/timer.c",
    "src/uv-common.c",
    "src/uv-data-getter-setters.c",
    "src/version.c",
};

const libuv_unix_sources = &.{
    "src/unix/async.c",
    "src/unix/core.c",
    "src/unix/dl.c",
    "src/unix/fs.c",
    "src/unix/getaddrinfo.c",
    "src/unix/getnameinfo.c",
    "src/unix/loop-watcher.c",
    "src/unix/loop.c",
    "src/unix/pipe.c",
    "src/unix/poll.c",
    "src/unix/process.c",
    "src/unix/random-devurandom.c",
    "src/unix/signal.c",
    "src/unix/stream.c",
    "src/unix/tcp.c",
    "src/unix/thread.c",
    "src/unix/tty.c",
    "src/unix/udp.c",
};

const libuv_macos_sources = &.{
    "src/unix/proctitle.c",
    "src/unix/bsd-ifaddrs.c",
    "src/unix/kqueue.c",
    "src/unix/random-getentropy.c",
    "src/unix/darwin-proctitle.c",
    "src/unix/darwin.c",
    "src/unix/fsevents.c",
};

const libuv_linux_sources = &.{
    "src/unix/proctitle.c",
    "src/unix/linux.c",
    "src/unix/procfs-exepath.c",
    "src/unix/random-getrandom.c",
    "src/unix/random-sysctl-linux.c",
};

const libuv_windows_sources = &.{
    "src/win/async.c",
    "src/win/core.c",
    "src/win/detect-wakeup.c",
    "src/win/dl.c",
    "src/win/error.c",
    "src/win/fs.c",
    "src/win/fs-event.c",
    "src/win/getaddrinfo.c",
    "src/win/getnameinfo.c",
    "src/win/handle.c",
    "src/win/loop-watcher.c",
    "src/win/pipe.c",
    "src/win/thread.c",
    "src/win/poll.c",
    "src/win/process.c",
    "src/win/process-stdio.c",
    "src/win/signal.c",
    "src/win/snprintf.c",
    "src/win/stream.c",
    "src/win/tcp.c",
    "src/win/tty.c",
    "src/win/udp.c",
    "src/win/util.c",
    "src/win/winapi.c",
    "src/win/winsock.c",
};

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
            else => null,
        },
        else => null,
    };
}

fn rustTargetTriple(target: std.Target) ?[]const u8 {
    return switch (target.os.tag) {
        .macos => switch (target.cpu.arch) {
            .aarch64 => "aarch64-apple-darwin",
            .x86_64 => "x86_64-apple-darwin",
            else => null,
        },
        .linux => switch (target.cpu.arch) {
            .aarch64 => "aarch64-unknown-linux-gnu",
            .x86_64 => "x86_64-unknown-linux-gnu",
            else => null,
        },
        .windows => switch (target.cpu.arch) {
            .x86_64 => "x86_64-pc-windows-msvc",
            else => null,
        },
        else => null,
    };
}

fn buildLolHtml(b: *std.Build, target: std.Build.ResolvedTarget) std.Build.LazyPath {
    const triple = rustTargetTriple(target.result) orelse {
        std.debug.print(
            "error: no LOLHTML Rust target for {s}-{s}\n",
            .{ @tagName(target.result.os.tag), @tagName(target.result.cpu.arch) },
        );
        std.process.exit(1);
    };
    const command = b.addSystemCommand(&.{"node"});
    command.addFileArg(b.path("scripts/build-lolhtml.js"));
    const output = command.addOutputFileArg(if (target.result.os.tag == .windows) "lolhtml.lib" else "liblolhtml.a");
    command.addArg(triple);
    return output;
}

fn embedRuntimeModules(b: *std.Build) std.Build.LazyPath {
    const command = b.addSystemCommand(&.{"node"});
    command.addFileArg(b.path("scripts/embed-runtime-modules.js"));
    const output = command.addOutputFileArg("runtime-modules.bin");
    command.addDirectoryArg(b.path("src/runtime_modules"));
    command.addFileArg(b.path("src/compiler/src/runtime.js"));
    command.addFileArg(b.path("src/compiler/src/runtime.bun.js"));
    command.addFileArg(b.path("src/compiler/src/node-fallbacks/buffer.js"));
    command.addFileArg(b.path("src/compiler/src/node-fallbacks/vendor/base64-js.js"));
    command.addFileArg(b.path("src/compiler/src/node-fallbacks/vendor/ieee754.js"));
    const io = std.Io.Threaded.global_single_threaded.io();
    var directory = std.Io.Dir.cwd().openDir(io, "src/runtime_modules", .{ .iterate = true }) catch
        @panic("failed to open src/runtime_modules");
    defer directory.close(io);
    var walker = directory.walk(b.allocator) catch @panic("failed to walk src/runtime_modules");
    defer walker.deinit();
    while (walker.next(io) catch @panic("failed to walk src/runtime_modules")) |entry| {
        if (entry.kind != .file) continue;
        command.addFileInput(b.path(b.fmt("src/runtime_modules/{s}", .{entry.path})));
    }
    return output;
}

fn createCompilerModule(b: *std.Build, target: std.Build.ResolvedTarget, root_optimize: std.builtin.OptimizeMode) *std.Build.Module {
    // The vendored Bun compiler (parser/bundler/CSS pipeline) is hot code on
    // every `cottontail run` — a Debug build spends ~300ms bundling the
    // runtime modules per child process, which starves spawn-heavy upstream
    // tests. Build it optimized (with safety checks) even in Debug builds of
    // the surrounding runtime.
    const optimize = if (root_optimize == .Debug) .ReleaseFast else root_optimize;
    const build_options_module = b.createModule(.{
        .root_source_file = b.path("src/compiler/src/build_options.zig"),
        .target = target,
        .optimize = optimize,
    });
    const compiler_module = b.createModule(.{
        .root_source_file = b.path("src/compiler/src/root.zig"),
        .target = target,
        .optimize = optimize,
    });
    compiler_module.addImport("build_options", build_options_module);
    const zlib_internal_module = b.createModule(.{
        .root_source_file = b.path(if (target.result.os.tag == .windows)
            "src/compiler/src/zlib_sys/win32.zig"
        else
            "src/compiler/src/zlib_sys/posix.zig"),
        .target = target,
        .optimize = optimize,
    });
    compiler_module.addImport("zlib-internal", zlib_internal_module);
    // Imported compiler internals still use Bun's historical self-name.
    compiler_module.addImport("bun", compiler_module);
    return compiler_module;
}

fn copyLinuxSystemLibrary(b: *std.Build, library: []const u8) std.Build.LazyPath {
    const command = b.addSystemCommand(&.{"node"});
    command.addFileArg(b.path("scripts/copy-system-library.js"));
    const output = command.addOutputFileArg(library);
    command.addArgs(&.{ "g++", library });
    return output;
}

fn configureLibuv(step: *std.Build.Step.Compile, b: *std.Build) void {
    const module = step.root_module;
    const target = module.resolved_target.?.result;
    const root = b.path("vendors/libuv");
    module.addIncludePath(b.path("vendors/libuv/include"));
    module.addIncludePath(b.path("vendors/libuv/src"));

    switch (target.os.tag) {
        .macos => {
            const flags = &.{
                "-std=c11",
                "-fno-strict-aliasing",
                "-D_FILE_OFFSET_BITS=64",
                "-D_LARGEFILE_SOURCE",
                "-D_DARWIN_UNLIMITED_SELECT=1",
                "-D_DARWIN_USE_64_BIT_INODE=1",
            };
            module.addCSourceFiles(.{ .root = root, .files = libuv_common_sources, .flags = flags });
            module.addCSourceFiles(.{ .root = root, .files = libuv_unix_sources, .flags = flags });
            module.addCSourceFiles(.{ .root = root, .files = libuv_macos_sources, .flags = flags });
            module.linkSystemLibrary("pthread", .{});
        },
        .linux => {
            const flags = &.{
                "-std=c11",
                "-fno-strict-aliasing",
                "-D_FILE_OFFSET_BITS=64",
                "-D_LARGEFILE_SOURCE",
                "-D_GNU_SOURCE",
                "-D_POSIX_C_SOURCE=200112",
            };
            module.addCSourceFiles(.{ .root = root, .files = libuv_common_sources, .flags = flags });
            module.addCSourceFiles(.{ .root = root, .files = libuv_unix_sources, .flags = flags });
            module.addCSourceFiles(.{ .root = root, .files = libuv_linux_sources, .flags = flags });
            inline for (&.{ "dl", "pthread", "rt" }) |library| module.linkSystemLibrary(library, .{});
        },
        .windows => {
            const flags = &.{
                "-std=c11",
                "-fno-strict-aliasing",
                "-DWIN32_LEAN_AND_MEAN",
                "-D_WIN32_WINNT=0x0A00",
                "-D_CRT_DECLARE_NONSTDC_NAMES=0",
                // Public libuv declarations must remain visible from the final executable.
                "-DBUILDING_UV_SHARED=1",
            };
            module.addCSourceFiles(.{ .root = root, .files = libuv_common_sources, .flags = flags });
            module.addCSourceFiles(.{ .root = root, .files = libuv_windows_sources, .flags = flags });
            inline for (&.{
                "advapi32", "dbghelp", "iphlpapi", "ole32", "psapi", "shell32", "user32", "userenv", "ws2_32",
            }) |library| module.linkSystemLibrary(library, .{});
        },
        else => unreachable,
    }
}

fn configureJsc(step: *std.Build.Step.Compile, b: *std.Build, lolhtml: std.Build.LazyPath) void {
    step.rdynamic = true;
    // Static JSC uses indirectly referenced LLInt/JIT entry points that the
    // release linker otherwise discards, producing SIGBUS at runtime.
    step.link_gc_sections = false;
    step.root_module.link_libc = true;
    configureLibuv(step, b);
    step.root_module.addIncludePath(b.path("src"));
    step.root_module.addIncludePath(b.path("src/compiler/src/jsc/bindings/sqlite"));
    step.root_module.addCMacro("COTTONTAIL_VERSION", b.fmt("\"{s}\"", .{cottontail_version}));
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
            "-DJS_NO_EXPORT=1",
        },
    });
    step.root_module.addCSourceFile(.{
        .file = b.path("src/jsc_private_bridge.cpp"),
        .flags = &[_][]const u8{
            "-std=c++20",
            "-DJS_NO_EXPORT=1",
        },
    });
    step.root_module.addCSourceFile(.{
        .file = b.path("src/jsc_stock_bridge.cpp"),
        .flags = &[_][]const u8{
            "-std=c++20",
            "-DJS_NO_EXPORT=1",
        },
    });
    step.root_module.addCSourceFile(.{
        .file = b.path("src/napi_bridge.cpp"),
        .flags = &[_][]const u8{
            "-std=c++20",
            "-DJS_NO_EXPORT=1",
        },
    });
    step.root_module.addObjectFile(lolhtml);
    step.root_module.addCSourceFile(.{
        .file = b.path("src/compiler/src/jsc/bindings/sqlite/sqlite3.c"),
        .flags = &[_][]const u8{
            "-std=c11",
            "-Wno-deprecated-declarations",
            "-DSQLITE_ENABLE_COLUMN_METADATA",
            "-DSQLITE_ENABLE_FTS5",
            "-DSQLITE_ENABLE_SESSION",
            "-DSQLITE_ENABLE_PREUPDATE_HOOK",
            "-DSQLITE_ENABLE_UPDATE_DELETE_LIMIT",
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
            step.root_module.linkSystemLibrary("pthread", .{});
            step.root_module.linkSystemLibrary("resolv", .{});
            step.root_module.linkSystemLibrary("z", .{});
            step.root_module.addSystemIncludePath(.{ .cwd_relative = "/opt/homebrew/include" });
            step.root_module.addLibraryPath(.{ .cwd_relative = "/opt/homebrew/lib" });
            inline for (&.{ "brotlicommon", "brotlidec", "brotlienc" }) |library| {
                step.root_module.linkSystemLibrary(library, .{ .preferred_link_mode = .static });
            }
            step.root_module.linkSystemLibrary("ssl", .{ .preferred_link_mode = .static });
            step.root_module.linkSystemLibrary("crypto", .{ .preferred_link_mode = .static });
        },
        .linux => {
            requireJscLibrary(b, vendor_dir, "libJavaScriptCore.a");
            requireJscLibrary(b, vendor_dir, "libcottontail_icu.a");
            step.root_module.addObjectFile(b.path(b.fmt("{s}/lib/libJavaScriptCore.a", .{vendor_dir})));
            step.root_module.addObjectFile(b.path(b.fmt("{s}/lib/libWTF.a", .{vendor_dir})));
            step.root_module.addObjectFile(b.path(b.fmt("{s}/lib/libbmalloc.a", .{vendor_dir})));
            step.root_module.addObjectFile(b.path(b.fmt("{s}/lib/libcottontail_icu.a", .{vendor_dir})));
            inline for (&.{
                "atomic", "brotlicommon", "brotlidec", "brotlienc", "ffi", "m", "pthread", "z",
            }) |library| step.root_module.linkSystemLibrary(library, .{});
            // Zig treats these names as aliases for its own libc/libc++ and
            // drops them before linking. Concrete files preserve the GNU C++
            // ABI and unwind runtime used by the JSC/Rust archives, plus
            // glibc's resolver implementation.
            step.root_module.addObjectFile(copyLinuxSystemLibrary(b, "libstdc++.so"));
            step.root_module.addObjectFile(copyLinuxSystemLibrary(b, "libgcc_s.so.1"));
            step.root_module.addObjectFile(copyLinuxSystemLibrary(b, "libresolv.a"));
            step.root_module.linkSystemLibrary("ssl", .{ .preferred_link_mode = .static });
            step.root_module.linkSystemLibrary("crypto", .{ .preferred_link_mode = .static });
            // OpenSSL 3.4+ can use Zstandard from its static libcrypto archive.
            // Keep this after crypto so the linker can resolve that private dependency.
            step.root_module.linkSystemLibrary("zstd", .{
                .use_pkg_config = .no,
                .preferred_link_mode = .static,
                .search_strategy = .no_fallback,
            });
        },
        .windows => {
            const dependency_dir = "vendors/windows-deps/x64-windows-static";
            requireJscLibrary(b, vendor_dir, "JavaScriptCore.lib");
            step.root_module.addIncludePath(b.path(b.fmt("{s}/include", .{dependency_dir})));
            step.root_module.addLibraryPath(b.path(b.fmt("{s}/lib", .{dependency_dir})));
            step.root_module.addObjectFile(b.path(b.fmt("{s}/lib/JavaScriptCore.lib", .{vendor_dir})));
            step.root_module.addObjectFile(b.path(b.fmt("{s}/lib/WTF.lib", .{vendor_dir})));
            step.root_module.addObjectFile(b.path(b.fmt("{s}/lib/bmalloc.lib", .{vendor_dir})));
            inline for (&.{
                "brotlicommon.lib", "brotlidec.lib", "brotlienc.lib", "dl.lib", "ffi.lib", "libcrypto.lib", "libssl.lib", "zs.lib",
            }) |library| {
                step.root_module.addObjectFile(b.path(b.fmt("{s}/lib/{s}", .{ dependency_dir, library })));
            }
            // This JSC build uses the operating-system ICU data and API. The
            // Windows SDK provides its import library as icu.lib.
            inline for (&.{ "advapi32", "bcrypt", "crypt32", "dnsapi", "icu", "iphlpapi", "psapi", "shell32", "user32", "userenv", "winmm", "ws2_32" }) |library| {
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
            "error: vendored JavaScriptCore library not found at {s}; run `node scripts/setup-jsc.js` first\n",
            .{path},
        );
        std.process.exit(1);
    };
}

pub fn build(b: *std.Build) void {
    // The Windows release is x86-64 MSVC even when the host is Windows ARM.
    // Make both the architecture and ABI explicit so Zig does not derive a
    // native CPU model from the CI host. The vendored JSC, Rust static library,
    // Visual Studio SDK, and vcpkg dependencies all use this same target.
    const target = b.standardTargetOptions(.{
        .default_target = if (builtin.os.tag == .windows) .{
            .cpu_arch = .x86_64,
            .os_tag = .windows,
            .abi = .msvc,
        } else .{},
    });
    const optimize = b.standardOptimizeOption(.{});
    const lolhtml = buildLolHtml(b, target);
    const runtime_modules_blob = embedRuntimeModules(b);

    const exe = b.addExecutable(.{
        .name = "cottontail",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });
    exe.root_module.addImport("cottontail_compiler", createCompilerModule(b, target, optimize));
    exe.root_module.addAnonymousImport("runtime_modules_blob", .{ .root_source_file = runtime_modules_blob });

    configureJsc(exe, b, lolhtml);

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
    unit_tests.root_module.addImport("cottontail_compiler", createCompilerModule(b, target, optimize));
    unit_tests.root_module.addAnonymousImport("runtime_modules_blob", .{ .root_source_file = runtime_modules_blob });

    configureJsc(unit_tests, b, lolhtml);

    const run_unit_tests = b.addRunArtifact(unit_tests);
    const test_step = b.step("test", "Run unit tests");
    test_step.dependOn(&run_unit_tests.step);
}
