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
const jsc_vendor_tag = "jsc-WebKit-7624.4.5.14.1-46a8b00303fa";

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

const RuntimeModuleArtifacts = struct {
    core: std.Build.LazyPath,
    capability_builder: std.Build.LazyPath,
};

fn embedRuntimeModules(b: *std.Build) RuntimeModuleArtifacts {
    const command = b.addSystemCommand(&.{"node"});
    command.addFileArg(b.path("scripts/embed-runtime-modules.js"));
    const output = command.addOutputFileArg("runtime-modules.bin");
    command.addDirectoryArg(b.path("src/runtime_modules"));
    command.addFileArg(b.path("src/compiler/src/runtime.js"));
    command.addFileArg(b.path("src/compiler/src/runtime.bun.js"));
    command.addFileArg(b.path("src/compiler/src/node-fallbacks/buffer.js"));
    command.addFileArg(b.path("src/compiler/src/node-fallbacks/vendor/base64-js.js"));
    command.addFileArg(b.path("src/compiler/src/node-fallbacks/vendor/ieee754.js"));
    const builder_command = b.addSystemCommand(&.{"node"});
    builder_command.addFileArg(b.path("scripts/embed-runtime-modules.js"));
    const builder_output = builder_command.addOutputFileArg("runtime-modules-capability-builder.bin");
    builder_command.addDirectoryArg(b.path("src/runtime_modules"));
    builder_command.addFileArg(b.path("src/compiler/src/runtime.js"));
    builder_command.addFileArg(b.path("src/compiler/src/runtime.bun.js"));
    builder_command.addFileArg(b.path("src/compiler/src/node-fallbacks/buffer.js"));
    builder_command.addFileArg(b.path("src/compiler/src/node-fallbacks/vendor/base64-js.js"));
    builder_command.addFileArg(b.path("src/compiler/src/node-fallbacks/vendor/ieee754.js"));
    builder_command.addArg("capability-builder");
    const io = std.Io.Threaded.global_single_threaded.io();
    var directory = std.Io.Dir.cwd().openDir(io, "src/runtime_modules", .{ .iterate = true }) catch
        @panic("failed to open src/runtime_modules");
    defer directory.close(io);
    var walker = directory.walk(b.allocator) catch @panic("failed to walk src/runtime_modules");
    defer walker.deinit();
    while (walker.next(io) catch @panic("failed to walk src/runtime_modules")) |entry| {
        if (entry.kind != .file) continue;
        const input = b.path(b.fmt("src/runtime_modules/{s}", .{entry.path}));
        command.addFileInput(input);
        builder_command.addFileInput(input);
    }
    return .{ .core = output, .capability_builder = builder_output };
}

fn buildStdlibCapability(
    b: *std.Build,
    builder_runtime: *std.Build.Step.Compile,
    runtime: *std.Build.Step.Compile,
    name: []const u8,
    entrypoint: []const u8,
) std.Build.LazyPath {
    const bundle = b.addRunArtifact(builder_runtime);
    bundle.addFileArg(b.path("scripts/bundle-stdlib-capability.js"));
    bundle.addArg(name);
    bundle.addFileArg(b.path(entrypoint));
    const source = bundle.addOutputFileArg(b.fmt("{s}/main.js", .{name}));
    const encode = b.addRunArtifact(runtime);
    encode.addArg("--cottontail-build-capability-bytecode");
    encode.addArg(name);
    encode.addFileArg(source);
    const output = encode.addOutputFileArg(b.fmt("{s}/main.jsc", .{name}));
    encode.addArg(b.fmt("cottontail:stdlib/{s}/main", .{name}));
    return output;
}

fn buildCoreRuntimeModule(
    b: *std.Build,
    builder_runtime: *std.Build.Step.Compile,
    runtime: *std.Build.Step.Compile,
    name: []const u8,
    module_path: []const u8,
) std.Build.LazyPath {
    const generate = b.addSystemCommand(&.{"node"});
    generate.addFileArg(b.path("scripts/generate-core-runtime-entry.js"));
    generate.addArg(name);
    generate.addFileArg(b.path(module_path));
    const entrypoint = generate.addOutputFileArg(b.fmt("core-runtime-{s}/entry.js", .{name}));

    const bundle = b.addRunArtifact(builder_runtime);
    bundle.setEnvironmentVariable("COTTONTAIL_BUNDLE_CORE_MODULE", "1");
    bundle.addFileArg(b.path("scripts/bundle-stdlib-capability.js"));
    bundle.addArg(b.fmt("core-runtime-{s}", .{name}));
    bundle.addFileArg(entrypoint);
    const source = bundle.addOutputFileArg(b.fmt("core-runtime-{s}/main.js", .{name}));

    const encode = b.addRunArtifact(runtime);
    encode.addArg("--cottontail-build-capability-bytecode");
    encode.addArg(b.fmt("core-runtime-{s}", .{name}));
    encode.addFileArg(source);
    const output = encode.addOutputFileArg(b.fmt("core-runtime-{s}/main.jsc", .{name}));
    encode.addArg(b.fmt("cottontail:core/runtime/{s}", .{name}));
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
    const html_rewriter_root = "vendors/zig-html-rewriter/src/root.zig";
    std.Io.Dir.cwd().access(b.graph.io, b.pathFromRoot(html_rewriter_root), .{}) catch {
        std.debug.print(
            "error: zig-html-rewriter is not vendored; run `node scripts/setup-zig-html-rewriter.js` first\n",
            .{},
        );
        std.process.exit(1);
    };
    const html_rewriter_module = b.createModule(.{
        .root_source_file = b.path(html_rewriter_root),
        .target = target,
        .optimize = optimize,
    });
    compiler_module.addImport("build_options", build_options_module);
    compiler_module.addImport("html_rewriter", html_rewriter_module);
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

fn compileLinuxCppSource(
    b: *std.Build,
    vendor_dir: []const u8,
    source: []const u8,
    output_name: []const u8,
) std.Build.LazyPath {
    const libgcc_path = std.mem.trim(
        u8,
        b.run(&.{ "g++", "-print-file-name=libgcc.a" }),
        " \t\r\n",
    );
    if (!std.fs.path.isAbsolute(libgcc_path)) {
        std.debug.print("error: g++ could not locate libgcc.a\n", .{});
        std.process.exit(1);
    }
    const gcc_install_dir = std.fs.path.dirname(libgcc_path).?;

    // JSC's public headers use Clang annotations, while its Linux archives use
    // the GNU C++ ABI. Native clang++ supplies both the expected frontend and
    // the host libstdc++ header ordering before Zig links the resulting object.
    // Pin the GCC installation because Clang distributions outside Ubuntu's
    // default PATH do not always discover the host toolchain on their own.
    const command = b.addSystemCommand(&.{
        "clang++",
        b.fmt("--gcc-install-dir={s}", .{gcc_install_dir}),
        "-std=c++20",
        "-stdlib=libstdc++",
        "-DJS_NO_EXPORT=1",
        "-fno-rtti",
        "-fPIC",
        "-c",
    });
    inline for (&.{
        "src",
        "vendors/libuv/include",
        "vendors/libuv/src",
        "src/jsc_sdk_compat",
    }) |include_dir| {
        command.addArg("-I");
        command.addDirectoryArg(b.path(include_dir));
    }
    command.addArg("-I");
    command.addDirectoryArg(b.path(b.fmt("{s}/include", .{vendor_dir})));
    command.addArg("-include");
    command.addFileArg(b.path("src/libuv_internal_symbols.h"));
    command.addFileArg(b.path(source));
    command.addArg("-o");
    return command.addOutputFileArg(output_name);
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
                "-include",
                "src/libuv_internal_symbols.h",
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
                "-include",
                "src/libuv_internal_symbols.h",
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

    if (target.os.tag != .windows) {
        module.addCSourceFiles(.{
            .root = b.path("src/compiler/src/jsc/bindings"),
            .files = &.{
                "uv-posix-polyfills.c",
                "uv-posix-stubs.c",
            },
            .flags = &.{
                "-std=c11",
                "-Wno-c23-extensions",
                "-Isrc/compiler/src/jsc/bindings/libuv",
                "-include",
                "src/bun_uv_compat_config.h",
            },
        });
        module.addCSourceFile(.{
            .file = b.path("src/libuv_compat_bridge.c"),
            .flags = &.{"-std=c11"},
        });
    }
}

fn configureJsc(step: *std.Build.Step.Compile, b: *std.Build) void {
    const resolved_target = step.root_module.resolved_target.?.result;
    step.rdynamic = resolved_target.os.tag != .windows;
    if (resolved_target.os.tag == .linux) {
        step.setVersionScript(b.path("src/compiler/src/symbols.dyn"));
        // The compatibility manifest is shared across supported Unix targets,
        // so platform-specific entries may be absent from one target.
        step.linker_allow_undefined_version = true;
    } else if (resolved_target.os.tag == .windows) {
        step.win32_module_definition = b.path("src/compiler/src/symbols.def");
    }
    // Static JSC uses indirectly referenced LLInt/JIT entry points that the
    // release linker otherwise discards, producing SIGBUS at runtime.
    step.link_gc_sections = false;
    step.root_module.link_libc = true;
    configureLibuv(step, b);
    step.root_module.addIncludePath(b.path("src"));
    step.root_module.addIncludePath(b.path("src/jsc_sdk_compat"));
    step.root_module.addIncludePath(b.path("src/compiler/src/jsc/bindings/sqlite"));
    step.root_module.addCMacro("COTTONTAIL_VERSION", b.fmt("\"{s}\"", .{cottontail_version}));
    if (resolved_target.os.tag == .linux) {
        // The POSIX libuv shims and synchronous signal forwarding use APIs
        // hidden by glibc's strict C11 feature set unless these are defined
        // for every C source group, not only the vendored libuv files.
        step.root_module.addCMacro("_GNU_SOURCE", "1");
        step.root_module.addCMacro("_POSIX_C_SOURCE", "200112");
    }
    const platform_key = jscVendorPlatformKey(resolved_target) orelse {
        std.debug.print(
            "error: no vendored JavaScriptCore target for {s}-{s}\n",
            .{ @tagName(resolved_target.os.tag), @tagName(resolved_target.cpu.arch) },
        );
        std.process.exit(1);
    };
    const vendor_dir = b.fmt("vendors/jsc/{s}/{s}", .{ jsc_vendor_tag, platform_key });
    const fallback_dir = b.fmt("{s}/lib/cottontail-icu", .{vendor_dir});
    const fallback_libraries: []const []const u8 = if (resolved_target.os.tag == .windows)
        &.{ "icui18n.lib", "icuuc.lib", "icudata.lib" }
    else
        &.{ "libicui18n.a", "libicuuc.a", "libicudata.a" };
    var has_icu_fallback = true;
    for (fallback_libraries) |library| {
        const path = b.fmt("{s}/{s}", .{ fallback_dir, library });
        std.Io.Dir.cwd().access(b.graph.io, b.pathFromRoot(path), .{}) catch {
            has_icu_fallback = false;
        };
    }
    step.root_module.addIncludePath(b.path(b.fmt("{s}/include", .{vendor_dir})));
    step.root_module.addIncludePath(b.path(b.fmt("{s}/include/cottontail", .{vendor_dir})));
    const icu_bridge_flags: []const []const u8 = if (has_icu_fallback)
        if (resolved_target.os.tag == .windows)
            &.{
                "-std=c11",
                "-DCOTTONTAIL_ICU_MIN_VERSION=70",
                "-DCOTTONTAIL_ICU_MAX_VERSION=99",
                "-DCOTTONTAIL_ICU_FALLBACK_VERSION=70",
                "-DCOTTONTAIL_ICU_HAS_FALLBACK=1",
            }
        else
            &.{
                "-std=c11",
                "-fPIC",
                "-DCOTTONTAIL_ICU_MIN_VERSION=70",
                "-DCOTTONTAIL_ICU_MAX_VERSION=99",
                "-DCOTTONTAIL_ICU_FALLBACK_VERSION=70",
                "-DCOTTONTAIL_ICU_HAS_FALLBACK=1",
            }
    else if (resolved_target.os.tag == .windows)
        &.{
            "-std=c11",
            "-DCOTTONTAIL_ICU_MIN_VERSION=70",
            "-DCOTTONTAIL_ICU_MAX_VERSION=99",
            "-DCOTTONTAIL_ICU_FALLBACK_VERSION=70",
        }
    else
        &.{
            "-std=c11",
            "-fPIC",
            "-DCOTTONTAIL_ICU_MIN_VERSION=70",
            "-DCOTTONTAIL_ICU_MAX_VERSION=99",
            "-DCOTTONTAIL_ICU_FALLBACK_VERSION=70",
        };
    step.root_module.addCSourceFile(.{
        .file = b.path("src/icu_bridge/icu-bridge.c"),
        .flags = icu_bridge_flags,
    });
    step.root_module.addCSourceFile(.{
        .file = b.path(switch (resolved_target.os.tag) {
            .macos => "src/icu_bridge/macos-trampolines.S",
            .linux => "src/icu_bridge/linux-trampolines.S",
            .windows => "src/icu_bridge/windows-trampolines.S",
            else => unreachable,
        }),
        .flags = if (resolved_target.os.tag == .windows) &.{} else &.{"-fPIC"},
    });
    step.root_module.addCSourceFiles(.{
        .root = b.path("."),
        .files = &.{
            "src/signal_forwarding.c",
            "src/stdlib/jsc_bridge.c",
            "src/jsc_runner.c",
            "src/native_bindings/registry.c",
            "src/native_bindings/runtime.c",
            "src/native_bindings/inspector.c",
            "src/native_bindings/buffer.c",
            "src/native_bindings/filesystem.c",
            "src/native_bindings/process.c",
            "src/native_bindings/http.c",
            "src/native_bindings/http_parser.c",
            "src/native_bindings/tooling.c",
            "src/native_bindings/memory_ffi.c",
            "src/native_bindings/worker.c",
            "src/native_bindings/system.c",
            "src/native_bindings/crypto.c",
            "src/native_bindings/dns.c",
            "src/native_bindings/sockets.c",
            "src/native_bindings/tls.c",
            "src/native_bindings/url.c",
            "src/native_bindings/platform.c",
            "src/native_bindings/path.c",
            "src/compiler/src/jsc/bindings/node/http/llhttp/api.c",
            "src/compiler/src/jsc/bindings/node/http/llhttp/http.c",
            "src/compiler/src/jsc/bindings/node/http/llhttp/llhttp.c",
        },
        .flags = if (resolved_target.os.tag == .windows)
            &.{
                "-std=c11",
                "-Wno-deprecated-declarations",
                "-DCOTTONTAIL_VENDORED_JSC=1",
                "-DJS_NO_EXPORT=1",
            }
        else
            &.{
                "-std=c11",
                "-Wno-deprecated-declarations",
                "-DCOTTONTAIL_VENDORED_JSC=1",
                "-DJS_NO_EXPORT=1",
                "-include",
                "src/libuv_internal_symbols.h",
            },
    });
    if (resolved_target.os.tag == .linux) {
        inline for (&.{
            .{ "src/jsc_private_bridge.cpp", "jsc_private_bridge.o" },
            .{ "src/inspector_bridge.cpp", "inspector_bridge.o" },
            .{ "src/jsc_stock_bridge.cpp", "jsc_stock_bridge.o" },
            .{ "src/napi_bridge.cpp", "napi_bridge.o" },
            .{ "src/url_bridge.cpp", "url_bridge.o" },
        }) |bridge| {
            step.root_module.addObjectFile(compileLinuxCppSource(b, vendor_dir, bridge[0], bridge[1]));
        }
    } else {
        const cpp_flags: []const []const u8 = if (resolved_target.os.tag == .windows)
            &.{
                "-std=c++20",
                "-DJS_NO_EXPORT=1",
                "-DBEXPORT=",
                "-fno-rtti",
                "-DWIN32_LEAN_AND_MEAN=1",
                "-DNOMINMAX=1",
                "-DU_DISABLE_RENAMING=1",
                // The vendored Windows SDK is static. Installed WTF headers
                // otherwise mark private WTF entry points as dllimport.
                "-DWTF_EXPORT_PRIVATE=",
                "-Wno-unused-command-line-argument",
                "-Wno-character-conversion",
            }
        else
            &.{
                "-std=c++20",
                "-DJS_NO_EXPORT=1",
                "-fno-rtti",
                "-Wno-character-conversion",
                "-include",
                "src/libuv_internal_symbols.h",
            };
        inline for (&.{
            "src/jsc_private_bridge.cpp",
            "src/inspector_bridge.cpp",
            "src/jsc_stock_bridge.cpp",
            "src/napi_bridge.cpp",
            "src/url_bridge.cpp",
        }) |source| {
            step.root_module.addCSourceFile(.{
                .file = b.path(source),
                .flags = cpp_flags,
            });
        }
        if (resolved_target.os.tag == .windows) {
            inline for (&.{
                "src/jsc_caller_origin_bridge.cpp",
                "src/compiler/src/jsc/bindings/windows/rescle.cpp",
                "src/compiler/src/jsc/bindings/windows/rescle-binding.cpp",
            }) |source| {
                step.root_module.addCSourceFile(.{
                    .file = b.path(source),
                    .flags = cpp_flags,
                });
            }
        }
    }
    switch (resolved_target.os.tag) {
        .macos => {
            requireJscLibrary(b, vendor_dir, "libJavaScriptCore.a");
            requireJscLibrary(b, vendor_dir, "libCottontailJSCEmbedder.a");
            // The vendored build is a JSCOnly static build: link the archives
            // directly plus the platform pieces the jsc binary itself depends
            // on. ICU calls are supplied by Cottontail's dispatch bridge.
            step.root_module.addIncludePath(b.path(b.fmt("{s}/include", .{vendor_dir})));
            step.root_module.addObjectFile(b.path(b.fmt("{s}/lib/libJavaScriptCore.a", .{vendor_dir})));
            step.root_module.addObjectFile(b.path(b.fmt("{s}/lib/libCottontailJSCEmbedder.a", .{vendor_dir})));
            step.root_module.addObjectFile(b.path(b.fmt("{s}/lib/libWTF.a", .{vendor_dir})));
            step.root_module.addObjectFile(b.path(b.fmt("{s}/lib/libbmalloc.a", .{vendor_dir})));
            step.root_module.link_libcpp = true;
            if (!has_icu_fallback)
                @panic("macOS JSC setup did not provide the static ICU fallback");
            for (fallback_libraries) |library|
                step.root_module.addObjectFile(b.path(b.fmt("{s}/{s}", .{ fallback_dir, library })));
            step.root_module.linkSystemLibrary("pthread", .{});
            step.root_module.linkSystemLibrary("resolv", .{});
            step.root_module.linkSystemLibrary("z", .{});
            step.root_module.addSystemIncludePath(.{ .cwd_relative = "/opt/homebrew/include" });
            step.root_module.addLibraryPath(.{ .cwd_relative = "/opt/homebrew/lib" });
            step.root_module.linkSystemLibrary("ssl", .{ .preferred_link_mode = .static });
            step.root_module.linkSystemLibrary("crypto", .{ .preferred_link_mode = .static });
        },
        .linux => {
            requireJscLibrary(b, vendor_dir, "libJavaScriptCore.a");
            requireJscLibrary(b, vendor_dir, "libCottontailJSCEmbedder.a");
            if (!has_icu_fallback)
                @panic("Linux JSC setup did not provide the static ICU fallback");
            step.root_module.addObjectFile(b.path(b.fmt("{s}/lib/libJavaScriptCore.a", .{vendor_dir})));
            step.root_module.addObjectFile(b.path(b.fmt("{s}/lib/libCottontailJSCEmbedder.a", .{vendor_dir})));
            step.root_module.addObjectFile(b.path(b.fmt("{s}/lib/libWTF.a", .{vendor_dir})));
            step.root_module.addObjectFile(b.path(b.fmt("{s}/lib/libbmalloc.a", .{vendor_dir})));
            for (fallback_libraries) |library|
                step.root_module.addObjectFile(b.path(b.fmt("{s}/{s}", .{ fallback_dir, library })));
            inline for (&.{ "atomic", "m", "pthread", "z" }) |library|
                step.root_module.linkSystemLibrary(library, .{});
            // Zig treats these names as aliases for its own libc/libc++ and
            // drops them before linking. Concrete files preserve the GNU C++
            // ABI and unwind runtime used by the JSC/Rust archives, plus
            // glibc's resolver implementation.
            //
            // libresolv must be the shared object, never the static archive:
            // libresolv.a's ns_parse.o reaches for __libc_dn_expand and the
            // errno TLS slot, both exported only under GLIBC_PRIVATE, which
            // pins the release to one host glibc build. libresolv.so.2 keeps
            // those calls inside itself and exposes ns_initparse/ns_parserr
            // under a public version instead.
            step.root_module.addObjectFile(copyLinuxSystemLibrary(b, "libstdc++.so"));
            step.root_module.addObjectFile(copyLinuxSystemLibrary(b, "libgcc_s.so.1"));
            step.root_module.addObjectFile(copyLinuxSystemLibrary(b, "libresolv.so"));
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
            requireJscLibrary(b, vendor_dir, "CottontailJSCEmbedder.lib");
            step.root_module.addIncludePath(b.path(b.fmt("{s}/include", .{dependency_dir})));
            step.root_module.addLibraryPath(b.path(b.fmt("{s}/lib", .{dependency_dir})));
            step.root_module.addObjectFile(b.path(b.fmt("{s}/lib/JavaScriptCore.lib", .{vendor_dir})));
            step.root_module.addObjectFile(b.path(b.fmt("{s}/lib/CottontailJSCEmbedder.lib", .{vendor_dir})));
            step.root_module.addObjectFile(b.path(b.fmt("{s}/lib/WTF.lib", .{vendor_dir})));
            step.root_module.addObjectFile(b.path(b.fmt("{s}/lib/bmalloc.lib", .{vendor_dir})));
            if (!has_icu_fallback)
                @panic("Windows JSC setup did not provide the static ICU fallback");
            for (fallback_libraries) |library|
                step.root_module.addObjectFile(b.path(b.fmt("{s}/{s}", .{ fallback_dir, library })));
            inline for (&.{
                "dl.lib", "libcrypto.lib", "libssl.lib", "zs.lib", "zstd.lib",
            }) |library| {
                step.root_module.addObjectFile(b.path(b.fmt("{s}/lib/{s}", .{ dependency_dir, library })));
            }
            inline for (&.{ "advapi32", "bcrypt", "crypt32", "dnsapi", "iphlpapi", "psapi", "shell32", "user32", "userenv", "winmm", "ws2_32" }) |library| {
                step.root_module.linkSystemLibrary(library, .{});
            }
        },
        else => unreachable,
    }
}

fn requireJscLibrary(b: *std.Build, vendor_dir: []const u8, library: []const u8) void {
    requireJscFile(b, vendor_dir, b.fmt("lib/{s}", .{library}));
}

fn requireJscFile(b: *std.Build, vendor_dir: []const u8, relative_path: []const u8) void {
    const path = b.fmt("{s}/{s}", .{ vendor_dir, relative_path });
    std.Io.Dir.cwd().access(b.graph.io, b.pathFromRoot(path), .{}) catch {
        std.debug.print(
            "error: vendored JavaScriptCore file not found at {s}; run `node scripts/setup-jsc.js` first\n",
            .{path},
        );
        std.process.exit(1);
    };
}

pub fn build(b: *std.Build) void {
    // The Windows release is x86-64 MSVC even when the host is Windows ARM.
    // Make both the architecture and ABI explicit so Zig does not derive a
    // native CPU model from the CI host. The vendored JSC, Visual Studio SDK,
    // and vcpkg dependencies all use this same target.
    const target = b.standardTargetOptions(.{
        .default_target = if (builtin.os.tag == .windows) .{
            .cpu_arch = .x86_64,
            .cpu_model = .baseline,
            .os_tag = .windows,
            .abi = .msvc,
        } else .{},
    });
    const optimize = b.standardOptimizeOption(.{});
    const capability_jsc_platform = jscVendorPlatformKey(target.result) orelse {
        std.debug.print("error: no vendored JavaScriptCore target for capability build\n", .{});
        std.process.exit(1);
    };
    const capability_jsc_include = b.fmt(
        "vendors/jsc/{s}/{s}/include",
        .{ jsc_vendor_tag, capability_jsc_platform },
    );
    const test_filters = b.option(
        []const []const u8,
        "test-filter",
        "Only compile Zig tests whose names match a filter",
    ) orelse &[0][]const u8{};
    const runtime_module_artifacts = embedRuntimeModules(b);
    const runtime_modules_blob = runtime_module_artifacts.core;

    const exe = b.addExecutable(.{
        .name = "cottontail",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = target,
            .optimize = optimize,
            .strip = optimize == .ReleaseSmall,
        }),
    });
    exe.root_module.addImport("cottontail_compiler", createCompilerModule(b, target, optimize));
    exe.root_module.addAnonymousImport("runtime_modules_blob", .{ .root_source_file = runtime_modules_blob });

    // Cross-target semantic analysis for the Windows Zig code. Depending on
    // the compile step directly leaves its output unrequested, so Zig uses
    // -fno-emit-bin and neither links JSC nor requires Windows SDK libraries.
    const windows_check_target = b.resolveTargetQuery(.{
        .cpu_arch = .x86_64,
        .cpu_model = .baseline,
        .os_tag = .windows,
        .abi = .gnu,
    });
    const windows_check = b.addExecutable(.{
        .name = "cottontail-windows-check",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = windows_check_target,
            .optimize = optimize,
        }),
    });
    windows_check.root_module.link_libc = true;
    windows_check.root_module.addIncludePath(b.path("src"));
    windows_check.root_module.addImport("cottontail_compiler", createCompilerModule(b, windows_check_target, optimize));
    windows_check.root_module.addAnonymousImport("runtime_modules_blob", .{ .root_source_file = runtime_modules_blob });
    const check_windows_step = b.step("check-windows", "Semantically check the Windows target without linking");
    check_windows_step.dependOn(&windows_check.step);

    const upstream_command_adapter = b.addExecutable(.{
        .name = "cottontail-upstream-command",
        .root_module = b.createModule(.{
            .root_source_file = b.path("tests/upstream-command-adapter.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });
    b.installArtifact(upstream_command_adapter);

    if (target.result.os.tag == .windows) {
        const upstream_job_launcher = b.addExecutable(.{
            .name = "cottontail-bun-compat-job",
            .root_module = b.createModule(.{
                .root_source_file = b.path("tests/windows-job-launcher.zig"),
                .target = target,
                .optimize = optimize,
            }),
        });
        b.installArtifact(upstream_job_launcher);
    }

    configureJsc(exe, b);

    const capability_builder = b.addExecutable(.{
        .name = "cottontail-capability-builder",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });
    capability_builder.root_module.addImport("cottontail_compiler", createCompilerModule(b, target, optimize));
    capability_builder.root_module.addAnonymousImport("runtime_modules_blob", .{ .root_source_file = runtime_module_artifacts.capability_builder });
    capability_builder.root_module.addAnonymousImport("capability_namespace_source", .{ .root_source_file = b.path("src/capability_namespace_bootstrap.js") });
    configureJsc(capability_builder, b);
    // The build-time runtime must not resolve the production filesystem-backed
    // capability namespace: it is the process creating those files. It gets a
    // deliberately small embedded namespace from bun/index.js instead.
    capability_builder.root_module.addCMacro("COTTONTAIL_CAPABILITY_BUILDER", "1");

    const namespace_bytecode_command = b.addRunArtifact(exe);
    namespace_bytecode_command.addArg("--cottontail-generate-sync-bytecode");
    namespace_bytecode_command.addFileArg(b.path("src/capability_namespace_bootstrap.js"));
    const namespace_bytecode = namespace_bytecode_command.addOutputFileArg("capability-namespace.jsc");
    namespace_bytecode_command.addArg("cottontail:core/capability-namespace");
    const host_bootstrap_source_command = b.addSystemCommand(&.{"node"});
    host_bootstrap_source_command.addFileArg(b.path("scripts/extract-host-bootstrap.js"));
    host_bootstrap_source_command.addFileArg(b.path("src/jsc_runner.c"));
    const host_bootstrap_source = host_bootstrap_source_command.addOutputFileArg("host-bootstrap.js");
    const host_bootstrap_bytecode_command = b.addRunArtifact(exe);
    host_bootstrap_bytecode_command.addArg("--cottontail-generate-sync-bytecode");
    host_bootstrap_bytecode_command.addFileArg(host_bootstrap_source);
    const host_bootstrap_bytecode = host_bootstrap_bytecode_command.addOutputFileArg("host-bootstrap.jsc");
    host_bootstrap_bytecode_command.addArg("cottontail:core/host-bootstrap");
    for ([_]*std.Build.Step.Compile{ exe, windows_check }) |runtime_executable| {
        runtime_executable.root_module.addAnonymousImport("capability_namespace_source", .{ .root_source_file = b.path("src/capability_namespace_bootstrap.js") });
    }
    const core_runtime_modules = .{
        .{ "assert", "src/runtime_modules/node/assert.js" },
        .{ "async_hooks", "src/runtime_modules/node/async_hooks.js" },
        .{ "buffer", "src/runtime_modules/node/buffer.js" },
        .{ "constants", "src/runtime_modules/node/constants.js" },
        .{ "crypto", "src/runtime_modules/node/crypto.js" },
        .{ "events", "src/runtime_modules/node/events.js" },
        .{ "fs", "src/runtime_modules/node/fs.js" },
        .{ "http", "src/runtime_modules/node/http.js" },
        .{ "net", "src/runtime_modules/node/net.js" },
        .{ "path", "src/runtime_modules/node/path.js" },
        .{ "stream", "src/runtime_modules/node/stream.js" },
        .{ "tls", "src/runtime_modules/node/tls.js" },
        .{ "tty", "src/runtime_modules/node/tty.js" },
        .{ "url", "src/runtime_modules/node/url.js" },
        .{ "v8", "src/runtime_modules/node/v8.js" },
    };

    const ffi_capability_bytecode = buildStdlibCapability(b, capability_builder, exe, "ffi", "src/stdlib/ffi/main.js");
    const sqlite_capability_bytecode = buildStdlibCapability(b, capability_builder, exe, "sqlite", "src/stdlib/sqlite/main.js");
    const sql_capability_bytecode = buildStdlibCapability(b, capability_builder, exe, "sql", "src/stdlib/sql/main.js");
    const javascript_capabilities = .{
        .{ "redis", "src/stdlib/redis/main.js" },
        .{ "s3", "src/stdlib/s3/main.js" },
        .{ "toml", "src/stdlib/toml/main.js" },
        .{ "json5", "src/stdlib/json5/main.js" },
        .{ "colors", "src/stdlib/colors/main.js" },
        .{ "cookies", "src/stdlib/cookies/main.js" },
        .{ "websocket", "src/stdlib/websocket/main.js" },
        .{ "jsc-tools", "src/stdlib/jsc-tools/main.js" },
        .{ "yaml", "src/stdlib/yaml/main.js" },
        .{ "test", "src/stdlib/test/main.js" },
        .{ "shell", "src/stdlib/shell/main.js" },
        .{ "build", "src/stdlib/build/main.js" },
        .{ "bake", "src/stdlib/bake/main.js" },
        .{ "inspector", "src/stdlib/inspector/main.js" },
        .{ "repl", "src/stdlib/repl/main.js" },
        .{ "sea", "src/stdlib/sea/main.js" },
        .{ "compression", "src/stdlib/compression/main.js" },
        .{ "glob", "src/stdlib/glob/main.js" },
        .{ "text", "src/stdlib/text/main.js" },
        .{ "uuid", "src/stdlib/uuid/main.js" },
        .{ "password", "src/stdlib/password/main.js" },
        .{ "hashing", "src/stdlib/hashing/main.js" },
        .{ "data", "src/stdlib/data/main.js" },
        .{ "markdown", "src/stdlib/markdown/main.js" },
        .{ "archive", "src/stdlib/archive/main.js" },
        .{ "filesystem-router", "src/stdlib/filesystem-router/main.js" },
        .{ "html-rewriter", "src/stdlib/html-rewriter/main.js" },
        .{ "terminal", "src/stdlib/terminal/main.js" },
        .{ "csrf", "src/stdlib/csrf/main.js" },
        .{ "secrets", "src/stdlib/secrets/main.js" },
    };

    const capability_c_flags: []const []const u8 = if (target.result.os.tag == .windows)
        &.{"-std=c11"}
    else
        &.{ "-std=c11", "-fPIC" };

    const windows_jsc_bridge_import_library: ?std.Build.LazyPath = if (target.result.os.tag == .windows) blk: {
        // A PE DLL cannot bind plain unresolved references against symbols in
        // the already-running executable. Generate an import library for the
        // private, prefixed JSC bridge exported by cottontail.exe. Stock JSC
        // names must remain private to the statically linked runtime core.
        const command = b.addSystemCommand(&.{
            b.graph.zig_exe,
            "dlltool",
            "-m",
            "i386:x86-64",
            "-D",
            "cottontail.exe",
            "-d",
        });
        command.addFileArg(b.path("src/compiler/src/symbols.def"));
        command.addArg("-l");
        break :blk command.addOutputFileArg("cottontail-jsc-bridge.lib");
    } else null;

    const sqlite_capability_module = b.createModule(.{
        .target = target,
        .optimize = optimize,
        .link_libc = true,
        .pic = true,
    });
    sqlite_capability_module.addIncludePath(b.path("src"));
    sqlite_capability_module.addIncludePath(b.path(capability_jsc_include));
    sqlite_capability_module.addIncludePath(b.path("src/compiler/src/jsc/bindings/sqlite"));
    sqlite_capability_module.addCSourceFiles(.{
        .root = b.path("."),
        .files = &.{
            "src/stdlib/sqlite/sqlite_capability.c",
            "src/compiler/src/jsc/bindings/sqlite/sqlite3.c",
        },
        .flags = if (target.result.os.tag == .windows) &.{
            "-std=c11",
            "-DSQLITE_ENABLE_COLUMN_METADATA",
            "-DSQLITE_ENABLE_FTS5",
            "-DSQLITE_ENABLE_MATH_FUNCTIONS",
            "-DSQLITE_ENABLE_SESSION",
            "-DSQLITE_ENABLE_PREUPDATE_HOOK",
            "-DSQLITE_ENABLE_UPDATE_DELETE_LIMIT",
            "-DSQLITE_THREADSAFE=1",
        } else &.{
            "-std=c11",                       "-fPIC",                               "-DSQLITE_ENABLE_COLUMN_METADATA",
            "-DSQLITE_ENABLE_FTS5",           "-DSQLITE_ENABLE_MATH_FUNCTIONS",      "-DSQLITE_ENABLE_SESSION",
            "-DSQLITE_ENABLE_PREUPDATE_HOOK", "-DSQLITE_ENABLE_UPDATE_DELETE_LIMIT", "-DSQLITE_THREADSAFE=1",
        },
    });
    const sqlite_capability = b.addLibrary(.{
        .name = "cottontail-sqlite",
        .linkage = .dynamic,
        .root_module = sqlite_capability_module,
    });
    sqlite_capability.linker_allow_shlib_undefined = true;

    const sql_capability_module = b.createModule(.{
        .root_source_file = b.path("src/sql_wire.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
        .pic = true,
    });
    sql_capability_module.addIncludePath(b.path("src"));
    sql_capability_module.addIncludePath(b.path(capability_jsc_include));
    sql_capability_module.addCSourceFile(.{
        .file = b.path("src/stdlib/sql/sql_capability.c"),
        .flags = capability_c_flags,
    });
    const sql_capability = b.addLibrary(.{
        .name = "cottontail-sql",
        .linkage = .dynamic,
        .root_module = sql_capability_module,
    });
    sql_capability.linker_allow_shlib_undefined = true;

    const compression_capability_module = b.createModule(.{
        .target = target,
        .optimize = optimize,
        .link_libc = true,
        .pic = true,
    });
    compression_capability_module.addIncludePath(b.path("src"));
    compression_capability_module.addIncludePath(b.path(capability_jsc_include));
    compression_capability_module.addCSourceFile(.{
        .file = b.path("src/stdlib/compression/compression_capability.c"),
        .flags = capability_c_flags,
    });
    if (target.result.os.tag == .macos) {
        compression_capability_module.addSystemIncludePath(.{ .cwd_relative = "/opt/homebrew/include" });
        compression_capability_module.addLibraryPath(.{ .cwd_relative = "/opt/homebrew/lib" });
    } else if (target.result.os.tag == .windows) {
        compression_capability_module.addIncludePath(b.path("vendors/windows-deps/x64-windows-static/include"));
        compression_capability_module.addLibraryPath(b.path("vendors/windows-deps/x64-windows-static/lib"));
    }
    const compression_capability = b.addLibrary(.{
        .name = "cottontail-compression",
        .linkage = .dynamic,
        .root_module = compression_capability_module,
    });
    compression_capability.linker_allow_shlib_undefined = true;
    if (target.result.os.tag == .windows) {
        inline for (&.{ "zs.lib", "brotlicommon.lib", "brotlidec.lib", "brotlienc.lib" }) |library| {
            compression_capability.root_module.addObjectFile(b.path(b.fmt("vendors/windows-deps/x64-windows-static/lib/{s}", .{library})));
        }
    } else {
        compression_capability.root_module.linkSystemLibrary("z", .{});
        inline for (&.{ "brotlicommon", "brotlidec", "brotlienc" }) |library| {
            compression_capability.root_module.linkSystemLibrary(library, .{});
        }
    }

    const websocket_capability_module = b.createModule(.{
        .root_source_file = b.path("src/websocket_frame.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
        .pic = true,
    });
    websocket_capability_module.addImport("cottontail_compiler", createCompilerModule(b, target, optimize));
    websocket_capability_module.addIncludePath(b.path("src"));
    websocket_capability_module.addIncludePath(b.path(capability_jsc_include));
    websocket_capability_module.addCSourceFile(.{
        .file = b.path("src/stdlib/websocket/websocket_capability.c"),
        .flags = if (target.result.os.tag == .windows) &.{"-std=c11"} else &.{ "-std=c11", "-fPIC", "-D_DEFAULT_SOURCE" },
    });
    const websocket_capability = b.addLibrary(.{
        .name = "cottontail-websocket",
        .linkage = .dynamic,
        .root_module = websocket_capability_module,
    });
    websocket_capability.linker_allow_shlib_undefined = true;

    const text_capability_module = b.createModule(.{
        .root_source_file = b.path("src/stdlib/text/text_capability.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
        .pic = true,
    });
    text_capability_module.addImport("cottontail_compiler", createCompilerModule(b, target, optimize));
    const text_string_width_module = b.createModule(.{
        .root_source_file = b.path("src/string_width.zig"),
        .target = target,
        .optimize = optimize,
    });
    text_string_width_module.addImport("cottontail_compiler", createCompilerModule(b, target, optimize));
    text_capability_module.addImport("string_width", text_string_width_module);
    text_capability_module.addImport("strip_ansi", b.createModule(.{
        .root_source_file = b.path("src/strip_ansi.zig"),
        .target = target,
        .optimize = optimize,
    }));
    text_capability_module.addIncludePath(b.path("src"));
    text_capability_module.addIncludePath(b.path(capability_jsc_include));
    text_capability_module.addCSourceFile(.{
        .file = b.path("src/stdlib/text/text_capability.c"),
        .flags = capability_c_flags,
    });
    const text_capability = b.addLibrary(.{
        .name = "cottontail-text",
        .linkage = .dynamic,
        .root_module = text_capability_module,
    });
    text_capability.linker_allow_shlib_undefined = true;

    const uuid_capability_module = b.createModule(.{
        .root_source_file = b.path("src/stdlib/uuid/uuid_capability.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
        .pic = true,
    });
    uuid_capability_module.addImport("native_uuid", b.createModule(.{
        .root_source_file = b.path("src/native_uuid.zig"),
        .target = target,
        .optimize = optimize,
    }));
    uuid_capability_module.addIncludePath(b.path("src"));
    uuid_capability_module.addIncludePath(b.path(capability_jsc_include));
    uuid_capability_module.addCSourceFile(.{
        .file = b.path("src/stdlib/uuid/uuid_capability.c"),
        .flags = capability_c_flags,
    });
    const uuid_capability = b.addLibrary(.{
        .name = "cottontail-uuid",
        .linkage = .dynamic,
        .root_module = uuid_capability_module,
    });
    uuid_capability.linker_allow_shlib_undefined = true;

    const glob_capability_module = b.createModule(.{
        .root_source_file = b.path("src/stdlib/glob/glob_capability.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
        .pic = true,
    });
    const glob_native_module = b.createModule(.{
        .root_source_file = b.path("src/glob_match.zig"),
        .target = target,
        .optimize = optimize,
    });
    glob_native_module.addImport("cottontail_compiler", createCompilerModule(b, target, optimize));
    glob_capability_module.addImport("native_glob", glob_native_module);
    glob_capability_module.addIncludePath(b.path("src"));
    glob_capability_module.addIncludePath(b.path(capability_jsc_include));
    glob_capability_module.addCSourceFile(.{
        .file = b.path("src/stdlib/glob/glob_capability.c"),
        .flags = capability_c_flags,
    });
    const glob_capability = b.addLibrary(.{
        .name = "cottontail-glob",
        .linkage = .dynamic,
        .root_module = glob_capability_module,
    });
    glob_capability.linker_allow_shlib_undefined = true;

    const password_capability_module = b.createModule(.{
        .root_source_file = b.path("src/stdlib/password/password_capability.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
        .pic = true,
    });
    const password_native_module = b.createModule(.{
        .root_source_file = b.path("src/cottontail_password.zig"),
        .target = target,
        .optimize = optimize,
    });
    password_capability_module.addImport("password_native", password_native_module);
    password_capability_module.addIncludePath(b.path("src"));
    password_capability_module.addIncludePath(b.path(capability_jsc_include));
    password_capability_module.addCSourceFile(.{
        .file = b.path("src/stdlib/password/password_capability.c"),
        .flags = capability_c_flags,
    });
    const password_capability = b.addLibrary(.{
        .name = "cottontail-password",
        .linkage = .dynamic,
        .root_module = password_capability_module,
    });
    password_capability.linker_allow_shlib_undefined = true;

    const hashing_capability_module = b.createModule(.{
        .root_source_file = b.path("src/stdlib/hashing/hashing_capability.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
        .pic = true,
    });
    hashing_capability_module.addImport("native_hashing", b.createModule(.{
        .root_source_file = b.path("src/cottontail_hash.zig"),
        .target = target,
        .optimize = optimize,
    }));
    hashing_capability_module.addIncludePath(b.path("src"));
    hashing_capability_module.addIncludePath(b.path(capability_jsc_include));
    hashing_capability_module.addCSourceFile(.{
        .file = b.path("src/stdlib/hashing/hashing_capability.c"),
        .flags = capability_c_flags,
    });
    const hashing_capability = b.addLibrary(.{
        .name = "cottontail-hashing",
        .linkage = .dynamic,
        .root_module = hashing_capability_module,
    });
    hashing_capability.linker_allow_shlib_undefined = true;
    switch (target.result.os.tag) {
        .macos => {
            hashing_capability.root_module.addSystemIncludePath(.{ .cwd_relative = "/opt/homebrew/include" });
            hashing_capability.root_module.addLibraryPath(.{ .cwd_relative = "/opt/homebrew/lib" });
            hashing_capability.root_module.linkSystemLibrary("crypto", .{ .preferred_link_mode = .static });
            hashing_capability.root_module.linkSystemLibrary("zstd", .{ .preferred_link_mode = .static });
        },
        .linux => {
            hashing_capability.root_module.linkSystemLibrary("crypto", .{ .preferred_link_mode = .static });
            hashing_capability.root_module.linkSystemLibrary("zstd", .{
                .use_pkg_config = .no,
                .preferred_link_mode = .static,
                .search_strategy = .no_fallback,
            });
        },
        .windows => {
            const dependency_dir = "vendors/windows-deps/x64-windows-static";
            hashing_capability.root_module.addIncludePath(b.path(b.fmt("{s}/include", .{dependency_dir})));
            hashing_capability.root_module.addLibraryPath(b.path(b.fmt("{s}/lib", .{dependency_dir})));
            hashing_capability.root_module.addObjectFile(b.path(b.fmt("{s}/lib/libcrypto.lib", .{dependency_dir})));
            hashing_capability.root_module.addObjectFile(b.path(b.fmt("{s}/lib/zstd.lib", .{dependency_dir})));
            hashing_capability.root_module.linkSystemLibrary("bcrypt", .{});
            hashing_capability.root_module.linkSystemLibrary("crypt32", .{});
        },
        else => {},
    }

    const markdown_capability_module = b.createModule(.{
        .root_source_file = b.path("src/stdlib/markdown/markdown_capability.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
        .pic = true,
    });
    const native_markdown_module = b.createModule(.{
        .root_source_file = b.path("src/cottontail_markdown.zig"),
        .target = target,
        .optimize = optimize,
    });
    native_markdown_module.addImport("cottontail_compiler", createCompilerModule(b, target, optimize));
    markdown_capability_module.addImport("native_markdown", native_markdown_module);
    markdown_capability_module.addIncludePath(b.path("src"));
    markdown_capability_module.addIncludePath(b.path(capability_jsc_include));
    markdown_capability_module.addCSourceFile(.{
        .file = b.path("src/stdlib/markdown/markdown_capability.c"),
        .flags = capability_c_flags,
    });
    const markdown_capability = b.addLibrary(.{
        .name = "cottontail-markdown",
        .linkage = .dynamic,
        .root_module = markdown_capability_module,
    });
    markdown_capability.linker_allow_shlib_undefined = true;

    const terminal_capability_module = b.createModule(.{
        .target = target,
        .optimize = optimize,
        .link_libc = true,
        .pic = true,
    });
    terminal_capability_module.addIncludePath(b.path("src"));
    terminal_capability_module.addIncludePath(b.path(capability_jsc_include));
    terminal_capability_module.addCSourceFile(.{
        .file = b.path("src/stdlib/terminal/terminal_capability.c"),
        .flags = if (target.result.os.tag == .windows) &.{"-std=c11"} else &.{ "-std=c11", "-fPIC", "-D_DARWIN_C_SOURCE", "-D_GNU_SOURCE" },
    });
    const terminal_capability = b.addLibrary(.{
        .name = "cottontail-terminal",
        .linkage = .dynamic,
        .root_module = terminal_capability_module,
    });
    terminal_capability.linker_allow_shlib_undefined = true;

    const ffi_native_module = b.createModule(.{
        .target = target,
        .optimize = optimize,
        .link_libc = true,
        .pic = true,
    });
    ffi_native_module.addIncludePath(b.path("src"));
    ffi_native_module.addIncludePath(b.path(capability_jsc_include));
    ffi_native_module.addCSourceFile(.{
        .file = b.path("src/stdlib/ffi/ffi_capability.c"),
        .flags = capability_c_flags,
    });
    const ffi_native = b.addLibrary(.{
        .name = "cottontail-ffi",
        .linkage = .dynamic,
        .root_module = ffi_native_module,
    });
    ffi_native.linker_allow_shlib_undefined = true;
    if (windows_jsc_bridge_import_library) |import_library| {
        inline for (&.{
            sqlite_capability,
            sql_capability,
            compression_capability,
            websocket_capability,
            text_capability,
            uuid_capability,
            glob_capability,
            password_capability,
            hashing_capability,
            markdown_capability,
            terminal_capability,
            ffi_native,
        }) |capability| capability.root_module.addObjectFile(import_library);
    }
    switch (target.result.os.tag) {
        .macos => {
            ffi_native.root_module.addSystemIncludePath(.{ .cwd_relative = "/opt/homebrew/include" });
            ffi_native.root_module.addLibraryPath(.{ .cwd_relative = "/opt/homebrew/lib" });
            ffi_native.root_module.linkSystemLibrary("ffi", .{ .preferred_link_mode = .static });
        },
        .linux => ffi_native.root_module.linkSystemLibrary("ffi", .{ .preferred_link_mode = .dynamic }),
        .windows => {
            const dependency_dir = "vendors/windows-deps/x64-windows-static";
            ffi_native.root_module.addIncludePath(b.path(b.fmt("{s}/include", .{dependency_dir})));
            ffi_native.root_module.addObjectFile(b.path(b.fmt("{s}/lib/ffi.lib", .{dependency_dir})));
        },
        else => unreachable,
    }

    const install_exe = b.addInstallArtifact(exe, .{});
    const install_namespace_bytecode = b.addInstallFile(namespace_bytecode, "bin/cottontail-core/capability-namespace.jsc");
    install_exe.step.dependOn(&install_namespace_bytecode.step);
    const install_host_bootstrap_bytecode = b.addInstallFile(host_bootstrap_bytecode, "bin/cottontail-core/host-bootstrap.jsc");
    install_exe.step.dependOn(&install_host_bootstrap_bytecode.step);
    inline for (core_runtime_modules) |runtime_module_definition| {
        const bytecode = buildCoreRuntimeModule(
            b,
            capability_builder,
            exe,
            runtime_module_definition[0],
            runtime_module_definition[1],
        );
        const install = b.addInstallFile(
            bytecode,
            b.fmt("bin/cottontail-core/runtime/{s}.jsc", .{runtime_module_definition[0]}),
        );
        install_exe.step.dependOn(&install.step);
    }
    if (target.result.os.tag == .windows) {
        const secrets_capability_module = b.createModule(.{
            .target = target,
            .optimize = optimize,
            .link_libc = true,
            .pic = true,
        });
        secrets_capability_module.addIncludePath(b.path("src"));
        secrets_capability_module.addIncludePath(b.path(capability_jsc_include));
        secrets_capability_module.addCSourceFile(.{
            .file = b.path("src/stdlib/secrets/secrets_capability.c"),
            .flags = capability_c_flags,
        });
        secrets_capability_module.linkSystemLibrary("advapi32", .{});
        const secrets_capability = b.addLibrary(.{
            .name = "cottontail-secrets",
            .linkage = .dynamic,
            .root_module = secrets_capability_module,
        });
        secrets_capability.linker_allow_shlib_undefined = true;
        secrets_capability.root_module.addObjectFile(windows_jsc_bridge_import_library.?);
        const install_secrets_library = b.addInstallFile(
            secrets_capability.getEmittedBin(),
            "bin/cottontail-stdlib/secrets/secrets.dll",
        );
        install_exe.step.dependOn(&install_secrets_library.step);
    }
    const install_ffi_capability = b.addInstallFile(
        ffi_capability_bytecode,
        "bin/cottontail-stdlib/ffi/main.jsc",
    );
    const install_ffi_library = b.addInstallFile(
        ffi_native.getEmittedBin(),
        b.fmt("bin/cottontail-stdlib/ffi/ffi{s}", .{target.result.dynamicLibSuffix()}),
    );
    const install_sqlite_capability = b.addInstallFile(
        sqlite_capability_bytecode,
        "bin/cottontail-stdlib/sqlite/main.jsc",
    );
    const install_sqlite_library = b.addInstallFile(
        sqlite_capability.getEmittedBin(),
        b.fmt("bin/cottontail-stdlib/sqlite/sqlite{s}", .{target.result.dynamicLibSuffix()}),
    );
    const install_sql_capability = b.addInstallFile(
        sql_capability_bytecode,
        "bin/cottontail-stdlib/sql/main.jsc",
    );
    const install_sql_library = b.addInstallFile(
        sql_capability.getEmittedBin(),
        b.fmt("bin/cottontail-stdlib/sql/sql{s}", .{target.result.dynamicLibSuffix()}),
    );
    const install_compression_library = b.addInstallFile(
        compression_capability.getEmittedBin(),
        b.fmt("bin/cottontail-stdlib/compression/compression{s}", .{target.result.dynamicLibSuffix()}),
    );
    const install_websocket_library = b.addInstallFile(
        websocket_capability.getEmittedBin(),
        b.fmt("bin/cottontail-stdlib/websocket/websocket{s}", .{target.result.dynamicLibSuffix()}),
    );
    const install_text_library = b.addInstallFile(
        text_capability.getEmittedBin(),
        b.fmt("bin/cottontail-stdlib/text/text{s}", .{target.result.dynamicLibSuffix()}),
    );
    const install_uuid_library = b.addInstallFile(
        uuid_capability.getEmittedBin(),
        b.fmt("bin/cottontail-stdlib/uuid/uuid{s}", .{target.result.dynamicLibSuffix()}),
    );
    const install_glob_library = b.addInstallFile(
        glob_capability.getEmittedBin(),
        b.fmt("bin/cottontail-stdlib/glob/glob{s}", .{target.result.dynamicLibSuffix()}),
    );
    const install_password_library = b.addInstallFile(
        password_capability.getEmittedBin(),
        b.fmt("bin/cottontail-stdlib/password/password{s}", .{target.result.dynamicLibSuffix()}),
    );
    const install_hashing_library = b.addInstallFile(
        hashing_capability.getEmittedBin(),
        b.fmt("bin/cottontail-stdlib/hashing/hashing{s}", .{target.result.dynamicLibSuffix()}),
    );
    const install_markdown_library = b.addInstallFile(
        markdown_capability.getEmittedBin(),
        b.fmt("bin/cottontail-stdlib/markdown/markdown{s}", .{target.result.dynamicLibSuffix()}),
    );
    const install_terminal_library = b.addInstallFile(
        terminal_capability.getEmittedBin(),
        b.fmt("bin/cottontail-stdlib/terminal/terminal{s}", .{target.result.dynamicLibSuffix()}),
    );
    install_exe.step.dependOn(&install_ffi_capability.step);
    install_exe.step.dependOn(&install_ffi_library.step);
    install_exe.step.dependOn(&install_sqlite_capability.step);
    install_exe.step.dependOn(&install_sqlite_library.step);
    install_exe.step.dependOn(&install_sql_capability.step);
    install_exe.step.dependOn(&install_sql_library.step);
    install_exe.step.dependOn(&install_compression_library.step);
    install_exe.step.dependOn(&install_websocket_library.step);
    install_exe.step.dependOn(&install_text_library.step);
    install_exe.step.dependOn(&install_uuid_library.step);
    install_exe.step.dependOn(&install_glob_library.step);
    install_exe.step.dependOn(&install_password_library.step);
    install_exe.step.dependOn(&install_hashing_library.step);
    install_exe.step.dependOn(&install_markdown_library.step);
    install_exe.step.dependOn(&install_terminal_library.step);
    inline for (javascript_capabilities) |capability| {
        const bytecode = buildStdlibCapability(b, capability_builder, exe, capability[0], capability[1]);
        const install = b.addInstallFile(
            bytecode,
            b.fmt("bin/cottontail-stdlib/{s}/main.jsc", .{capability[0]}),
        );
        install_exe.step.dependOn(&install.step);
    }
    if (target.result.os.tag == .linux) {
        // Zig 0.16 accepts the ELF version script above but its built-in linker
        // does not apply it. Restrict every installed Linux executable, including
        // debug builds: an unrestricted -rdynamic would expose stock JSC symbols
        // and allow WebKitGTK to bind to Cottontail's incompatible embedded JSC.
        const restrict_exports = b.addSystemCommand(&.{"node"});
        restrict_exports.addFileArg(b.path("scripts/restrict-linux-release-exports.js"));
        restrict_exports.addArg(b.getInstallPath(.bin, exe.out_filename));
        restrict_exports.addFileArg(b.path("src/compiler/src/symbols.dyn"));
        restrict_exports.step.dependOn(&install_exe.step);
        b.getInstallStep().dependOn(&restrict_exports.step);
    } else {
        b.getInstallStep().dependOn(&install_exe.step);
    }

    const run_cmd = b.addRunArtifact(exe);
    run_cmd.step.dependOn(b.getInstallStep());
    if (b.args) |args| {
        run_cmd.addArgs(args);
    }

    const run_step = b.step("run", "Build and run cottontail");
    run_step.dependOn(&run_cmd.step);

    const native_plugin_fixture_module = b.createModule(.{
        .target = target,
        .optimize = optimize,
        .link_libc = true,
        .pic = true,
    });
    native_plugin_fixture_module.addIncludePath(b.path("src/compiler/src/napi"));
    native_plugin_fixture_module.addCSourceFile(.{
        .file = b.path("tests/js/fixtures/native-bundler-plugin.c"),
        .flags = &.{"-std=c11"},
    });
    const native_plugin_fixture = b.addLibrary(.{
        .name = "native-bundler-plugin",
        .linkage = .dynamic,
        .root_module = native_plugin_fixture_module,
    });
    native_plugin_fixture.linker_allow_shlib_undefined = true;
    const install_native_plugin_fixture = b.addInstallFile(
        native_plugin_fixture.getEmittedBin(),
        "lib/native-bundler-plugin.node",
    );
    const build_native_plugin_step = b.step(
        "build-native-plugin",
        "Build the native Bun plugin integration fixture",
    );
    build_native_plugin_step.dependOn(&install_native_plugin_fixture.step);

    const run_native_plugin_test = if (target.result.os.tag == .linux and optimize == .ReleaseSmall)
        b.addSystemCommand(&.{b.getInstallPath(.bin, exe.out_filename)})
    else
        b.addRunArtifact(exe);
    if (target.result.os.tag == .linux and optimize == .ReleaseSmall) {
        run_native_plugin_test.step.dependOn(b.getInstallStep());
    }
    run_native_plugin_test.step.dependOn(&install_native_plugin_fixture.step);
    run_native_plugin_test.addArg("run");
    run_native_plugin_test.addFileArg(b.path("tests/js/bun-native-plugin.ts"));
    run_native_plugin_test.addArg(b.getInstallPath(.prefix, "lib/native-bundler-plugin.node"));
    const native_plugin_test_step = b.step("test-native-plugin", "Run the native Bun plugin integration test");
    native_plugin_test_step.dependOn(&run_native_plugin_test.step);

    // Linking vendored JSC, ICU, SQLite, and libuv into a Debug test
    // executable exceeds the Linux CI runner's memory limit. ReleaseSafe keeps
    // runtime safety checks without the Debug link's memory-heavy metadata.
    const test_optimize: std.builtin.OptimizeMode = if (optimize == .Debug) .ReleaseSafe else optimize;
    const unit_tests = b.addTest(.{
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = target,
            .optimize = test_optimize,
        }),
        .filters = test_filters,
    });
    unit_tests.root_module.addImport("cottontail_compiler", createCompilerModule(b, target, test_optimize));
    unit_tests.root_module.addAnonymousImport("runtime_modules_blob", .{ .root_source_file = runtime_modules_blob });
    unit_tests.root_module.addAnonymousImport("capability_namespace_source", .{ .root_source_file = b.path("src/capability_namespace_bootstrap.js") });

    configureJsc(unit_tests, b);

    const run_unit_tests = b.addRunArtifact(unit_tests);
    const test_step = b.step("test", "Run unit tests");
    test_step.dependOn(&run_unit_tests.step);

    const upstream_command_adapter_tests = b.addTest(.{
        .root_module = b.createModule(.{
            .root_source_file = b.path("tests/upstream-command-adapter.zig"),
            .target = target,
            .optimize = .ReleaseSafe,
        }),
    });
    test_step.dependOn(&b.addRunArtifact(upstream_command_adapter_tests).step);

    if (target.result.os.tag == .windows) {
        const windows_console_test = b.addExecutable(.{
            .name = "windows-unicode-console-test",
            .root_module = b.createModule(.{
                .root_source_file = b.path("tests/windows-unicode-console.zig"),
                .target = target,
                .optimize = .ReleaseSafe,
            }),
        });
        const run_windows_console_test = b.addRunArtifact(windows_console_test);
        run_windows_console_test.addArg(b.getInstallPath(.bin, "cottontail.exe"));
        run_windows_console_test.step.dependOn(b.getInstallStep());
        const windows_console_test_step = b.step(
            "test-windows-console",
            "Test Unicode output in a legacy Windows console",
        );
        windows_console_test_step.dependOn(&run_windows_console_test.step);
    }
}
