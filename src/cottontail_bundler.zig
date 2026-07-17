const std = @import("std");
const compiler = @import("cottontail_compiler");
const embedded_runtime_modules = @import("embedded_runtime_modules.zig");

const c_allocator = std.heap.c_allocator;

pub const binary_diagnostic_prefix = "COTTONTAIL_DIAGNOSTIC_BASE64:";

pub const RuntimeAlias = compiler.resolver.Resolver.RuntimeAlias;

pub const BundleOptions = struct {
    aliases: []const RuntimeAlias = &.{},
    conditions: []const []const u8 = &.{},
    tsconfig_override: ?[]const u8 = null,
    source_map: compiler.schema.api.SourceMapMode = .none,
    output_format: compiler.options.Format = .esm,
    target: compiler.schema.api.Target = .bun,
    banner: []const u8 = "",
    footer: []const u8 = "",
    drop: []const []const u8 = &.{},
    features: []const []const u8 = &.{},
    public_path: []const u8 = "",
    transform_only: bool = false,
    env_behavior: compiler.schema.api.DotEnvBehavior = .disable,
    env_prefix: []const u8 = "",
    bytecode: bool = false,
    loader: ?[]const u8 = null,
    loader_extensions: []const []const u8 = &.{},
    loader_values: []const compiler.schema.api.Loader = &.{},
    external_packages: bool = false,
    include_runtime_modules: bool = false,
    runtime_file_loader_paths: bool = false,
    /// Runtime bundles execute with a global Node-style `require`. Keeping the
    /// original identifier makes Function.prototype.toString() output usable
    /// with `new Function("require", ...)`, matching Bun's module transpiler.
    preserve_external_require_name: bool = false,
    inline_import_meta_properties: bool = false,
    minify_whitespace: bool = false,
    minify_identifiers: bool = false,
    minify_syntax: bool = false,
    keep_names: bool = false,
    no_macros: bool = false,
    ignore_dce_annotations: bool = false,
    emit_dce_annotations: ?bool = null,
    production: bool = false,
    /// Compile-time defines (parallel key/value arrays), e.g. mapping
    /// `import.meta.url` to a runtime identifier for dynamic-import target
    /// factories where the true URL (including `?query` suffixes) is only
    /// known at runtime.
    define_keys: []const []const u8 = &.{},
    define_values: []const []const u8 = &.{},
    /// `Bun.build({ reactFastRefresh: true })`: annotate JSX components with
    /// $RefreshReg$/$RefreshSig$ registration calls.
    react_fast_refresh: bool = false,
    jsx_factory: ?[]const u8 = null,
    jsx_fragment: ?[]const u8 = null,
    jsx_runtime: ?compiler.schema.api.JsxRuntime = null,
    jsx_import_source: ?[]const u8 = null,
    jsx_development: ?bool = null,
    jsx_side_effects: ?bool = null,
    metafile: bool = false,
    metafile_json_path: []const u8 = "",
    metafile_markdown_path: []const u8 = "",
    code_splitting: bool = false,
    /// `Bun.build({ external: [...] })`: import specifiers left unresolved.
    external: []const []const u8 = &.{},
    allow_unresolved: ?[]const []const u8 = null,
    /// Package names whose pure barrel modules should only load the exports
    /// requested by the importing graph.
    optimize_imports: []const []const u8 = &.{},
    /// `Bun.build({ naming: ... })` templates (Bun's defaults when unset).
    entry_naming: []const u8 = "[dir]/[name].[ext]",
    chunk_naming: []const u8 = "./chunk-[hash].[ext]",
    asset_naming: []const u8 = "./[name]-[hash].[ext]",
    /// One-shot startup bundles (`cottontail run`) skip the bundle teardown:
    /// the process immediately evaluates the result and user-visible startup
    /// latency matters more than reclaiming a single bundle's memory.
    /// Repeated in-process bundles (Bun.build) always tear down.
    skip_teardown: bool = false,
};

/// Process-wide worker pool shared by every bundle. Passing an external pool
/// into BundleV2 keeps the (thread-owning) ThreadPool out of the per-bundle
/// arena, which is what makes freeing that arena after each bundle safe.
var shared_worker_pool: ?*compiler.ThreadPool = null;

/// Dev-only (`COTTONTAIL_RUNTIME_MODULES_DIR`): populate the runtime module
/// file map from a directory on disk instead of the embedded blob so that
/// runtime module edits can be tested without rebuilding the binary.
fn loadRuntimeModulesFromDisk(
    dir_path: []const u8,
    working_dir: []const u8,
    runtime_file_map: *compiler.jsc.API.JSBundler.FileMap,
    runtime_file_keys: *std.ArrayList([]u8),
) !void {
    const io = std.Io.Threaded.global_single_threaded.io();
    var dir = try std.Io.Dir.cwd().openDir(io, dir_path, .{ .iterate = true });
    defer dir.close(io);
    var walker = try dir.walk(c_allocator);
    defer walker.deinit();
    var loaded_any = false;
    while (try walker.next(io)) |entry| {
        if (entry.kind != .file) continue;
        // Contents intentionally leak (dev path only): the bundle borrows the
        // slices for its lifetime, matching the embedded blob's static data.
        const contents = try dir.readFileAlloc(io, entry.path, c_allocator, .unlimited);
        const relative = try c_allocator.dupe(u8, entry.path);
        defer c_allocator.free(relative);
        if (std.fs.path.sep != '/') {
            for (relative) |*byte| {
                if (byte.* == std.fs.path.sep) byte.* = '/';
            }
        }
        const path = try embedded_runtime_modules.virtualPath(c_allocator, working_dir, relative);
        try runtime_file_keys.append(c_allocator, path);
        try runtime_file_map.map.put(c_allocator, path, contents);
        loaded_any = true;
    }
    if (!loaded_any) return error.EmptyRuntimeModulesDirectory;
}

fn sharedWorkerPool() ?*compiler.ThreadPool {
    if (shared_worker_pool) |pool| return pool;
    const pool = c_allocator.create(compiler.ThreadPool) catch return null;
    pool.* = .init(.{ .max_threads = compiler.getThreadCount() });
    shared_worker_pool = pool;
    return pool;
}

fn setError(error_out: *?[*:0]u8, comptime fmt: []const u8, args: anytype) void {
    const message = std.fmt.allocPrintSentinel(c_allocator, fmt, args, 0) catch {
        error_out.* = null;
        return;
    };
    if (std.mem.indexOfScalar(u8, message, 0) != null) {
        const encoder = std.base64.standard.Encoder;
        const encoded_len = encoder.calcSize(message.len);
        const wire = c_allocator.alloc(u8, binary_diagnostic_prefix.len + encoded_len + 1) catch {
            c_allocator.free(message);
            error_out.* = null;
            return;
        };
        @memcpy(wire[0..binary_diagnostic_prefix.len], binary_diagnostic_prefix);
        _ = encoder.encode(wire[binary_diagnostic_prefix.len .. binary_diagnostic_prefix.len + encoded_len], message);
        wire[wire.len - 1] = 0;
        c_allocator.free(message);
        error_out.* = @ptrCast(wire.ptr);
        return;
    }
    error_out.* = message.ptr;
}

fn setBuildError(error_out: *?[*:0]u8, log: *const compiler.logger.Log, fallback: anyerror) void {
    for (log.msgs.items) |message| {
        if (message.kind == .err) {
            if (message.data.location) |location| {
                // Bun's CLI diagnostics lead with the error text and put the
                // source location on the following line. Keep this C bridge
                // message-first too; callers add the leading "error: ".
                setError(error_out, "{s}\n    at {s}:{}:{}", .{
                    message.data.text,
                    location.file,
                    location.line,
                    location.column,
                });
            } else {
                setError(error_out, "{s}", .{message.data.text});
            }
            return;
        }
    }
    setError(error_out, "JavaScript bundle failed: {s}", .{@errorName(fallback)});
}

pub const EntryPointOutput = struct {
    code: []u8,
    source_map: ?[]u8 = null,
};

pub const GraphOutputKind = enum {
    @"entry-point",
    chunk,
    asset,
};

pub const GraphOutputSide = enum {
    server,
    client,
};

/// An external source map associated with one emitted graph file. Both fields
/// are owned by this value until `takeContents` transfers the map bytes.
pub const GraphSourceMap = struct {
    path: []u8,
    contents: []u8,
    owns_contents: bool = true,

    pub fn takeContents(this: *GraphSourceMap) []u8 {
        this.owns_contents = false;
        return this.contents;
    }

    pub fn deinit(this: *GraphSourceMap) void {
        c_allocator.free(this.path);
        if (this.owns_contents) c_allocator.free(this.contents);
    }
};

/// A standalone-relevant BundleV2 output. Paths are the stable generated
/// paths after Bun's naming templates have been applied. Source maps are
/// attached to their owning output instead of being exposed as unrelated
/// output-list entries.
pub const GraphOutputFile = struct {
    path: []u8,
    source_path: []u8,
    contents: []u8,
    kind: GraphOutputKind,
    loader: compiler.options.Loader,
    input_loader: compiler.options.Loader,
    side: ?GraphOutputSide,
    entry_point_index: ?u32,
    hash: u64,
    is_executable: bool,
    source_map: ?GraphSourceMap = null,
    owns_contents: bool = true,

    pub fn takeContents(this: *GraphOutputFile) []u8 {
        this.owns_contents = false;
        return this.contents;
    }

    pub fn takeSourceMapContents(this: *GraphOutputFile) ?[]u8 {
        if (this.source_map) |*source_map| return source_map.takeContents();
        return null;
    }

    pub fn deinit(this: *GraphOutputFile) void {
        c_allocator.free(this.path);
        c_allocator.free(this.source_path);
        if (this.owns_contents) c_allocator.free(this.contents);
        if (this.source_map) |*source_map| source_map.deinit();
    }
};

/// An owned compiler output graph. `entry_point_file_index` prefers Bun's
/// server-side entry point when a build contains both server and client sides.
pub const BundleGraphOutput = struct {
    files: []GraphOutputFile,
    entry_point_file_index: ?usize,

    pub fn entryPoint(this: *BundleGraphOutput) ?*GraphOutputFile {
        const index = this.entry_point_file_index orelse return null;
        return &this.files[index];
    }

    pub fn deinit(this: *BundleGraphOutput) void {
        for (this.files) |*file| file.deinit();
        c_allocator.free(this.files);
    }
};

fn graphOutputKind(kind: compiler.jsc.API.BuildArtifact.OutputKind) ?GraphOutputKind {
    return switch (kind) {
        .@"entry-point" => .@"entry-point",
        .chunk => .chunk,
        .asset => .asset,
        else => null,
    };
}

fn cloneGraphSourceMap(output_file: *const compiler.options.OutputFile) !GraphSourceMap {
    if (output_file.output_kind != .sourcemap or output_file.value != .buffer) {
        return error.InvalidBundleSourceMap;
    }

    const path = try c_allocator.dupe(u8, output_file.dest_path);
    errdefer c_allocator.free(path);
    const contents = try c_allocator.dupe(u8, output_file.value.buffer.bytes);
    errdefer c_allocator.free(contents);
    return .{ .path = path, .contents = contents };
}

const generated_esm_initializer = "(fn, res) => () => (fn && (res = fn(fn = 0)), res)";
const cottontail_esm_initializer = "(fn, res) => () => { if (!fn) return res; const init = fn; fn = 0; res = Promise.resolve(); try { return res = init(); } catch (error) { res = void 0; throw error; } }";

const GeneratedReplacement = struct {
    start: usize,
    end: usize,
    text: []const u8,
};

fn generatedIdentifierEnd(source: []const u8, start: usize) usize {
    var end = start;
    while (end < source.len and (std.ascii.isAlphanumeric(source[end]) or source[end] == '_' or source[end] == '$')) : (end += 1) {}
    return end;
}

fn skipGeneratedQuoted(source: []const u8, start: usize) usize {
    const quote = source[start];
    var cursor = start + 1;
    while (cursor < source.len) : (cursor += 1) {
        if (source[cursor] == '\\') {
            cursor += 1;
        } else if (source[cursor] == quote) {
            return cursor + 1;
        }
    }
    return source.len;
}

fn decodeGeneratedString(allocator: std.mem.Allocator, literal: []const u8) !?[]const u8 {
    if (literal.len < 2 or (literal[0] != '\'' and literal[0] != '"') or literal[literal.len - 1] != literal[0]) return null;
    var output: std.ArrayList(u8) = .empty;
    var cursor: usize = 1;
    while (cursor + 1 < literal.len) : (cursor += 1) {
        if (literal[cursor] != '\\') {
            try output.append(allocator, literal[cursor]);
            continue;
        }
        cursor += 1;
        if (cursor + 1 >= literal.len) return null;
        try output.append(allocator, switch (literal[cursor]) {
            'n' => '\n',
            'r' => '\r',
            't' => '\t',
            'b' => 0x08,
            'f' => 0x0c,
            'v' => 0x0b,
            '0' => 0,
            else => literal[cursor],
        });
    }
    return try output.toOwnedSlice(allocator);
}

fn realGeneratedSourcePath(
    allocator: std.mem.Allocator,
    working_dir: []const u8,
    source_path: []const u8,
) ?[]const u8 {
    const candidate = if (std.fs.path.isAbsolute(source_path))
        allocator.dupe(u8, source_path) catch return null
    else
        std.fs.path.join(allocator, &.{ working_dir, source_path }) catch return null;
    const io = std.Io.Threaded.global_single_threaded.io();
    return std.Io.Dir.cwd().realPathFileAlloc(io, candidate, allocator) catch null;
}

fn generatedSourcePathBefore(
    allocator: std.mem.Allocator,
    contents: []const u8,
    before: usize,
    working_dir: []const u8,
) ?[]const u8 {
    var search_end = before;
    while (search_end > 0) {
        const marker = std.mem.lastIndexOf(u8, contents[0..search_end], "\n// ") orelse return null;
        const path_start = marker + "\n// ".len;
        const path_end = std.mem.indexOfScalarPos(u8, contents, path_start, '\n') orelse contents.len;
        const source_path = std.mem.trim(u8, contents[path_start..path_end], " \t\r");
        if (source_path.len > 0) {
            if (realGeneratedSourcePath(allocator, working_dir, source_path)) |path| return path;
        }
        search_end = marker;
    }
    return null;
}

fn resolveGeneratedModuleSpecifier(
    allocator: std.mem.Allocator,
    source_path: []const u8,
    specifier: []const u8,
) ?[]const u8 {
    const marker = std.mem.indexOfAny(u8, specifier, "?#") orelse specifier.len;
    var bare = specifier[0..marker];
    if (compiler.resolver.FileURL.isFileURL(bare)) {
        bare = compiler.resolver.FileURL.pathFromURLAlloc(allocator, bare) catch return null;
    }
    const source_dir = std.fs.path.dirname(source_path) orelse return null;
    const candidate = if (std.fs.path.isAbsolute(bare))
        allocator.dupe(u8, bare) catch return null
    else if (std.mem.startsWith(u8, bare, "./") or std.mem.startsWith(u8, bare, "../"))
        std.fs.path.join(allocator, &.{ source_dir, bare }) catch return null
    else
        return null;
    const io = std.Io.Threaded.global_single_threaded.io();
    if (std.Io.Dir.cwd().realPathFileAlloc(io, candidate, allocator)) |path| return path else |_| {}
    if (std.fs.path.extension(candidate).len == 0) {
        for ([_][]const u8{ ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs" }) |extension| {
            const with_extension = std.mem.concat(allocator, u8, &.{ candidate, extension }) catch return null;
            if (std.Io.Dir.cwd().realPathFileAlloc(io, with_extension, allocator)) |path| return path else |_| {}
        }
    }
    return null;
}

fn appendGeneratedSelfRequires(
    allocator: std.mem.Allocator,
    replacements: *std.ArrayList(GeneratedReplacement),
    contents: []const u8,
    body_start: usize,
    body_end: usize,
    source_path: []const u8,
    exports_name: []const u8,
    has_to_common_js: bool,
) !void {
    var cursor = body_start;
    while (cursor < body_end) {
        if (contents[cursor] == '\'' or contents[cursor] == '"' or contents[cursor] == '`') {
            cursor = skipGeneratedQuoted(contents, cursor);
            continue;
        }
        if (contents[cursor] == '/' and cursor + 1 < body_end) {
            if (contents[cursor + 1] == '/') {
                cursor = std.mem.indexOfScalarPos(u8, contents, cursor + 2, '\n') orelse body_end;
                continue;
            }
            if (contents[cursor + 1] == '*') {
                const comment_end = std.mem.indexOfPos(u8, contents, cursor + 2, "*/") orelse {
                    cursor = body_end;
                    continue;
                };
                cursor = comment_end + 2;
                continue;
            }
        }
        if (!std.mem.startsWith(u8, contents[cursor..body_end], "require") or
            (cursor > body_start and (std.ascii.isAlphanumeric(contents[cursor - 1]) or contents[cursor - 1] == '_' or contents[cursor - 1] == '$' or contents[cursor - 1] == '.')))
        {
            cursor += 1;
            continue;
        }
        var open = cursor + "require".len;
        while (open < body_end and std.ascii.isWhitespace(contents[open])) : (open += 1) {}
        if (open >= body_end or contents[open] != '(') {
            cursor += "require".len;
            continue;
        }
        var literal_start = open + 1;
        while (literal_start < body_end and std.ascii.isWhitespace(contents[literal_start])) : (literal_start += 1) {}
        if (literal_start >= body_end or (contents[literal_start] != '\'' and contents[literal_start] != '"')) {
            cursor = open + 1;
            continue;
        }
        const literal_end = skipGeneratedQuoted(contents, literal_start);
        if (literal_end > body_end) break;
        var close = literal_end;
        while (close < body_end and std.ascii.isWhitespace(contents[close])) : (close += 1) {}
        if (close >= body_end or contents[close] != ')') {
            cursor = literal_end;
            continue;
        }
        const specifier = (try decodeGeneratedString(allocator, contents[literal_start..literal_end])) orelse {
            cursor = close + 1;
            continue;
        };
        const resolved = resolveGeneratedModuleSpecifier(allocator, source_path, specifier) orelse {
            cursor = close + 1;
            continue;
        };
        if (std.mem.eql(u8, resolved, source_path)) {
            const replacement = if (has_to_common_js)
                try std.fmt.allocPrint(allocator, "({s}.__esModule = true, __toCommonJS({s}))", .{ exports_name, exports_name })
            else
                try std.fmt.allocPrint(allocator, "({s}.__esModule = true, {s})", .{ exports_name, exports_name });
            try replacements.append(allocator, .{ .start = cursor, .end = close + 1, .text = replacement });
        }
        cursor = close + 1;
    }
}

fn patchGeneratedSelfImports(contents: []const u8, working_dir: []const u8) !?[]u8 {
    var arena_state = std.heap.ArenaAllocator.init(c_allocator);
    defer arena_state.deinit();
    const allocator = arena_state.allocator();
    var replacements: std.ArrayList(GeneratedReplacement) = .empty;
    const has_to_common_js = std.mem.indexOf(u8, contents, "var __toCommonJS =") != null;
    var search_from: usize = 0;
    while (std.mem.indexOfPos(u8, contents, search_from, "var init_")) |init_start| {
        const name_start = init_start + "var ".len;
        const name_end = generatedIdentifierEnd(contents, name_start);
        const init_name = contents[name_start..name_end];
        const assignment = std.mem.trimStart(u8, contents[name_end..], " \t");
        if (!std.mem.startsWith(u8, assignment, "= __esm(")) {
            search_from = name_end;
            continue;
        }
        const body_open = std.mem.indexOfScalarPos(u8, contents, name_end, '{') orelse break;
        const body_close = std.mem.indexOfPos(u8, contents, body_open + 1, "\n});") orelse break;
        const self_prefix = try std.fmt.allocPrint(allocator, "{s}().then(() => ", .{init_name});
        const self_call = std.mem.indexOfPos(u8, contents, body_open + 1, self_prefix) orelse {
            search_from = body_close + "\n});".len;
            continue;
        };
        if (self_call >= body_close) {
            search_from = body_close + "\n});".len;
            continue;
        }
        const exports_start = self_call + self_prefix.len;
        const exports_end = generatedIdentifierEnd(contents, exports_start);
        if (exports_end == exports_start or exports_end >= body_close or contents[exports_end] != ')') {
            search_from = body_close + "\n});".len;
            continue;
        }
        const exports_name = contents[exports_start..exports_end];
        const declaration = try std.fmt.allocPrint(allocator, "var {s} = {{}};", .{exports_name});
        const declaration_start = std.mem.lastIndexOf(u8, contents[0..init_start], declaration) orelse {
            search_from = body_close + "\n});".len;
            continue;
        };
        const replacement = try std.fmt.allocPrint(
            allocator,
            "var {s} = ((target, marker = false) => new Proxy(target, {{ get(target, key, receiver) {{ return key === \"__esModule\" && !Object.hasOwn(target, key) ? marker || void 0 : Reflect.get(target, key, receiver); }}, set(target, key, value, receiver) {{ if (key === \"__esModule\" && !Object.hasOwn(target, key)) {{ marker = value === true; return true; }} return Reflect.set(target, key, value, receiver); }} }}))({{}});",
            .{exports_name},
        );
        try replacements.append(allocator, .{
            .start = declaration_start,
            .end = declaration_start + declaration.len,
            .text = replacement,
        });
        if (generatedSourcePathBefore(allocator, contents, declaration_start, working_dir)) |source_path| {
            try appendGeneratedSelfRequires(
                allocator,
                &replacements,
                contents,
                body_open + 1,
                body_close,
                source_path,
                exports_name,
                has_to_common_js,
            );
        }
        search_from = body_close + "\n});".len;
    }
    if (replacements.items.len == 0) return null;
    std.mem.sort(GeneratedReplacement, replacements.items, {}, struct {
        fn lessThan(_: void, left: GeneratedReplacement, right: GeneratedReplacement) bool {
            return left.start < right.start;
        }
    }.lessThan);
    var output: std.ArrayList(u8) = .empty;
    errdefer output.deinit(c_allocator);
    var copied_until: usize = 0;
    for (replacements.items) |replacement| {
        if (replacement.start < copied_until) continue;
        try output.appendSlice(c_allocator, contents[copied_until..replacement.start]);
        try output.appendSlice(c_allocator, replacement.text);
        copied_until = replacement.end;
    }
    try output.appendSlice(c_allocator, contents[copied_until..]);
    return try output.toOwnedSlice(c_allocator);
}

fn cloneGeneratedJavaScript(contents: []const u8, working_dir: []const u8) ![]u8 {
    const generated = if (try patchGeneratedSelfImports(contents, working_dir)) |patched|
        patched
    else
        try c_allocator.dupe(u8, contents);
    if (std.mem.indexOf(u8, generated, generated_esm_initializer) == null) {
        return generated;
    }
    // A recursive dynamic self-import can enter an async ESM initializer
    // synchronously, before Bun's compact helper assigns its cached Promise.
    // Publish an already-resolved placeholder during that call so the linker-
    // generated namespace continuation can run, then cache the real result.
    const patched = try std.mem.replaceOwned(
        u8,
        c_allocator,
        generated,
        generated_esm_initializer,
        cottontail_esm_initializer,
    );
    c_allocator.free(generated);
    return patched;
}

fn cloneGraphOutputFile(
    output_file: *const compiler.options.OutputFile,
    output_files: []const compiler.options.OutputFile,
    working_dir: []const u8,
) !GraphOutputFile {
    const kind = graphOutputKind(output_file.output_kind) orelse return error.UnsupportedBundleOutputKind;
    if (output_file.value != .buffer) return error.UnsupportedBundleOutputStorage;

    const path = try c_allocator.dupe(u8, output_file.dest_path);
    errdefer c_allocator.free(path);
    const source_path = try c_allocator.dupe(u8, output_file.src_path.text);
    errdefer c_allocator.free(source_path);
    const contents = if (output_file.loader.isJavaScriptLike())
        try cloneGeneratedJavaScript(output_file.value.buffer.bytes, working_dir)
    else
        try c_allocator.dupe(u8, output_file.value.buffer.bytes);
    errdefer c_allocator.free(contents);

    var source_map: ?GraphSourceMap = null;
    errdefer if (source_map) |*map| map.deinit();
    if (output_file.source_map_index != std.math.maxInt(u32)) {
        if (output_file.source_map_index >= output_files.len) return error.InvalidBundleSourceMapIndex;
        source_map = try cloneGraphSourceMap(&output_files[output_file.source_map_index]);
    }

    return .{
        .path = path,
        .source_path = source_path,
        .contents = contents,
        .kind = kind,
        .loader = output_file.loader,
        .input_loader = output_file.input_loader,
        .side = if (output_file.side) |side| switch (side) {
            .server => .server,
            .client => .client,
        } else null,
        .entry_point_index = output_file.entry_point_index,
        .hash = output_file.hash,
        .is_executable = output_file.is_executable,
        .source_map = source_map,
    };
}

pub fn bundleEntryPointGraphWithOptions(
    entry_path: []const u8,
    working_dir: []const u8,
    options: BundleOptions,
    error_out: *?[*:0]u8,
) !BundleGraphOutput {
    // COTTONTAIL-COMPAT: Bun build bytecode - stock JSCOnly does not expose
    // cached-bytecode serialization. Reject it instead of emitting a fake
    // artifact or entering Bun's bytecode path with the compiler JSC stubs.
    if (options.bytecode) {
        setError(error_out, "Bun build bytecode requires a JavaScriptCore cached-bytecode API", .{});
        return error.UnsupportedBytecode;
    }
    const allocator = compiler.default_allocator;
    compiler.cli.start_time = compiler.nanoTimestamp();
    const working_dir_z = try allocator.dupeZ(u8, working_dir);
    defer allocator.free(working_dir_z);

    var transform_options = std.mem.zeroes(compiler.schema.api.TransformOptions);
    transform_options.absolute_working_dir = working_dir_z;
    transform_options.entry_points = &.{entry_path};
    transform_options.target = options.target;
    transform_options.write = false;
    transform_options.output_dir = "";
    transform_options.source_map = options.source_map;
    transform_options.conditions = options.conditions;
    transform_options.tsconfig_override = options.tsconfig_override;
    transform_options.packages = if (options.external_packages) .external else .bundle;
    transform_options.external = options.external;
    transform_options.drop = options.drop;
    transform_options.feature_flags = options.features;
    transform_options.disable_hmr = true;
    transform_options.main_fields = &.{ "main", "module" };
    if (options.jsx_factory != null or
        options.jsx_fragment != null or
        options.jsx_runtime != null or
        options.jsx_import_source != null or
        options.jsx_development != null or
        options.jsx_side_effects != null)
    {
        transform_options.jsx = .{
            .factory = options.jsx_factory orelse "",
            .runtime = options.jsx_runtime orelse .automatic,
            .fragment = options.jsx_fragment orelse "",
            .development = options.jsx_development orelse !options.production,
            .import_source = options.jsx_import_source orelse "",
            .side_effects = options.jsx_side_effects orelse false,
        };
    }
    if (options.define_keys.len > 0) {
        transform_options.define = .{
            .keys = options.define_keys,
            .values = options.define_values,
        };
    }

    var loader_extensions: [1][]const u8 = undefined;
    var loader_values: [1]compiler.schema.api.Loader = undefined;
    if (options.loader) |loader_name| {
        const loader = compiler.options.Loader.fromString(loader_name) orelse {
            setError(error_out, "Unsupported loader: {s}", .{loader_name});
            return error.InvalidLoader;
        };
        const extension = std.fs.path.extension(entry_path);
        // For extensionless entry points, register the loader under the empty
        // extension: `Path.loader` looks entries up by the file's actual
        // extension (`""` here), so mapping ".js" would never apply and the
        // file would fall back to the `file` loader (e.g. `import("./empty-file",
        // { with: { type: "js" } })`).
        loader_extensions[0] = extension;
        // NOTE: `options.Loader` and `api.Loader` have different integer
        // values (`jsx` is 0 in one and 1 in the other), so a raw
        // `@enumFromInt(@intFromEnum(...))` cast shifts every loader by one
        // ("jsx" became invalid, "js" became jsx, ...). Use the real mapping.
        loader_values[0] = loader.toAPI();
        transform_options.loaders = .{
            .extensions = &loader_extensions,
            .loaders = &loader_values,
        };
    }

    var log = compiler.logger.Log.init(allocator);
    var transpiler = compiler.Transpiler.init(allocator, &log, transform_options, null) catch |err| {
        setBuildError(error_out, &log, err);
        log.deinit();
        return err;
    };
    defer transpiler.deinitPreservingFileSystem();
    // Bun's run/build commands populate the compiler environment before
    // resolution. The resolver consumes NODE_PATH and condition-related env
    // values even when runtime process.env reads are intentionally not inlined.
    try transpiler.env.loadProcess();
    try transpiler.fs.setTopLevelDir(working_dir_z);
    transpiler.resolver.runtime_aliases = options.aliases;

    transpiler.options.output_format = options.output_format;
    transpiler.options.source_map = compiler.options.SourceMapOption.fromApi(options.source_map);
    transpiler.options.banner = options.banner;
    transpiler.options.footer = options.footer;
    transpiler.options.public_path = options.public_path;
    transpiler.options.transform_only = options.transform_only;
    transpiler.options.env.behavior = options.env_behavior;
    transpiler.options.env.prefix = options.env_prefix;
    transpiler.options.bytecode = options.bytecode;
    transpiler.options.inline_import_meta_properties = options.inline_import_meta_properties;
    transpiler.options.minify_whitespace = options.minify_whitespace;
    transpiler.options.minify_identifiers = options.minify_identifiers;
    transpiler.options.minify_syntax = options.minify_syntax;
    transpiler.options.no_macros = options.no_macros;
    transpiler.options.allow_unresolved = if (options.allow_unresolved) |patterns|
        compiler.options.AllowUnresolved.fromStrings(patterns)
    else
        .all;
    transpiler.options.ignore_dce_annotations = options.ignore_dce_annotations;
    transpiler.options.emit_dce_annotations = options.emit_dce_annotations orelse !options.minify_whitespace;
    // Runtime execution bundles modules into one linker scope. Preserve each
    // module's observable function/class names when the linker renames a
    // colliding binding, matching direct ESM/CJS evaluation semantics.
    transpiler.options.keep_names = options.keep_names or options.include_runtime_modules;
    transpiler.options.setProduction(options.production);
    if (options.production) try transpiler.env.map.put("NODE_ENV", "production");
    // Match Bun's build/standalone compiler output configuration. The output
    // graph owns every generated file, so code splitting and file-loader
    // assets are valid here instead of being rejected as stdout-only output.
    transpiler.options.root_dir = working_dir;
    transpiler.options.entry_naming = options.entry_naming;
    transpiler.options.chunk_naming = options.chunk_naming;
    transpiler.options.asset_naming = options.asset_naming;
    transpiler.options.code_splitting = options.code_splitting;
    transpiler.options.supports_multiple_outputs = true;
    // Runtime bundling (bun run / bun test emulation): require.resolve() of
    // asset files must stay a runtime call returning the on-disk path instead
    // of becoming an additional output file (which single-output in-memory
    // bundles cannot emit).
    transpiler.options.externalize_runtime_require_resolve = true;
    transpiler.options.runtime_file_loader_paths = options.runtime_file_loader_paths or options.include_runtime_modules;
    transpiler.options.preserve_external_require_name = options.preserve_external_require_name;
    // Cottontail's vendored JSC has no native `using` / `await using`
    // support; always lower them in bundles that run on this runtime.
    transpiler.options.force_lower_using = true;
    // Runtime bundles are evaluated as classic sloppy-mode scripts, so CJS
    // modules with an explicit "use strict" must keep the directive inside
    // their wrapper closures (including the entry point).
    transpiler.options.preserve_strict_directives_in_wrappers = true;
    // Runtime execution loads dotenv through process.js after CLI flags and
    // bunfig policy are available. Keep env values available to resolution,
    // but do not replace process.env reads in generated code before
    // --no-env-file / --env-file can take effect. This is the mode Bun uses
    // for its run and test transpilers.
    if (options.include_runtime_modules) {
        transpiler.options.env.behavior = .load_all_without_inlining;
    }
    // Linker configuration must run before defines: configureLinker() seeds
    // options.jsx wholesale from the root tsconfig (development=true for
    // "react-jsx"/"react-jsxdev"), and configureDefines() then applies the
    // NODE_ENV production/development override on top (matching upstream
    // bun's configureLinker -> configureDefines ordering).
    transpiler.configureLinker();
    if (options.jsx_factory) |factory| {
        transpiler.options.jsx.factory = try compiler.options.JSX.Pragma.memberListToComponentsIfDifferent(
            allocator,
            transpiler.options.jsx.factory,
            factory,
        );
    }
    if (options.jsx_fragment) |fragment| {
        transpiler.options.jsx.fragment = try compiler.options.JSX.Pragma.memberListToComponentsIfDifferent(
            allocator,
            transpiler.options.jsx.fragment,
            fragment,
        );
    }
    if (options.jsx_runtime) |runtime| transpiler.options.jsx.runtime = runtime;
    if (options.jsx_import_source) |import_source| {
        transpiler.options.jsx.package_name = import_source;
        transpiler.options.jsx.classic_import_source = import_source;
        transpiler.options.jsx.setImportSource(allocator);
    }
    if (options.jsx_development) |development| {
        transpiler.options.jsx.development = development;
        transpiler.options.force_node_env = .unspecified;
    }
    if (options.jsx_side_effects) |side_effects| transpiler.options.jsx.side_effects = side_effects;
    transpiler.configureDefines() catch |err| {
        setBuildError(error_out, &log, err);
        return err;
    };
    if (options.jsx_development) |development| {
        transpiler.options.jsx.development = development;
        transpiler.options.force_node_env = .unspecified;
    }
    if (!transpiler.options.production) {
        try transpiler.options.conditions.appendSlice(&.{"development"});
    }
    transpiler.resolver.opts = transpiler.options;
    transpiler.resolver.env_loader = transpiler.env;

    if (std.c.getenv("COTTONTAIL_DEBUG_JSX") != null) {
        std.debug.print("dbg jsx: production={} jsx.development={} behavior={s} env_prod={}\n", .{
            transpiler.options.production,
            transpiler.options.jsx.development,
            @tagName(transpiler.options.env.behavior),
            transpiler.env.isProduction(),
        });
    }

    var reachable_files_count: usize = 0;
    var minify_duration: u64 = 0;
    var source_code_size: u64 = 0;
    var runtime_file_map: compiler.jsc.API.JSBundler.FileMap = .{};
    var runtime_file_keys: std.ArrayList([]u8) = .empty;
    defer {
        runtime_file_map.map.deinit(c_allocator);
        for (runtime_file_keys.items) |key| c_allocator.free(key);
        runtime_file_keys.deinit(c_allocator);
    }
    if (options.include_runtime_modules) {
        // Dev override: load runtime modules from a directory on disk instead
        // of the embedded blob so module edits do not require a rebuild.
        var used_override = false;
        if (std.c.getenv("COTTONTAIL_RUNTIME_MODULES_DIR")) |dir_pointer| {
            const dir_path = std.mem.span(dir_pointer);
            if (dir_path.len > 0) {
                if (loadRuntimeModulesFromDisk(dir_path, working_dir, &runtime_file_map, &runtime_file_keys)) {
                    used_override = true;
                } else |_| {
                    // Fall back to the embedded blob on any error.
                }
            }
        }
        if (!used_override) {
            var iterator = try embedded_runtime_modules.Iterator.init();
            while (try iterator.next()) |entry| {
                const path = try embedded_runtime_modules.virtualPath(c_allocator, working_dir, entry.path);
                try runtime_file_keys.append(c_allocator, path);
                try runtime_file_map.map.put(c_allocator, path, entry.contents);
            }
        }
    }
    const runtime_file_map_ptr = if (runtime_file_map.map.count() > 0) &runtime_file_map else null;
    const event_loop = compiler.jsc.AnyEventLoop.init(allocator);
    const worker_pool = sharedWorkerPool();
    // BundleV2 temporarily retargets these allocators to its graph arena. The
    // arena is released before Transpiler.deinit(), so restore the allocators
    // that own long-lived option data (including bundler feature flags) after
    // BundleV2 teardown and before the transpiler defer runs.
    defer {
        transpiler.allocator = allocator;
        transpiler.resolver.allocator = allocator;
        transpiler.linker.allocator = allocator;
    }
    var bundle: ?*compiler.bundle_v2.BundleV2 = null;
    defer if (bundle) |value| {
        if (options.skip_teardown) {
            // One-shot startup bundle: leave everything for process exit.
        } else if (worker_pool != null) {
            value.deinitFromCLI(allocator);
        } else {
            value.deinitWithoutFreeingArena();
        }
    };
    // BundleV2.init points `log.msgs.allocator` at the bundle arena, so the
    // log must be abandoned (not freed) before the arena teardown above runs;
    // message texts consumed by callers are duped out beforehand.
    defer log.msgs = std.array_list.Managed(compiler.logger.Msg).init(allocator);
    var result = compiler.bundle_v2.BundleV2.generateFromCLIReleasable(
        &transpiler,
        allocator,
        event_loop,
        false,
        &reachable_files_count,
        &minify_duration,
        &source_code_size,
        null,
        runtime_file_map_ptr,
        &bundle,
        worker_pool,
    ) catch |err| {
        setBuildError(error_out, &log, err);
        return err;
    };
    defer result.deinit();

    var files: std.ArrayList(GraphOutputFile) = .empty;
    errdefer {
        for (files.items) |*file| file.deinit();
        files.deinit(c_allocator);
    }
    var first_entry_point: ?usize = null;
    var server_entry_point: ?usize = null;

    for (result.output_files.items) |*output_file| {
        const kind = graphOutputKind(output_file.output_kind) orelse continue;
        var file = cloneGraphOutputFile(output_file, result.output_files.items, working_dir) catch |err| {
            setError(error_out, "Invalid compiler graph output for {s}: {s}", .{
                output_file.dest_path,
                @errorName(err),
            });
            return err;
        };
        const file_index = files.items.len;
        files.append(c_allocator, file) catch |err| {
            file.deinit();
            return err;
        };

        if (kind == .@"entry-point") {
            if (first_entry_point == null) first_entry_point = file_index;
            if (server_entry_point == null and file.side != .client) {
                server_entry_point = file_index;
            }
        }
    }

    if (files.items.len == 0) {
        setError(error_out, "JavaScript bundle produced no standalone graph output", .{});
        return error.NoEntryPointOutput;
    }

    return .{
        .files = try files.toOwnedSlice(c_allocator),
        .entry_point_file_index = server_entry_point orelse first_entry_point,
    };
}

pub fn bundleEntryPointWithOptionsAndSourceMap(
    entry_path: []const u8,
    working_dir: []const u8,
    options: BundleOptions,
    error_out: *?[*:0]u8,
) !EntryPointOutput {
    var graph = try bundleEntryPointGraphWithOptions(entry_path, working_dir, options, error_out);
    defer graph.deinit();

    const entry_index = graph.entry_point_file_index orelse fallback: {
        // Preserve the old helper's last-resort behavior for compiler modes
        // that classify their only runnable output as a chunk.
        for (graph.files, 0..) |file, index| {
            if (file.kind == .chunk) break :fallback index;
        }
        setError(error_out, "JavaScript bundle produced no entry point", .{});
        return error.NoEntryPointOutput;
    };
    const entry = &graph.files[entry_index];
    return .{
        .code = entry.takeContents(),
        .source_map = entry.takeSourceMapContents(),
    };
}

pub fn bundleEntryPointWithOptions(
    entry_path: []const u8,
    working_dir: []const u8,
    options: BundleOptions,
    error_out: *?[*:0]u8,
) ![]u8 {
    const output = try bundleEntryPointWithOptionsAndSourceMap(entry_path, working_dir, options, error_out);
    if (output.source_map) |source_map| c_allocator.free(source_map);
    return output.code;
}

pub fn bundleEntryPoint(entry_path: []const u8, working_dir: []const u8, error_out: *?[*:0]u8) ![]u8 {
    return bundleEntryPointWithOptions(entry_path, working_dir, .{}, error_out);
}

pub export fn ct_bundle_entry_point(
    entry_ptr: ?[*]const u8,
    entry_len: usize,
    working_dir_ptr: ?[*]const u8,
    working_dir_len: usize,
    out_len: *usize,
    error_out: *?[*:0]u8,
) ?[*]u8 {
    out_len.* = 0;
    error_out.* = null;
    const entry_path = if (entry_ptr) |ptr| ptr[0..entry_len] else {
        setError(error_out, "entry point is required", .{});
        return null;
    };
    const working_dir = if (working_dir_ptr) |ptr| ptr[0..working_dir_len] else {
        setError(error_out, "working directory is required", .{});
        return null;
    };

    const output = bundleEntryPoint(entry_path, working_dir, error_out) catch return null;
    out_len.* = output.len;
    return output.ptr;
}

fn parseBuildOptions(options_json: []const u8, allocator: std.mem.Allocator) !BundleOptions {
    if (options_json.len == 0) return .{};
    const parsed = try std.json.parseFromSlice(std.json.Value, allocator, options_json, .{});
    if (parsed.value != .object) return error.InvalidOptions;
    const object = parsed.value.object;
    var options: BundleOptions = .{};

    if (object.get("format")) |value| {
        if (value == .string) {
            options.output_format = compiler.options.Format.fromString(value.string) orelse return error.InvalidFormat;
        }
    }
    if (object.get("target")) |value| {
        if (value == .string) {
            options.target = if (std.ascii.eqlIgnoreCase(value.string, "browser"))
                .browser
            else if (std.ascii.eqlIgnoreCase(value.string, "node"))
                .node
            else if (std.ascii.eqlIgnoreCase(value.string, "bun"))
                .bun
            else if (std.ascii.eqlIgnoreCase(value.string, "macro") or std.ascii.eqlIgnoreCase(value.string, "bun_macro"))
                .bun_macro
            else
                return error.InvalidTarget;
        }
    }
    if (object.get("banner")) |value| {
        if (value == .string) options.banner = value.string;
    }
    if (object.get("footer")) |value| {
        if (value == .string) options.footer = value.string;
    }
    if (object.get("drop")) |value| {
        if (value == .array) {
            var drop: std.ArrayList([]const u8) = .empty;
            for (value.array.items) |item| {
                if (item == .string) try drop.append(allocator, item.string);
            }
            options.drop = drop.items;
        }
    }
    if (object.get("features")) |value| {
        if (value == .array) {
            var features: std.ArrayList([]const u8) = .empty;
            for (value.array.items) |item| {
                if (item == .string) try features.append(allocator, item.string);
            }
            options.features = features.items;
        }
    }
    if (object.get("publicPath")) |value| {
        if (value == .string) options.public_path = value.string;
    }
    if (object.get("bundle")) |value| {
        if (value == .bool) options.transform_only = !value.bool;
    }
    if (object.get("env")) |value| switch (value) {
        .null => {},
        .bool => |enabled| options.env_behavior = if (enabled) .load_all else .disable,
        .integer => |number| options.env_behavior = if (number == 1)
            .load_all
        else if (number == 0)
            .disable
        else
            return error.InvalidEnvironment,
        .float => |number| options.env_behavior = if (number == 1)
            .load_all
        else if (number == 0)
            .disable
        else
            return error.InvalidEnvironment,
        .string => |env| {
            if (std.mem.eql(u8, env, "inline")) {
                options.env_behavior = .load_all;
            } else if (std.mem.eql(u8, env, "disable")) {
                options.env_behavior = .disable;
            } else if (std.mem.indexOfScalar(u8, env, '*')) |asterisk| {
                options.env_behavior = if (asterisk == 0) .load_all else .prefix;
                options.env_prefix = env[0..asterisk];
            } else {
                return error.InvalidEnvironment;
            }
        },
        else => return error.InvalidEnvironment,
    };
    if (object.get("bytecode")) |value| {
        if (value == .bool) options.bytecode = value.bool;
    }
    if (object.get("macros")) |value| {
        if (value == .bool) options.no_macros = !value.bool;
    }
    if (object.get("loader")) |value| switch (value) {
        .string => |loader_name| options.loader = loader_name,
        .object => |loader_map| {
            var extensions: std.ArrayList([]const u8) = .empty;
            var loaders: std.ArrayList(compiler.schema.api.Loader) = .empty;
            var iterator = loader_map.iterator();
            while (iterator.next()) |entry| {
                if (entry.value_ptr.* != .string) continue;
                if (!std.mem.startsWith(u8, entry.key_ptr.*, ".") or entry.key_ptr.len < 2) {
                    return error.InvalidLoaderExtension;
                }
                const loader = compiler.options.Loader.fromString(entry.value_ptr.string) orelse return error.InvalidLoader;
                try extensions.append(allocator, entry.key_ptr.*);
                try loaders.append(allocator, loader.toAPI());
            }
            options.loader_extensions = extensions.items;
            options.loader_values = loaders.items;
        },
        else => {},
    };
    if (object.get("sourcemap")) |value| switch (value) {
        .bool => |enabled| options.source_map = if (!enabled)
            .none
        else if (object.get("outdir") != null)
            .linked
        else
            .@"inline",
        .string => |mode| options.source_map = if (std.ascii.eqlIgnoreCase(mode, "inline"))
            .@"inline"
        else if (std.ascii.eqlIgnoreCase(mode, "external"))
            .external
        else if (std.ascii.eqlIgnoreCase(mode, "linked"))
            .linked
        else
            .none,
        else => {},
    };
    if (object.get("packages")) |value| {
        if (value == .string) {
            options.external_packages = std.ascii.eqlIgnoreCase(value.string, "external");
        }
    }
    if (object.get("conditions")) |value| {
        if (value == .string) {
            options.conditions = try allocator.dupe([]const u8, &.{value.string});
        } else if (value == .array) {
            var conditions: std.ArrayList([]const u8) = .empty;
            for (value.array.items) |item| {
                if (item != .string) return error.InvalidConditions;
                try conditions.append(allocator, item.string);
            }
            options.conditions = conditions.items;
        } else {
            return error.InvalidConditions;
        }
    }
    if (object.get("minify")) |value| switch (value) {
        .bool => |enabled| {
            options.minify_whitespace = enabled;
            options.minify_identifiers = enabled;
            options.minify_syntax = enabled;
        },
        .object => |minify| {
            if (minify.get("whitespace")) |item| {
                if (item == .bool) options.minify_whitespace = item.bool;
            }
            if (minify.get("identifiers")) |item| {
                if (item == .bool) options.minify_identifiers = item.bool;
            }
            if (minify.get("syntax")) |item| {
                if (item == .bool) options.minify_syntax = item.bool;
            }
            if (minify.get("keepNames")) |item| {
                if (item == .bool) options.keep_names = item.bool;
            }
        },
        else => {},
    };
    if (object.get("ignoreDCEAnnotations")) |value| {
        if (value == .bool) options.ignore_dce_annotations = value.bool;
    }
    if (object.get("emitDCEAnnotations")) |value| {
        if (value == .bool) options.emit_dce_annotations = value.bool;
    }
    if (object.get("production")) |value| {
        if (value == .bool) options.production = value.bool;
    } else if (std.c.getenv("NODE_ENV")) |node_env| {
        options.production = std.ascii.eqlIgnoreCase(std.mem.span(node_env), "production");
    }
    if (object.get("reactFastRefresh")) |value| {
        if (value == .bool) options.react_fast_refresh = value.bool;
    }
    if (object.get("jsx")) |value| {
        if (value == .object) {
            if (value.object.get("factory")) |item| {
                if (item == .string) options.jsx_factory = item.string;
            }
            if (value.object.get("fragment")) |item| {
                if (item == .string) options.jsx_fragment = item.string;
            }
            if (value.object.get("runtime")) |item| {
                if (item == .string) {
                    options.jsx_runtime = if (std.ascii.eqlIgnoreCase(item.string, "classic"))
                        .classic
                    else if (std.ascii.eqlIgnoreCase(item.string, "automatic"))
                        .automatic
                    else
                        return error.InvalidJSXRuntime;
                }
            }
            if (value.object.get("importSource")) |item| {
                if (item == .string) options.jsx_import_source = item.string;
            }
            if (value.object.get("development")) |item| {
                if (item == .bool) options.jsx_development = item.bool;
            }
            if (value.object.get("sideEffects")) |item| {
                if (item == .bool) options.jsx_side_effects = item.bool;
            }
        }
    }
    if (object.get("metafile")) |value| switch (value) {
        .bool => |enabled| options.metafile = enabled,
        .string => |path| {
            options.metafile = true;
            options.metafile_json_path = path;
        },
        .object => |metafile| {
            options.metafile = true;
            if (metafile.get("json")) |item| {
                if (item == .string) options.metafile_json_path = item.string;
            }
            if (metafile.get("markdown")) |item| {
                if (item == .string) options.metafile_markdown_path = item.string;
            }
        },
        else => {},
    };
    if (object.get("splitting")) |value| {
        if (value == .bool) options.code_splitting = value.bool;
    }
    if (object.get("includeRuntimeModules")) |value| {
        if (value == .bool) options.include_runtime_modules = value.bool;
    }
    if (object.get("runtimeFileLoaderPaths")) |value| {
        if (value == .bool) options.runtime_file_loader_paths = value.bool;
    }
    if (object.get("inlineImportMetaProperties")) |value| {
        if (value == .bool) options.inline_import_meta_properties = value.bool;
    }
    if (object.get("external")) |value| {
        if (value == .array) {
            var external: std.ArrayList([]const u8) = .empty;
            for (value.array.items) |item| {
                if (item == .string) try external.append(allocator, item.string);
            }
            options.external = external.items;
        }
    }
    if (object.get("allowUnresolved")) |value| {
        if (value == .null) {
            options.allow_unresolved = null;
        } else if (value == .array) {
            var patterns: std.ArrayList([]const u8) = .empty;
            for (value.array.items) |item| {
                if (item != .string) return error.InvalidAllowUnresolved;
                try patterns.append(allocator, item.string);
            }
            options.allow_unresolved = patterns.items;
        } else {
            return error.InvalidAllowUnresolved;
        }
    }
    if (object.get("optimizeImports")) |value| {
        if (value == .array) {
            var optimize_imports: std.ArrayList([]const u8) = .empty;
            for (value.array.items) |item| {
                if (item == .string) try optimize_imports.append(allocator, item.string);
            }
            options.optimize_imports = optimize_imports.items;
        }
    }
    if (object.get("define")) |value| {
        if (value == .object) {
            var keys: std.ArrayList([]const u8) = .empty;
            var values: std.ArrayList([]const u8) = .empty;
            var iterator = value.object.iterator();
            while (iterator.next()) |entry| {
                if (entry.value_ptr.* != .string) continue;
                try keys.append(allocator, entry.key_ptr.*);
                try values.append(allocator, entry.value_ptr.string);
            }
            options.define_keys = keys.items;
            options.define_values = values.items;
        }
    }
    if (object.get("naming")) |value| switch (value) {
        .string => |template| options.entry_naming = try namingTemplate(allocator, template),
        .object => |naming| {
            if (naming.get("entry")) |item| {
                if (item == .string) options.entry_naming = try namingTemplate(allocator, item.string);
            }
            if (naming.get("chunk")) |item| {
                if (item == .string) options.chunk_naming = try namingTemplate(allocator, item.string);
            }
            if (naming.get("asset")) |item| {
                if (item == .string) options.asset_naming = try namingTemplate(allocator, item.string);
            }
        },
        else => {},
    };
    return options;
}

/// Bun's JS API prefixes relative naming templates with "./" (see
/// JSBundler.Config: owned_entry_point building).
fn namingTemplate(allocator: std.mem.Allocator, template: []const u8) ![]const u8 {
    if (std.mem.startsWith(u8, template, "./") or std.mem.startsWith(u8, template, "/")) return template;
    return std.mem.concat(allocator, u8, &.{ "./", template });
}

const BuildLogPositionJson = struct {
    lineText: ?[]const u8 = null,
    file: []const u8,
    namespace: []const u8,
    line: i32,
    column: i32,
    length: u64,
    offset: u64,
};

const BuildLogJson = struct {
    name: []const u8,
    level: []const u8,
    message: []const u8,
    position: ?BuildLogPositionJson = null,
    specifier: ?[]const u8 = null,
    importKind: ?[]const u8 = null,
};

const BuildOutputJson = struct {
    path: []const u8,
    kind: []const u8,
    loader: []const u8,
    hash: ?[]const u8 = null,
    sourcemapIndex: ?u32 = null,
    b64: []const u8,
};

const BuildResultJson = struct {
    success: bool,
    logs: []const BuildLogJson,
    outputs: []const BuildOutputJson,
    metafile: ?[]const u8 = null,
    metafileMarkdown: ?[]const u8 = null,
};

// COTTONTAIL-COMPAT: Bun CSS internals - stock JSC cannot consume Bun's
// $newZigFunction bindings, so the existing native build bridge carries the
// same vendored Zig parser/minifier inputs and results as structured JSON.
const CssInternalsResponse = struct {
    success: bool,
    result: ?[]const u8 = null,
    @"error": ?[]const u8 = null,
};

const CssInternalsKind = enum {
    normal,
    minify,
    prefix,
};

fn cssInternalsResponse(
    allocator: std.mem.Allocator,
    success: bool,
    result: ?[]const u8,
    error_message: ?[]const u8,
) ![]u8 {
    const json = try std.json.Stringify.valueAlloc(allocator, CssInternalsResponse{
        .success = success,
        .result = result,
        .@"error" = error_message,
    }, .{});
    return try c_allocator.dupe(u8, json);
}

fn cssInternalsError(
    allocator: std.mem.Allocator,
    log: *const compiler.logger.Log,
    fallback: []const u8,
) ![]u8 {
    for (log.msgs.items) |message| {
        if (message.kind == .err) {
            return cssInternalsResponse(allocator, false, null, message.data.text);
        }
    }
    return cssInternalsResponse(allocator, false, null, fallback);
}

fn cssInteger(value: std.json.Value) ?u32 {
    return switch (value) {
        .integer => |number| if (number >= 0 and number <= std.math.maxInt(u32)) @intCast(number) else null,
        .float => |number| if (number >= 0 and number <= std.math.maxInt(u32)) @intFromFloat(number) else null,
        else => null,
    };
}

fn cssTargetsFromJson(value: ?std.json.Value) ?compiler.css.targets.Browsers {
    var browsers: compiler.css.targets.Browsers = .{};
    const object = if (value) |item| switch (item) {
        .object => |object| object,
        else => return null,
    } else return null;

    inline for (.{
        .{ "android", "android" },
        .{ "chrome", "chrome" },
        .{ "edge", "edge" },
        .{ "firefox", "firefox" },
        .{ "ie", "ie" },
        .{ "ios_saf", "ios_saf" },
        .{ "opera", "opera" },
        .{ "safari", "safari" },
        .{ "samsung", "samsung" },
    }) |entry| {
        if (object.get(entry[0])) |item| {
            if (cssInteger(item)) |number| @field(browsers, entry[1]) = number;
        }
    }
    return browsers;
}

fn applyCssParserOptions(
    options: *compiler.css.ParserOptions,
    value: ?std.json.Value,
) !void {
    const object = if (value) |item| switch (item) {
        .object => |object| object,
        else => return,
    } else return;
    const flags = object.get("flags") orelse return;
    if (flags != .array) return error.InvalidCssParserFlags;
    for (flags.array.items) |flag| {
        if (flag != .string) return error.InvalidCssParserFlags;
        if (std.mem.eql(u8, flag.string, "DEEP_SELECTOR_COMBINATOR")) {
            options.flags.deep_selector_combinator = true;
        } else {
            return error.InvalidCssParserFlag;
        }
    }
}

fn runCssStylesheetInternals(
    allocator: std.mem.Allocator,
    source: []const u8,
    kind: CssInternalsKind,
    parser_options_value: ?std.json.Value,
    browsers_value: ?std.json.Value,
) ![]u8 {
    var log = compiler.logger.Log.init(allocator);
    defer log.deinit();
    var parser_options = compiler.css.ParserOptions.default(allocator, &log);
    applyCssParserOptions(&parser_options, parser_options_value) catch |err| {
        const message = switch (err) {
            error.InvalidCssParserFlags => "flags must be an array",
            error.InvalidCssParserFlag => "invalid CSS parser flag",
        };
        return cssInternalsResponse(allocator, false, null, message);
    };

    var import_records = compiler.BabyList(compiler.ImportRecord){};
    switch (compiler.css.StyleSheet(compiler.css.DefaultAtRule).parse(
        allocator,
        source,
        parser_options,
        &import_records,
        compiler.bundle_v2.Index.invalid,
    )) {
        .result => |parsed| {
            var stylesheet, var extra = parsed;
            var minify_options = compiler.css.MinifyOptions.default();
            minify_options.targets.browsers = cssTargetsFromJson(browsers_value);
            switch (stylesheet.minify(allocator, minify_options, &extra)) {
                .result => {},
                .err => return cssInternalsError(allocator, &log, "CSS minification failed"),
            }

            const symbols = compiler.ast.Symbol.Map{};
            var local_names = compiler.css.LocalsResultsMap{};
            return switch (stylesheet.toCss(
                allocator,
                .{
                    .minify = kind == .minify,
                    .targets = .{ .browsers = minify_options.targets.browsers },
                },
                .initOutsideOfBundler(&import_records),
                &local_names,
                &symbols,
            )) {
                .result => |result| cssInternalsResponse(allocator, true, result.code, null),
                .err => cssInternalsError(allocator, &log, "CSS printing failed"),
            };
        },
        .err => return cssInternalsError(allocator, &log, "CSS parsing failed"),
    }
}

fn runCssAttributeInternals(
    allocator: std.mem.Allocator,
    source: []const u8,
    minify: bool,
    browsers_value: ?std.json.Value,
) ![]u8 {
    var log = compiler.logger.Log.init(allocator);
    defer log.deinit();
    const parser_options = compiler.css.ParserOptions.default(allocator, &log);
    var import_records = compiler.BabyList(compiler.ImportRecord){};
    switch (compiler.css.StyleAttribute.parse(
        allocator,
        source,
        parser_options,
        &import_records,
        compiler.bundle_v2.Index.invalid,
    )) {
        .result => |parsed| {
            var stylesheet = parsed;
            var minify_options = compiler.css.MinifyOptions.default();
            minify_options.targets.browsers = cssTargetsFromJson(browsers_value);
            stylesheet.minify(allocator, minify_options);
            const printed = stylesheet.toCss(
                allocator,
                .{ .minify = minify, .targets = minify_options.targets },
                .initOutsideOfBundler(&import_records),
            ) catch return cssInternalsError(allocator, &log, "CSS attribute printing failed");
            return cssInternalsResponse(allocator, true, printed.code, null);
        },
        .err => return cssInternalsError(allocator, &log, "CSS attribute parsing failed"),
    }
}

fn runCssInternalsRequest(
    allocator: std.mem.Allocator,
    value: std.json.Value,
) ![]u8 {
    if (value != .object) return cssInternalsResponse(allocator, false, null, "Invalid CSS internals request");
    const object = value.object;
    const operation_value = object.get("operation") orelse
        return cssInternalsResponse(allocator, false, null, "CSS internals operation is required");
    const source_value = object.get("source") orelse
        return cssInternalsResponse(allocator, false, null, "CSS source is required");
    if (operation_value != .string or source_value != .string) {
        return cssInternalsResponse(allocator, false, null, "CSS internals operation and source must be strings");
    }
    const operation = operation_value.string;
    const source = source_value.string;
    if (std.mem.eql(u8, operation, "attrTest")) {
        const minify = if (object.get("minify")) |item| item == .bool and item.bool else false;
        return runCssAttributeInternals(allocator, source, minify, object.get("options"));
    }

    const kind: CssInternalsKind = if (std.mem.startsWith(u8, operation, "minify"))
        .minify
    else if (std.mem.startsWith(u8, operation, "prefix"))
        .prefix
    else
        .normal;
    const with_parser_options = std.mem.endsWith(u8, operation, "WithOptions");
    return runCssStylesheetInternals(
        allocator,
        source,
        kind,
        if (with_parser_options) object.get("options") else null,
        if (with_parser_options) null else object.get("options"),
    );
}

fn buildLogFromMessage(allocator: std.mem.Allocator, message: *const compiler.logger.Msg) !BuildLogJson {
    var entry = BuildLogJson{
        .name = if (message.metadata == .resolve) "ResolveMessage" else "BuildMessage",
        .level = message.kind.string(),
        .message = try allocator.dupe(u8, message.data.text),
    };
    if (message.data.location) |location| {
        entry.position = .{
            .lineText = if (location.line_text) |text|
                try allocator.dupe(u8, std.mem.trimEnd(u8, text, "\r\n"))
            else
                null,
            .file = try allocator.dupe(u8, location.file),
            .namespace = if (location.namespace.len > 0) try allocator.dupe(u8, location.namespace) else "file",
            .line = location.line,
            .column = location.column,
            .length = location.length,
            .offset = location.offset,
        };
    }
    if (message.metadata == .resolve) {
        entry.specifier = try allocator.dupe(u8, message.metadata.resolve.specifier.slice(message.data.text));
        entry.importKind = message.metadata.resolve.import_kind.label();
    }
    return entry;
}

fn buildLogsFromLogger(allocator: std.mem.Allocator, log: *const compiler.logger.Log, errors_only: bool) ![]const BuildLogJson {
    var logs: std.ArrayList(BuildLogJson) = .empty;
    for (log.msgs.items) |*message| {
        if (errors_only and message.kind != .err) continue;
        if (message.kind != .err and message.kind != .warn) continue;
        try logs.append(allocator, try buildLogFromMessage(allocator, message));
    }
    return logs.items;
}

fn buildFailureJson(allocator: std.mem.Allocator, log: *const compiler.logger.Log, fallback: anyerror) ![]u8 {
    var logs = try buildLogsFromLogger(allocator, log, false);
    if (logs.len == 0) {
        var fallback_logs = try allocator.alloc(BuildLogJson, 1);
        fallback_logs[0] = .{
            .name = "BuildMessage",
            .level = "error",
            .message = try std.fmt.allocPrint(allocator, "JavaScript bundle failed: {s}", .{@errorName(fallback)}),
        };
        logs = fallback_logs;
    }
    const result = BuildResultJson{ .success = false, .logs = logs, .outputs = &.{} };
    const json = try std.json.Stringify.valueAlloc(allocator, result, .{});
    return try c_allocator.dupe(u8, json);
}

/// Bun.build JS API entry point: bundles one or more entry points in-memory
/// and returns a JSON document with structured outputs (base64 contents,
/// relative paths, artifact kinds/loaders/hashes) and structured logs
/// (including source positions), mirroring Bun's BuildArtifact/BuildMessage
/// shapes. Never writes to disk; the JS driver materializes `outdir`.
pub fn buildEntryPointsJson(
    request_json: []const u8,
    working_dir: []const u8,
    error_out: *?[*:0]u8,
) ![]u8 {
    var arena = std.heap.ArenaAllocator.init(c_allocator);
    defer arena.deinit();
    const arena_allocator = arena.allocator();

    const parsed_request = std.json.parseFromSlice(std.json.Value, arena_allocator, request_json, .{}) catch {
        setError(error_out, "Invalid Bun.build options: expected a JSON object", .{});
        return error.InvalidOptions;
    };
    if (parsed_request.value != .object) {
        setError(error_out, "Invalid Bun.build options: expected a JSON object", .{});
        return error.InvalidOptions;
    }
    const request_object = parsed_request.value.object;
    if (request_object.get("__cottontailCssInternals")) |css_request| {
        return runCssInternalsRequest(arena_allocator, css_request);
    }
    var entry_points: std.ArrayList([]const u8) = .empty;
    if (request_object.get("entrypoints")) |value| {
        if (value == .array) {
            for (value.array.items) |item| {
                if (item == .string) try entry_points.append(arena_allocator, item.string);
            }
        }
    }
    if (entry_points.items.len == 0) {
        setError(error_out, "Bun.build requires at least one entry point", .{});
        return error.InvalidOptions;
    }
    var options = parseBuildOptions(request_json, arena_allocator) catch |err| {
        setError(error_out, "Invalid Bun.build options: {s}", .{@errorName(err)});
        return err;
    };
    // COTTONTAIL-COMPAT: Bun build bytecode - see the runtime-bundle guard
    // above. This remains an explicit unsupported result until portable JSC
    // exposes a cache serializer Cottontail can also consume at runtime.
    if (options.bytecode) {
        setError(error_out, "Bun.build bytecode requires a JavaScriptCore cached-bytecode API", .{});
        return error.UnsupportedBytecode;
    }
    // Bun.build defaults to target "browser" (the runtime bundler defaults to
    // "bun"); an explicit target was already applied by parseBuildOptions.
    if (request_object.get("target") == null) options.target = .browser;

    const allocator = compiler.default_allocator;
    compiler.cli.start_time = compiler.nanoTimestamp();
    const default_root = if (entry_points.items.len == 1)
        (std.fs.path.dirname(entry_points.items[0]) orelse ".")
    else
        compiler.path.getIfExistsLongestCommonPath(entry_points.items) orelse ".";
    const requested_root = if (request_object.get("root")) |value|
        if (value == .string and value.string.len > 0) value.string else default_root
    else
        default_root;
    const build_root = if (std.fs.path.isAbsolute(requested_root))
        requested_root
    else
        try std.fs.path.resolve(arena_allocator, &.{ working_dir, requested_root });
    const build_root_z = try allocator.dupeZ(u8, build_root);
    defer allocator.free(build_root_z);
    const working_dir_z = try allocator.dupeZ(u8, working_dir);
    defer allocator.free(working_dir_z);

    var transform_options = std.mem.zeroes(compiler.schema.api.TransformOptions);
    // Bun resolves and labels source files relative to the process working
    // directory. Its inferred/configured root only controls output naming.
    transform_options.absolute_working_dir = working_dir_z;
    transform_options.entry_points = entry_points.items;
    transform_options.target = options.target;
    transform_options.write = false;
    transform_options.output_dir = "";
    transform_options.source_map = options.source_map;
    transform_options.conditions = options.conditions;
    transform_options.tsconfig_override = options.tsconfig_override;
    transform_options.packages = if (options.external_packages) .external else .bundle;
    transform_options.external = options.external;
    transform_options.drop = options.drop;
    transform_options.feature_flags = options.features;
    if (options.loader_extensions.len > 0) {
        transform_options.loaders = .{
            .extensions = options.loader_extensions,
            .loaders = options.loader_values,
        };
    }
    transform_options.disable_hmr = true;
    transform_options.main_fields = &.{ "main", "module" };
    if (options.jsx_factory != null or
        options.jsx_fragment != null or
        options.jsx_runtime != null or
        options.jsx_import_source != null or
        options.jsx_development != null or
        options.jsx_side_effects != null)
    {
        transform_options.jsx = .{
            .factory = options.jsx_factory orelse "",
            .runtime = options.jsx_runtime orelse .automatic,
            .fragment = options.jsx_fragment orelse "",
            .development = options.jsx_development orelse !options.production,
            .import_source = options.jsx_import_source orelse "",
            .side_effects = options.jsx_side_effects orelse false,
        };
    }
    if (options.define_keys.len > 0) {
        transform_options.define = .{
            .keys = options.define_keys,
            .values = options.define_values,
        };
    }

    var log = compiler.logger.Log.init(allocator);
    var transpiler = compiler.Transpiler.init(allocator, &log, transform_options, null) catch |err| {
        const json = buildFailureJson(arena_allocator, &log, err) catch {
            setBuildError(error_out, &log, err);
            log.deinit();
            return err;
        };
        log.deinit();
        return json;
    };
    defer transpiler.deinitPreservingFileSystem();
    // Match Bun's compiler lifecycle so package resolution sees NODE_PATH and
    // the rest of the inherited process environment.
    try transpiler.env.loadProcess();
    try transpiler.fs.setTopLevelDir(working_dir_z);

    transpiler.options.output_format = options.output_format;
    transpiler.options.source_map = compiler.options.SourceMapOption.fromApi(options.source_map);
    transpiler.options.banner = options.banner;
    transpiler.options.footer = options.footer;
    transpiler.options.public_path = options.public_path;
    transpiler.options.transform_only = options.transform_only;
    transpiler.options.env.behavior = options.env_behavior;
    transpiler.options.env.prefix = options.env_prefix;
    transpiler.options.bytecode = options.bytecode;
    transpiler.options.minify_whitespace = options.minify_whitespace;
    transpiler.options.minify_identifiers = options.minify_identifiers;
    transpiler.options.minify_syntax = options.minify_syntax;
    transpiler.options.keep_names = options.keep_names;
    transpiler.options.no_macros = options.no_macros;
    transpiler.options.allow_unresolved = if (options.allow_unresolved) |patterns|
        compiler.options.AllowUnresolved.fromStrings(patterns)
    else
        .all;
    transpiler.options.ignore_dce_annotations = options.ignore_dce_annotations;
    transpiler.options.emit_dce_annotations = options.emit_dce_annotations orelse !options.minify_whitespace;
    transpiler.options.setProduction(options.production);
    if (options.production) try transpiler.env.map.put("NODE_ENV", "production");
    // The filesystem root must be selected before resolving inputs because it
    // also determines source-map source paths and their deterministic debug ID.
    transpiler.options.root_dir = build_root;
    transpiler.options.react_fast_refresh = options.react_fast_refresh;
    transpiler.options.entry_naming = options.entry_naming;
    transpiler.options.chunk_naming = options.chunk_naming;
    transpiler.options.asset_naming = options.asset_naming;
    transpiler.options.metafile = options.metafile;
    transpiler.options.metafile_json_path = options.metafile_json_path;
    transpiler.options.metafile_markdown_path = options.metafile_markdown_path;
    transpiler.options.code_splitting = options.code_splitting;
    transpiler.options.supports_multiple_outputs = true;
    var optimize_imports = compiler.StringSet.init(arena_allocator);
    for (options.optimize_imports) |package_name| try optimize_imports.insert(package_name);
    if (!optimize_imports.isEmpty()) transpiler.options.optimize_imports = &optimize_imports;
    // Cottontail's vendored JSC has no native `using` / `await using`
    // support; always lower them so Bun.build outputs can run on this runtime.
    transpiler.options.force_lower_using = true;
    // Linker configuration must run before defines: configureLinker() seeds
    // options.jsx wholesale from the root tsconfig (development=true for
    // "react-jsx"/"react-jsxdev"), and configureDefines() then applies the
    // NODE_ENV production/development override on top (matching upstream
    // bun's configureLinker -> configureDefines ordering).
    transpiler.configureLinker();
    if (options.jsx_factory) |factory| {
        transpiler.options.jsx.factory = try compiler.options.JSX.Pragma.memberListToComponentsIfDifferent(
            arena_allocator,
            transpiler.options.jsx.factory,
            factory,
        );
    }
    if (options.jsx_fragment) |fragment| {
        transpiler.options.jsx.fragment = try compiler.options.JSX.Pragma.memberListToComponentsIfDifferent(
            arena_allocator,
            transpiler.options.jsx.fragment,
            fragment,
        );
    }
    if (options.jsx_runtime) |runtime| transpiler.options.jsx.runtime = runtime;
    if (options.jsx_import_source) |import_source| {
        transpiler.options.jsx.package_name = import_source;
        transpiler.options.jsx.classic_import_source = import_source;
        transpiler.options.jsx.setImportSource(arena_allocator);
    }
    if (options.jsx_development) |development| transpiler.options.jsx.development = development;
    if (options.jsx_side_effects) |side_effects| transpiler.options.jsx.side_effects = side_effects;
    transpiler.configureDefines() catch |err| {
        return try buildFailureJson(arena_allocator, &log, err);
    };
    // An explicit Bun.build jsx.development option wins over NODE_ENV.
    if (options.jsx_development) |development| {
        transpiler.options.jsx.development = development;
        transpiler.options.force_node_env = .unspecified;
    }
    if (std.c.getenv("COTTONTAIL_DEBUG_JSX") != null) {
        std.debug.print("dbg build jsx: requested={any} production={} jsx.development={} side_effects={} source={s}\n", .{
            options.jsx_development,
            transpiler.options.production,
            transpiler.options.jsx.development,
            transpiler.options.jsx.side_effects,
            transpiler.options.jsx.importSource(),
        });
    }
    if (!transpiler.options.production) {
        try transpiler.options.conditions.appendSlice(&.{"development"});
    }
    transpiler.resolver.opts = transpiler.options;
    transpiler.resolver.env_loader = transpiler.env;

    var input_file_map: compiler.jsc.API.JSBundler.FileMap = .{};
    if (request_object.get("files")) |files_value| {
        if (files_value == .object) {
            var iterator = files_value.object.iterator();
            while (iterator.next()) |entry| {
                if (entry.value_ptr.* != .string) continue;
                const path = if (std.fs.path.isAbsolute(entry.key_ptr.*))
                    try arena_allocator.dupe(u8, entry.key_ptr.*)
                else
                    try std.fs.path.resolve(arena_allocator, &.{ working_dir, entry.key_ptr.* });
                try input_file_map.map.put(arena_allocator, path, entry.value_ptr.string);
            }
        }
    }
    const input_file_map_ptr = if (input_file_map.map.count() > 0) &input_file_map else null;

    var reachable_files_count: usize = 0;
    var minify_duration: u64 = 0;
    var source_code_size: u64 = 0;
    const event_loop = compiler.jsc.AnyEventLoop.init(allocator);
    const worker_pool = sharedWorkerPool();
    defer {
        transpiler.allocator = allocator;
        transpiler.resolver.allocator = allocator;
        transpiler.linker.allocator = allocator;
    }
    var bundle: ?*compiler.bundle_v2.BundleV2 = null;
    defer if (bundle) |value| {
        if (worker_pool != null) value.deinitFromCLI(allocator) else value.deinitWithoutFreeingArena();
    };
    // BundleV2.init points `log.msgs.allocator` at the bundle arena, so the
    // log must be abandoned (not freed) before the arena teardown above runs;
    // message texts consumed by callers are duped out beforehand.
    defer log.msgs = std.array_list.Managed(compiler.logger.Msg).init(allocator);
    var result = compiler.bundle_v2.BundleV2.generateFromCLIReleasable(
        &transpiler,
        allocator,
        event_loop,
        false,
        &reachable_files_count,
        &minify_duration,
        &source_code_size,
        null,
        input_file_map_ptr,
        &bundle,
        worker_pool,
    ) catch |err| {
        return try buildFailureJson(arena_allocator, &log, err);
    };
    defer result.deinit();

    var outputs: std.ArrayList(BuildOutputJson) = .empty;
    const base64 = std.base64.standard.Encoder;
    for (result.output_files.items) |output_file| {
        const bytes = output_file.value.asSlice();
        const encoded = try arena_allocator.alloc(u8, base64.calcSize(bytes.len));
        _ = base64.encode(encoded, bytes);
        const hash = try std.fmt.allocPrint(arena_allocator, "{f}", .{compiler.fmt.truncatedHash32(output_file.hash)});
        // HTML entries produce associated JavaScript and CSS artifacts. Bun
        // reports those artifacts' generated loaders while preserving the
        // input loader for ordinary JS-family entry points (for example JSX).
        const artifact_loader = if (output_file.input_loader == .html and output_file.loader != .html)
            output_file.loader
        else
            output_file.input_loader;
        try outputs.append(arena_allocator, .{
            .path = try arena_allocator.dupe(u8, output_file.dest_path),
            .kind = @tagName(output_file.output_kind),
            .loader = @tagName(artifact_loader),
            .hash = hash,
            .sourcemapIndex = if (output_file.source_map_index != std.math.maxInt(u32))
                output_file.source_map_index
            else
                null,
            .b64 = encoded,
        });
    }

    const metafile_markdown = result.metafile_markdown orelse if (options.metafile_markdown_path.len > 0 and result.metafile != null)
        try compiler.bundle_v2.LinkerContext.MetafileBuilder.generateMarkdown(arena_allocator, result.metafile.?)
    else
        null;
    const result_json = BuildResultJson{
        .success = true,
        .logs = try buildLogsFromLogger(arena_allocator, &log, false),
        .outputs = outputs.items,
        .metafile = result.metafile,
        .metafileMarkdown = metafile_markdown,
    };
    const json = try std.json.Stringify.valueAlloc(arena_allocator, result_json, .{});
    return try c_allocator.dupe(u8, json);
}

pub export fn ct_bundle_entry_point_options(
    entry_ptr: ?[*]const u8,
    entry_len: usize,
    working_dir_ptr: ?[*]const u8,
    working_dir_len: usize,
    options_ptr: ?[*]const u8,
    options_len: usize,
    out_len: *usize,
    error_out: *?[*:0]u8,
) ?[*]u8 {
    out_len.* = 0;
    error_out.* = null;
    const entry_path = if (entry_ptr) |ptr| ptr[0..entry_len] else {
        setError(error_out, "entry point is required", .{});
        return null;
    };
    const working_dir = if (working_dir_ptr) |ptr| ptr[0..working_dir_len] else {
        setError(error_out, "working directory is required", .{});
        return null;
    };
    const options_json = if (options_ptr) |ptr| ptr[0..options_len] else "";
    var arena = std.heap.ArenaAllocator.init(c_allocator);
    defer arena.deinit();
    const options = parseBuildOptions(options_json, arena.allocator()) catch |err| {
        setError(error_out, "Invalid Bun.build options: {s}", .{@errorName(err)});
        return null;
    };
    const output = bundleEntryPointWithOptions(entry_path, working_dir, options, error_out) catch return null;
    out_len.* = output.len;
    return output.ptr;
}

pub export fn ct_bundle_build(
    request_ptr: ?[*]const u8,
    request_len: usize,
    working_dir_ptr: ?[*]const u8,
    working_dir_len: usize,
    out_len: *usize,
    error_out: *?[*:0]u8,
) ?[*]u8 {
    out_len.* = 0;
    error_out.* = null;
    const request_json = if (request_ptr) |ptr| ptr[0..request_len] else {
        setError(error_out, "Bun.build options are required", .{});
        return null;
    };
    const working_dir = if (working_dir_ptr) |ptr| ptr[0..working_dir_len] else {
        setError(error_out, "working directory is required", .{});
        return null;
    };
    const output = buildEntryPointsJson(request_json, working_dir, error_out) catch |err| {
        if (error_out.* == null) setError(error_out, "JavaScript bundle failed: {s}", .{@errorName(err)});
        return null;
    };
    out_len.* = output.len;
    return output.ptr;
}

pub export fn ct_bundle_free(ptr: ?[*]u8, len: usize) void {
    if (ptr) |value| c_allocator.free(value[0..len]);
}

pub export fn ct_bundle_string_free(ptr: ?[*:0]u8) void {
    if (ptr) |value| c_allocator.free(std.mem.span(value));
}

pub fn forceLink() void {
    _ = &ct_bundle_entry_point;
    _ = &ct_bundle_entry_point_options;
    _ = &ct_bundle_build;
    _ = &ct_bundle_free;
    _ = &ct_bundle_string_free;
}

test "bundle graph retains split chunks and their source maps" {
    const allocator = std.testing.allocator;
    const io = std.Io.Threaded.global_single_threaded.io();
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    try tmp.dir.writeFile(io, .{
        .sub_path = "entry.js",
        .data =
        \\export async function load() {
        \\  return import("./lazy.js");
        \\}
        \\load();
        ,
    });
    try tmp.dir.writeFile(io, .{
        .sub_path = "lazy.js",
        .data = "export const value = 42;\n",
    });

    const relative_root = try std.fs.path.join(allocator, &.{ ".zig-cache", "tmp", &tmp.sub_path });
    defer allocator.free(relative_root);
    const absolute_root = try std.Io.Dir.cwd().realPathFileAlloc(io, relative_root, allocator);
    defer allocator.free(absolute_root);
    const entry_path = try std.fs.path.join(allocator, &.{ absolute_root, "entry.js" });
    defer allocator.free(entry_path);

    var error_message: ?[*:0]u8 = null;
    defer if (error_message) |message| ct_bundle_string_free(message);
    var graph = bundleEntryPointGraphWithOptions(
        entry_path,
        absolute_root,
        .{
            .source_map = .external,
            .code_splitting = true,
            .entry_naming = "[name].[ext]",
            .chunk_naming = "chunk-[hash].[ext]",
        },
        &error_message,
    ) catch |err| {
        if (error_message) |message| std.debug.print("bundle graph failed: {s}\n", .{std.mem.span(message)});
        return err;
    };
    defer graph.deinit();

    const entry = graph.entryPoint() orelse return error.MissingEntryPoint;
    try std.testing.expectEqual(GraphOutputKind.@"entry-point", entry.kind);

    var entry_count: usize = 0;
    var chunk_count: usize = 0;
    for (graph.files) |file| {
        switch (file.kind) {
            .@"entry-point" => entry_count += 1,
            .chunk => chunk_count += 1,
            .asset => continue,
        }
        try std.testing.expect(file.path.len > 0);
        try std.testing.expect(file.contents.len > 0);
        const source_map = file.source_map orelse return error.MissingSourceMap;
        try std.testing.expect(std.mem.endsWith(u8, source_map.path, ".map"));
        const parsed = try std.json.parseFromSlice(std.json.Value, allocator, source_map.contents, .{});
        defer parsed.deinit();
        const version = parsed.value.object.get("version") orelse return error.InvalidSourceMap;
        try std.testing.expectEqual(@as(i64, 3), version.integer);
    }
    try std.testing.expectEqual(@as(usize, 1), entry_count);
    try std.testing.expect(chunk_count >= 1);

    // The compatibility helper uses these transfers before graph teardown.
    // Exercise them here so an ownership regression becomes a double-free or
    // allocator leak in the focused Zig test instead of a runtime-only fault.
    const transferred_code = entry.takeContents();
    defer c_allocator.free(transferred_code);
    const transferred_source_map = entry.takeSourceMapContents() orelse return error.MissingSourceMap;
    defer c_allocator.free(transferred_source_map);
}
