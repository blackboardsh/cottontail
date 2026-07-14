const std = @import("std");

pub const Environment = @import("bun_core/env.zig");
pub const windows = @import("sys/windows/windows.zig");
pub const deprecated = @import("bun_core/deprecated.zig");
pub const OOM = std.mem.Allocator.Error;
pub const JSError = error{ JSError, OutOfMemory, JSTerminated };
pub const Maybe = jsc.Node.Maybe;
// NOTE: page_allocator (mmap-backed) rather than the libc allocator on
// purpose: upstream tests run cottontail children under libgmalloc
// (harness.forceGuardMalloc), and routing the compiler's allocation firehose
// through guarded malloc makes process startup exceed test timeouts. Bulk
// allocations flow through arenas, so per-allocation page rounding is mostly
// amortized.
pub const default_allocator = std.heap.page_allocator;
/// Package-manager sources are owned by Cottontail. Resolver auto-install stays
/// disabled until its network and event-loop path is integrated with the runtime.
pub const enable_package_manager = false;
pub const DefaultAllocator = struct {
    pub fn allocator(_: DefaultAllocator) std.mem.Allocator {
        return default_allocator;
    }
};
pub const Generation = u16;
pub const bytecode_extension = ".jsc";
pub const Stat = std.Io.File.Stat;
pub const Watcher = struct {
    pub fn addFile(
        _: *Watcher,
        _: FD,
        _: []const u8,
        _: u32,
        _: options.Loader,
        _: FD,
        _: anytype,
        comptime _: bool,
    ) void {}
};
pub const ptr = @import("ptr/ptr.zig");
pub const threading = @import("threading/threading.zig");
pub const ThreadPool = threading.ThreadPool;
pub const UnboundedQueue = threading.UnboundedQueue;
pub const Futex = threading.Futex;
pub const Async = if (Environment.isWindows)
    @import("aio/windows_event_loop.zig")
else
    @import("aio/posix_event_loop.zig");
pub const ConfigVersion = @import("install/ConfigVersion.zig").ConfigVersion;
pub const ArenaAllocator = std.heap.ArenaAllocator;
pub const StandaloneModuleGraph = struct {
    pub const File = struct { name: []const u8 };

    pub fn isBunStandaloneFilePath(_: []const u8) bool {
        return false;
    }

    pub fn findAssumeStandalonePath(_: *const StandaloneModuleGraph, _: []const u8) ?*File {
        return null;
    }
};
pub const Mutex = @import("threading/Mutex.zig");
pub const Progress = @import("bun_core/Progress.zig");
pub const picohttp = @import("picohttp/picohttp.zig");
pub const IdentityContext = @import("collections/identity_context.zig").IdentityContext;
pub const ArrayIdentityContext = @import("collections/identity_context.zig").ArrayIdentityContext;
pub const TaggedPointerUnion = ptr.TaggedPointerUnion;
pub const PackageJSON = @import("resolver/package_json.zig").PackageJSON;
pub const patch = @import("patch/patch.zig");
pub const MaxHeapAllocator = @import("bun_alloc/MaxHeapAllocator.zig");
pub const uws = @import("uws/uws.zig");
pub const simdutf = struct {
    pub const convert = struct {
        pub const Status = enum { success, surrogate, invalid };
        pub const Result = struct {
            status: Status,
            count: usize,

            pub fn isSuccessful(self: @This()) bool {
                return self.status == .success;
            }
        };

        pub const utf8 = struct {
            pub const to = struct {
                pub const utf16 = struct {
                    fn convertImpl(input: []const u8, output: []u16) Result {
                        const count = std.unicode.utf8ToUtf16Le(output, input) catch return .{ .status = .invalid, .count = 0 };
                        return .{ .status = .success, .count = count };
                    }

                    pub const with_errors = struct {
                        pub fn le(input: []const u8, output: []u16) Result {
                            return convertImpl(input, output);
                        }
                    };

                    pub fn le(input: []const u8, output: []u16) usize {
                        const result = convertImpl(input, output);
                        return if (result.status == .success) result.count else 0;
                    }
                };
            };
        };

        pub const utf16 = struct {
            pub const to = struct {
                pub const utf8 = struct {
                    fn convertImpl(input: []const u16, output: []u8) Result {
                        const count = std.unicode.utf16LeToUtf8(output, input) catch return .{ .status = .surrogate, .count = 0 };
                        return .{ .status = .success, .count = count };
                    }

                    pub const with_errors = struct {
                        pub fn le(input: []const u16, output: []u8) Result {
                            return convertImpl(input, output);
                        }
                    };

                    pub fn le(input: []const u16, output: []u8) usize {
                        const result = convertImpl(input, output);
                        return if (result.status == .success) result.count else 0;
                    }
                };
            };
        };

        pub const utf32 = struct {
            pub const to = struct {
                pub const utf8 = struct {
                    pub const with_errors = struct {
                        pub fn le(input: []const u32, output: []u8) Result {
                            var count: usize = 0;
                            for (input) |codepoint| {
                                if (codepoint > 0x10FFFF or (codepoint >= 0xD800 and codepoint <= 0xDFFF)) {
                                    return .{ .status = .invalid, .count = count };
                                }
                                count += std.unicode.utf8Encode(@intCast(codepoint), output[count..]) catch
                                    return .{ .status = .invalid, .count = count };
                            }
                            return .{ .status = .success, .count = count };
                        }
                    };
                };
            };
        };
    };

    pub const validate = struct {
        pub fn utf8(input: []const u8) bool {
            return std.unicode.utf8ValidateSlice(input);
        }
    };
};

pub fn once(comptime function: anytype) Once(function) {
    return .{};
}

pub fn Once(comptime function: anytype) type {
    return struct {
        const Return = @typeInfo(@TypeOf(function)).@"fn".return_type.?;

        done: bool = false,
        payload: Return = undefined,
        mutex: Mutex = .{},

        pub fn call(self: *@This(), args: std.meta.ArgsTuple(@TypeOf(function))) Return {
            if (@atomicLoad(bool, &self.done, .acquire)) return self.payload;

            self.mutex.lock();
            defer self.mutex.unlock();
            if (!self.done) {
                self.payload = @call(.auto, function, args);
                @atomicStore(bool, &self.done, true, .release);
            }
            return self.payload;
        }
    };
}

pub const LazyBoolValue = enum { unknown, no, yes };
pub fn LazyBool(comptime getter: anytype, comptime Parent: type, comptime field: []const u8) type {
    return struct {
        value: LazyBoolValue = .unknown,

        pub fn get(self: *@This()) bool {
            if (self.value == .unknown) {
                const parent: *Parent = @alignCast(@fieldParentPtr(field, self));
                self.value = if (getter(parent)) .yes else .no;
            }
            return self.value == .yes;
        }
    };
}

pub fn DebugOnly(comptime Type: type) type {
    return if (Environment.isDebug) Type else void;
}

const ThreadlocalBuffersNode = struct {
    next: ?*ThreadlocalBuffersNode,
    free: *const fn (*ThreadlocalBuffersNode) void,
};
threadlocal var threadlocal_buffers_head: ?*ThreadlocalBuffersNode = null;

pub fn ThreadlocalBuffers(comptime T: type) type {
    return struct {
        threadlocal var instance: ?*T = null;

        const Storage = struct {
            node: ThreadlocalBuffersNode,
            data: T,
        };

        pub inline fn get() *T {
            return instance orelse alloc();
        }

        noinline fn alloc() *T {
            const storage = default_allocator.create(Storage) catch outOfMemory();
            storage.* = .{
                .node = .{ .next = threadlocal_buffers_head, .free = free },
                .data = .{},
            };
            threadlocal_buffers_head = &storage.node;
            instance = &storage.data;
            return &storage.data;
        }

        fn free(node: *ThreadlocalBuffersNode) void {
            instance = null;
            const storage: *Storage = @alignCast(@fieldParentPtr("node", node));
            default_allocator.destroy(storage);
        }
    };
}

pub fn freeAllThreadlocalBuffers() void {
    var node = threadlocal_buffers_head;
    threadlocal_buffers_head = null;
    while (node) |current| {
        const next = current.next;
        current.free(current);
        node = next;
    }
}

pub const S3 = struct {
    pub const S3Credentials = @import("s3_signing/credentials.zig").S3Credentials;
};
pub const cli = struct {
    pub var start_time: i128 = 0;
    pub const debug_flags = struct {
        pub fn hasResolveBreakpoint(_: []const u8) bool {
            return false;
        }

        pub fn hasPrintBreakpoint(_: []const u8) bool {
            return false;
        }
    };
};
pub const analytics = struct {
    pub const Features = struct {
        pub var define: usize = 0;
        pub var loaders: usize = 0;
        pub var macros: usize = 0;
        pub var external: usize = 0;
        pub var tsconfig: usize = 0;
        pub var tsconfig_paths: usize = 0;
        pub var dotenv: usize = 0;
        pub var yaml_parse: usize = 0;
        pub var todo_panic: usize = 0;
    };
};

pub fn nanoTimestamp() i128 {
    const io_instance = std.Io.Threaded.global_single_threaded.io();
    return @intCast(std.Io.Clock.awake.now(io_instance).nanoseconds);
}

pub fn getThreadCount() u16 {
    const count = std.Thread.getCpuCount() catch 2;
    return @intCast(@min(@as(usize, 1024), @max(@as(usize, 2), count)));
}
pub fn handleErrorReturnTrace(_: anyerror, _: ?*std.builtin.StackTrace) void {}
pub const callmod_inline: std.builtin.CallModifier = if (@import("builtin").mode == .Debug) .auto else .always_inline;
pub const callconv_inline: std.builtin.CallingConvention = if (@import("builtin").mode == .Debug) .auto else .@"inline";

pub const jsc = struct {
    pub const MAX_SAFE_INTEGER: f64 = 9007199254740991;
    pub const MIN_SAFE_INTEGER: f64 = -9007199254740991;
    pub const ZigString = @import("jsc/ZigString.zig").ZigString;
    pub const JSValue = struct {
        pub const zero: JSValue = .{};
    };
    pub const JSGlobalObject = opaque {};
    pub const EventLoop = opaque {};
    pub const EventLoopKind = enum { js, mini };
    pub const EventLoopHandle = @import("jsc/EventLoopHandle.zig").EventLoopHandle;
    pub const OpaqueCallback = *const fn (?*anyopaque) callconv(.c) void;
    pub const MiniEventLoop = @import("event_loop/MiniEventLoop.zig");
    pub const AnyTaskWithExtraContext = @import("event_loop/AnyTaskWithExtraContext.zig");
    pub const Strong = @import("jsc/Strong.zig");
    pub const VirtualMachine = struct {
        pub threadlocal var is_bundler_thread_for_bytecode_cache: bool = false;
        timer: TimerService = .{},

        pub const TimerService = struct {
            pub fn remove(_: *TimerService, timer: anytype) void {
                timer.state = .CANCELLED;
            }

            pub fn insert(_: *TimerService, timer: anytype) void {
                timer.state = .ACTIVE;
            }
        };

        pub fn runWithAPILock(_: *VirtualMachine, comptime Wrapper: type, wrapper: *Wrapper, comptime callback: anytype) void {
            callback(wrapper);
        }
    };
    pub const VM = VirtualMachine;
    pub fn initialize(_: bool) void {}
    pub const AnyEventLoop = struct {
        mutex: Mutex = .{},
        condition: threading.Condition = .{},
        head: ?*Task = null,
        tail: ?*Task = null,
        pub const Task = AnyTaskWithExtraContext;

        pub fn init(_: std.mem.Allocator) AnyEventLoop {
            return .{};
        }

        pub fn enqueueTaskConcurrentWithExtraCtx(
            self: *AnyEventLoop,
            comptime Context: type,
            comptime ParentContext: type,
            context: *Context,
            comptime callback: fn (*Context, *ParentContext) void,
            comptime field: std.meta.FieldEnum(Context),
        ) void {
            const TaskType = Task.New(Context, ParentContext, callback);
            const task = &@field(context, @tagName(field));
            task.* = TaskType.init(context);

            self.mutex.lock();
            defer self.mutex.unlock();
            if (self.tail) |tail| {
                tail.next = task;
            } else {
                self.head = task;
            }
            self.tail = task;
            self.condition.signal();
        }

        pub fn tick(
            self: *AnyEventLoop,
            context: anytype,
            comptime is_done: *const fn (@TypeOf(context)) bool,
        ) void {
            while (!is_done(context)) {
                self.mutex.lock();
                while (self.head == null and !is_done(context)) {
                    self.condition.timedWait(&self.mutex, std.time.ns_per_ms) catch {};
                }
                const task = self.head;
                if (task) |queued| {
                    self.head = queued.next;
                    if (self.head == null) self.tail = null;
                    queued.next = null;
                }
                self.mutex.unlock();
                if (task) |queued| queued.run(@ptrCast(context));
            }
        }

        pub fn wakeup(self: *AnyEventLoop) void {
            self.condition.broadcast();
        }
    };
    pub const C = struct {};
    pub const API = struct {
        pub const JSBundler = struct {
            pub const supports_plugins = false;
            pub const Plugin = opaque {};
            pub const FileMap = struct {
                map: StringHashMapUnmanaged([]const u8) = .empty,

                pub fn get(self: *const FileMap, specifier: []const u8) ?[]const u8 {
                    return self.map.get(specifier);
                }

                pub fn resolve(self: *const FileMap, source_file: []const u8, specifier: []const u8) ?@import("resolver/resolver.zig").Result {
                    const key = self.map.getKey(specifier) orelse relative: {
                        if (std.fs.path.isAbsolute(specifier) or source_file.len == 0) return null;
                        const source_dir = std.fs.path.dirname(source_file) orelse return null;
                        const joined = std.fs.path.resolve(default_allocator, &.{ source_dir, specifier }) catch return null;
                        defer default_allocator.free(joined);
                        break :relative self.map.getKey(joined) orelse return null;
                    };
                    return .{
                        .path_pair = .{ .primary = @import("resolver/fs.zig").Path.initWithNamespace(key, "file") },
                        .module_type = .unknown,
                    };
                }
            };
            pub const Load = opaque {};
            pub const Resolve = opaque {};
        };
        pub const BuildArtifact = struct {
            pub const OutputKind = enum {
                chunk,
                asset,
                @"entry-point",
                sourcemap,
                bytecode,
                module_info,
                @"metafile-json",
                @"metafile-markdown",
            };
        };
    };
    pub const math = struct {
        pub fn pow(a: f64, b: f64) f64 {
            return std.math.pow(f64, a, b);
        }
    };
    pub const URL = struct {
        backing: []u8 = &.{},
        parsed: @import("url/url.zig").URL = .{},

        pub const FileURL = struct {
            value: []const u8,

            pub fn format(this: FileURL, writer: *std.Io.Writer) !void {
                try writer.print("file://{s}", .{this.value});
            }
        };

        pub fn fileURLFromString(value: anytype) FileURL {
            const Value = @TypeOf(value);
            if (comptime @hasDecl(Value, "byteSlice")) {
                return .{ .value = value.byteSlice() };
            }
            return .{ .value = value };
        }

        pub fn fromString(value: @import("string/string.zig").String) ?*URL {
            const self = default_allocator.create(URL) catch return null;
            const backing = default_allocator.dupe(u8, value.byteSlice()) catch {
                default_allocator.destroy(self);
                return null;
            };
            self.* = .{ .backing = backing, .parsed = @import("url/url.zig").URL.parse(backing) };
            if (self.parsed.protocol.len == 0) {
                if (std.mem.indexOfScalar(u8, backing, ':')) |colon| {
                    const slash = std.mem.indexOfScalar(u8, backing, '/') orelse backing.len;
                    if (colon < slash) self.parsed.protocol = backing[0..colon];
                }
            }
            return self;
        }

        pub fn protocol(self: *URL) @import("string/string.zig").String {
            return @import("string/string.zig").String.init(self.parsed.protocol);
        }

        pub fn hostname(self: *URL) @import("string/string.zig").String {
            return @import("string/string.zig").String.init(self.parsed.hostname);
        }

        pub fn pathname(self: *URL) @import("string/string.zig").String {
            return @import("string/string.zig").String.init(self.parsed.pathname);
        }

        pub fn fragmentIdentifier(self: *URL) @import("string/string.zig").String {
            return @import("string/string.zig").String.init(std.mem.trimStart(u8, self.parsed.hash, "#"));
        }

        pub fn deinit(self: *URL) void {
            default_allocator.free(self.backing);
            default_allocator.destroy(self);
        }
    };
    pub const wtf = struct {
        pub fn releaseFastMallocFreeMemoryForThisThread() void {}

        pub fn parseDouble(value: []const u8) !f64 {
            return std.fmt.parseFloat(f64, value);
        }

        pub fn parseES5Date(value: []const u8) !f64 {
            return parseIso8601Milliseconds(value);
        }
    };
    pub const RuntimeTranspilerCache = struct {
        input_hash: ?u64 = null,

        pub fn get(_: *RuntimeTranspilerCache, _: anytype, _: anytype, _: bool) bool {
            return false;
        }

        pub fn put(_: *RuntimeTranspilerCache, _: []const u8, _: []const u8, _: []const u8) void {}
    };
    pub fn markBinding(_: std.builtin.SourceLocation) void {}
    pub const CachedBytecode = struct {
        pub fn isInstance(_: std.mem.Allocator) bool {
            return false;
        }

        pub fn generate(_: options.Format, _: []const u8, _: *String) ?struct { []const u8, *CachedBytecode } {
            return null;
        }

        pub fn deref(_: *CachedBytecode) void {}

        pub fn allocator(_: *CachedBytecode) std.mem.Allocator {
            return default_allocator;
        }
    };
    pub const WebCore = struct {
        pub const Blob = struct {
            pub const Store = opaque {};
        };
        pub const FileSink = struct {
            pub const Poll = struct {
                pub fn onPoll(_: *Poll, _: isize, _: bool) void {}
            };
        };
        pub const encoding = struct {
            pub fn toBunStringComptime(input: []const u8, comptime _: anytype) String {
                return String.init(input);
            }
        };
    };
    pub const Node = struct {
        pub fn Maybe(comptime Result: type, comptime Error: type) type {
            return union(enum) {
                err: Error,
                result: Result,

                pub const success: @This() = .{ .result = std.mem.zeroes(Result) };

                pub fn asErr(self: *const @This()) ?Error {
                    return switch (self.*) {
                        .err => |value| value,
                        .result => null,
                    };
                }

                pub fn asValue(self: *const @This()) ?Result {
                    return switch (self.*) {
                        .result => |value| value,
                        .err => null,
                    };
                }

                pub fn isErr(self: *const @This()) bool {
                    return self.* == .err;
                }

                pub fn isOk(self: *const @This()) bool {
                    return self.* == .result;
                }

                pub fn unwrapOr(self: @This(), default_value: Result) Result {
                    return switch (self) {
                        .result => |value| value,
                        .err => default_value,
                    };
                }
            };
        }
    };
    pub const ModuleLoader = struct {
        pub const HardcodedModule = @import("resolve_builtins/HardcodedModule.zig").HardcodedModule;
    };
};
pub const webcore = jsc.WebCore;

pub const bundle_v2 = @import("bundler/bundle_v2.zig");
pub const Loader = bundle_v2.Loader;

pub const http = @import("http/http.zig");
pub const HTTPThread = http.HTTPThread;
pub const LOLHTML = @import("lolhtml_sys/lol_html.zig");
pub const css = @import("css/css_parser.zig");

pub const md = @import("md/root.zig");

pub const transpiler = @import("bundler/transpiler.zig");
pub const Transpiler = transpiler.Transpiler;

pub const crash_handler = struct {
    pub const Action = union(enum) {
        parse: []const u8,
        visit: []const u8,
        print: []const u8,
        bundle_generate_chunk: struct {
            context: *const anyopaque,
            chunk: *const anyopaque,
            part_range: *const anyopaque,
        },
        resolver: struct {
            source_dir: []const u8,
            import_path: []const u8,
            kind: ImportKind,
        },
    };

    pub threadlocal var current_action: ?Action = null;

    pub const StoredTrace = struct {
        pub const empty: StoredTrace = .{};

        pub fn capture(_: usize) StoredTrace {
            return .{};
        }

        pub fn trace(_: StoredTrace) std.builtin.StackTrace {
            return .{ .instruction_addresses = &.{}, .index = 0 };
        }
    };

    pub fn dumpStackTrace(_: anytype, _: anytype) void {}
    pub fn dumpCurrentStackTrace(_: usize, _: anytype) void {}
};

pub const safety = struct {
    pub const alloc = struct {
        pub fn assertEq(_: std.mem.Allocator, _: std.mem.Allocator) void {}
    };

    pub const CheckedAllocator = struct {
        allocator: ?std.mem.Allocator = null,

        pub fn init(allocator: std.mem.Allocator) CheckedAllocator {
            return .{ .allocator = allocator };
        }

        pub fn set(self: *CheckedAllocator, allocator: std.mem.Allocator) void {
            self.allocator = allocator;
        }

        pub fn assertEq(_: CheckedAllocator, _: std.mem.Allocator) void {}
        pub fn transferOwnership(self: *CheckedAllocator, new_allocator: anytype) void {
            self.allocator = allocators.asStd(new_allocator);
        }
    };

    pub const ThreadLock = struct {
        pub fn initUnlocked() ThreadLock {
            return .{};
        }

        pub fn initLocked() ThreadLock {
            return .{};
        }

        pub fn initLockedIfNonComptime() ThreadLock {
            return .{};
        }

        pub fn lock(_: *ThreadLock) void {}
        pub fn unlock(_: *ThreadLock) void {}
        pub fn assertLocked(_: *const ThreadLock) void {}
        pub fn lockOrAssert(_: *ThreadLock) void {}
    };
};

pub const allocators = struct {
    pub const c_allocator = std.heap.page_allocator;
    pub const z_allocator = std.heap.page_allocator;
    pub const IndexType = packed struct(u32) {
        index: u31,
        is_overflow: bool = false,
    };
    pub const NotFound = IndexType{ .index = std.math.maxInt(u31) };
    pub const Unassigned = IndexType{ .index = std.math.maxInt(u31) - 1 };
    pub const ItemStatus = enum(u3) {
        unknown,
        not_found,
        exists,
    };

    pub fn isSliceInBufferT(comptime T: type, slice: []const T, buffer: []const T) bool {
        return @intFromPtr(buffer.ptr) <= @intFromPtr(slice.ptr) and
            @intFromPtr(slice.ptr) + slice.len * @sizeOf(T) <= @intFromPtr(buffer.ptr) + buffer.len * @sizeOf(T);
    }

    pub fn isSliceInBuffer(slice: []const u8, buffer: []const u8) bool {
        return allocators.isSliceInBufferT(u8, slice, buffer);
    }

    pub fn sliceRange(slice: []const u8, buffer: []const u8) ?[2]u32 {
        if (!allocators.isSliceInBuffer(slice, buffer)) return null;
        return .{
            @intCast(@intFromPtr(slice.ptr) - @intFromPtr(buffer.ptr)),
            @intCast(slice.len),
        };
    }
    pub const Result = struct {
        hash: u64,
        index: IndexType,
        status: ItemStatus,

        pub fn hasCheckedIfExists(self: *const Result) bool {
            return self.index.index != Unassigned.index;
        }

        pub fn isOverflowing(self: *const Result, comptime count: usize) bool {
            return self.index.index >= count;
        }
    };

    pub fn asStd(allocator: anytype) std.mem.Allocator {
        const T = @TypeOf(allocator);
        if (T == std.mem.Allocator) return allocator;
        switch (@typeInfo(T)) {
            .pointer => |pointer| if (@hasDecl(pointer.child, "allocator")) return allocator.allocator(),
            .@"struct", .@"union", .@"enum", .@"opaque" => if (@hasDecl(T, "allocator")) return allocator.allocator(),
            else => {},
        }
        return std.heap.page_allocator;
    }

    pub fn borrow(allocator: anytype) @TypeOf(allocator) {
        return allocator;
    }

    pub fn Borrowed(comptime Allocator: type) type {
        return Allocator;
    }

    pub fn BSSList(comptime ValueType: type, comptime _: anytype) type {
        return struct {
            const Self = @This();

            allocator: std.mem.Allocator,
            values: std.ArrayListUnmanaged(*ValueType) = .empty,
            mutex: Mutex = .{},

            pub var instance: *Self = undefined;
            var loaded = false;

            pub fn init(allocator: std.mem.Allocator) *Self {
                if (!loaded) {
                    instance = default_allocator.create(Self) catch outOfMemory();
                    instance.* = .{ .allocator = allocator };
                    loaded = true;
                }
                return instance;
            }

            pub fn deinit(self: *Self) void {
                for (self.values.items) |value| self.allocator.destroy(value);
                self.values.deinit(self.allocator);
                default_allocator.destroy(self);
                loaded = false;
            }

            pub fn isOverflowing() bool {
                return false;
            }

            pub fn append(self: *Self, value: ValueType) !*ValueType {
                self.mutex.lock();
                defer self.mutex.unlock();
                const owned = try self.allocator.create(ValueType);
                errdefer self.allocator.destroy(owned);
                owned.* = value;
                try self.values.append(self.allocator, owned);
                return owned;
            }

            pub const Pair = struct { index: IndexType, value: *ValueType };
        };
    }

    pub fn BSSStringList(comptime initial_capacity: usize, comptime expected_item_length: usize) type {
        return struct {
            const Self = @This();
            const TypeIdentity = struct {
                items: [initial_capacity]void,
                item: [expected_item_length]void,
            };

            allocator: std.mem.Allocator,
            values: std.ArrayListUnmanaged([]u8) = .empty,
            mutex: Mutex = .{},
            type_identity: ?*TypeIdentity = null,

            pub var instance: *Self = undefined;
            var loaded = false;

            pub fn init(allocator: std.mem.Allocator) *Self {
                if (!loaded) {
                    const value = default_allocator.create(Self) catch outOfMemory();
                    value.* = .{ .allocator = allocator };
                    instance = value;
                    loaded = true;
                }
                return instance;
            }

            pub fn deinit(self: *Self) void {
                for (self.values.items) |value| self.allocator.free(value);
                self.values.deinit(self.allocator);
                default_allocator.destroy(self);
                loaded = false;
            }

            pub fn isOverflowing() bool {
                return false;
            }

            pub fn exists(self: *const Self, value: []const u8) bool {
                for (self.values.items) |stored| {
                    const start = @intFromPtr(stored.ptr);
                    const pointer = @intFromPtr(value.ptr);
                    if (pointer >= start and pointer + value.len <= start + stored.len) return true;
                }
                return false;
            }

            pub fn editableSlice(value: []const u8) []u8 {
                return @constCast(value);
            }

            pub fn append(self: *Self, comptime AppendType: type, value: AppendType) ![]const u8 {
                self.mutex.lock();
                defer self.mutex.unlock();

                const is_byte_sequence = switch (@typeInfo(AppendType)) {
                    .array => |info| info.child == u8,
                    .pointer => |info| info.child == u8,
                    else => false,
                };
                const len = if (comptime is_byte_sequence) value.len else len: {
                    var total: usize = 0;
                    for (value) |part| total += part.len;
                    break :len total;
                };
                const owned = try self.allocator.alloc(u8, len);
                if (comptime is_byte_sequence) {
                    @memcpy(owned, value[0..]);
                } else {
                    var offset: usize = 0;
                    for (value) |part| {
                        @memcpy(owned[offset..][0..part.len], part);
                        offset += part.len;
                    }
                }
                try self.values.append(self.allocator, owned);
                return owned;
            }

            pub fn appendMutable(self: *Self, comptime AppendType: type, value: AppendType) ![]u8 {
                return @constCast(try self.append(AppendType, value));
            }

            pub fn getMutable(self: *Self, len: usize) ![]u8 {
                self.mutex.lock();
                defer self.mutex.unlock();
                const owned = try self.allocator.alloc(u8, len);
                try self.values.append(self.allocator, owned);
                return owned;
            }

            pub fn print(self: *Self, comptime format_string: []const u8, args: anytype) ![]const u8 {
                self.mutex.lock();
                defer self.mutex.unlock();
                const owned = try std.fmt.allocPrint(self.allocator, format_string, args);
                try self.values.append(self.allocator, owned);
                return owned;
            }

            pub fn appendLowerCase(self: *Self, comptime AppendType: type, value: AppendType) ![]const u8 {
                const result = try self.append(AppendType, value);
                for (@constCast(result)) |*byte| byte.* = std.ascii.toLower(byte.*);
                return result;
            }
        };
    }

    pub fn BSSMap(
        comptime ValueType: type,
        comptime count: anytype,
        comptime store_keys: bool,
        comptime estimated_key_length: usize,
        comptime remove_trailing_slashes: bool,
    ) type {
        _ = count;
        _ = estimated_key_length;

        const Base = struct {
            const Self = @This();

            allocator: std.mem.Allocator,
            indexes: std.AutoHashMapUnmanaged(u64, IndexType) = .empty,
            values_list: std.ArrayListUnmanaged(ValueType) = .empty,

            pub var instance: *Self = undefined;
            var loaded = false;

            fn normalize(key: []const u8) []const u8 {
                return if (comptime remove_trailing_slashes) std.mem.trimEnd(u8, key, std.fs.path.sep_str) else key;
            }

            pub fn init(allocator: std.mem.Allocator) *Self {
                if (!loaded) {
                    instance = default_allocator.create(Self) catch outOfMemory();
                    instance.* = .{ .allocator = allocator };
                    loaded = true;
                }
                return instance;
            }

            pub fn deinit(self: *Self) void {
                self.indexes.deinit(self.allocator);
                self.values_list.deinit(self.allocator);
                default_allocator.destroy(self);
                loaded = false;
            }

            pub fn isOverflowing() bool {
                return false;
            }

            pub fn getOrPut(self: *Self, denormalized_key: []const u8) !Result {
                const key = normalize(denormalized_key);
                const key_hash = std.hash.Wyhash.hash(0, key);
                if (self.indexes.get(key_hash)) |index| {
                    return .{ .hash = key_hash, .index = index, .status = .exists };
                }
                return .{ .hash = key_hash, .index = Unassigned, .status = .unknown };
            }

            pub fn get(self: *Self, denormalized_key: []const u8) ?*ValueType {
                const key = normalize(denormalized_key);
                const key_hash = std.hash.Wyhash.hash(0, key);
                const index = self.indexes.get(key_hash) orelse return null;
                return self.atIndex(index);
            }

            pub fn markNotFound(self: *Self, result: Result) void {
                self.indexes.put(self.allocator, result.hash, NotFound) catch outOfMemory();
            }

            pub fn atIndex(self: *Self, index: IndexType) ?*ValueType {
                if (index.index == NotFound.index or index.index == Unassigned.index) return null;
                if (index.index >= self.values_list.items.len) return null;
                return &self.values_list.items[index.index];
            }

            pub fn put(self: *Self, result: *Result, value: ValueType) !*ValueType {
                if (result.index.index == NotFound.index or result.index.index == Unassigned.index) {
                    result.index = .{ .index = @intCast(self.values_list.items.len) };
                    try self.values_list.append(self.allocator, value);
                } else if (result.index.index < self.values_list.items.len) {
                    self.values_list.items[result.index.index] = value;
                } else {
                    return error.OutOfMemory;
                }

                try self.indexes.put(self.allocator, result.hash, result.index);
                return &self.values_list.items[result.index.index];
            }

            pub fn remove(self: *Self, denormalized_key: []const u8) bool {
                const key = normalize(denormalized_key);
                return self.indexes.remove(std.hash.Wyhash.hash(0, key));
            }

            pub fn values(self: *Self) []ValueType {
                return self.values_list.items;
            }
        };

        if (!store_keys) return Base;

        return struct {
            const Self = @This();

            map: *Base,
            keys: std.ArrayListUnmanaged([]u8) = .empty,

            pub fn init(allocator: std.mem.Allocator) *Self {
                const self = allocator.create(Self) catch outOfMemory();
                self.* = .{ .map = Base.init(allocator) };
                return self;
            }

            pub fn deinit(self: *Self) void {
                for (self.keys.items) |key| self.map.allocator.free(key);
                self.keys.deinit(self.map.allocator);
                const allocator = self.map.allocator;
                self.map.deinit();
                allocator.destroy(self);
            }

            pub fn isOverflowing() bool {
                return false;
            }

            pub fn getOrPut(self: *Self, key: []const u8) !Result {
                return self.map.getOrPut(key);
            }

            pub fn get(self: *Self, key: []const u8) ?*ValueType {
                return self.map.get(key);
            }

            pub fn atIndex(self: *Self, index: IndexType) ?*ValueType {
                return self.map.atIndex(index);
            }

            pub fn keyAtIndex(self: *Self, index: IndexType) ?[]const u8 {
                if (index.index >= self.keys.items.len) return null;
                return self.keys.items[index.index];
            }

            pub fn put(self: *Self, key: []const u8, comptime store_key: bool, result: *Result, value: ValueType) !*ValueType {
                const value_ptr = try self.map.put(result, value);
                if (store_key) {
                    while (self.keys.items.len <= result.index.index) {
                        try self.keys.append(self.map.allocator, &.{});
                    }
                    self.keys.items[result.index.index] = try self.map.allocator.dupe(u8, key);
                }
                return value_ptr;
            }

            pub fn markNotFound(self: *Self, result: Result) void {
                self.map.markNotFound(result);
            }

            pub fn remove(self: *Self, key: []const u8) bool {
                return self.map.remove(key);
            }
        };
    }

    pub const allocation_scope = struct {
        pub const AllocationScope = struct {
            pub fn trackExternalFree(_: *AllocationScope, _: anytype, _: ?usize) !void {}
        };

        pub fn isInstance(_: std.mem.Allocator) bool {
            return false;
        }
    };

    pub const NullableAllocator = @import("bun_alloc/NullableAllocator.zig");

    pub const MimallocArena = struct {
        arena: std.heap.ArenaAllocator,

        pub const Borrowed = struct {
            value: std.mem.Allocator,

            pub fn allocator(self: @This()) std.mem.Allocator {
                return self.value;
            }

            pub fn downcast(allocator_value: std.mem.Allocator) @This() {
                return .{ .value = allocator_value };
            }
        };

        pub fn init() @This() {
            return .{ .arena = std.heap.ArenaAllocator.init(default_allocator) };
        }

        pub fn allocator(self: *@This()) std.mem.Allocator {
            return self.arena.allocator();
        }

        pub fn deinit(self: *@This()) void {
            self.arena.deinit();
        }

        pub fn helpCatchMemoryIssues(_: *@This()) void {}

        pub fn isInstance(allocator_value: std.mem.Allocator) bool {
            return allocator_value.vtable == &std.heap.ArenaAllocator.vtable;
        }
    };

    pub const MaxHeapAllocator = struct {
        pub fn isInstance(_: std.mem.Allocator) bool {
            return false;
        }
    };

    pub const LinuxMemFdAllocator = struct {
        pub fn isInstance(_: std.mem.Allocator) bool {
            return false;
        }
    };
};
pub const isSliceInBuffer = allocators.isSliceInBuffer;
pub const isSliceInBufferT = allocators.isSliceInBufferT;

pub const memory = struct {
    pub fn initDefault(comptime Allocator: type) Allocator {
        if (Allocator == std.mem.Allocator) return std.heap.page_allocator;
        return .{};
    }

    pub fn deinit(_: anytype) void {}

    pub fn destroy(allocator: std.mem.Allocator, pointer: anytype) void {
        allocator.destroy(pointer);
    }
};

pub const heap_breakdown = struct {
    pub const enabled = false;
    pub const Zone = struct {
        pub fn isInstance(_: std.mem.Allocator) bool {
            return false;
        }
    };
};

pub const perf = struct {
    pub const Ctx = struct {
        pub fn end(_: Ctx) void {}
    };

    pub fn trace(comptime _: [:0]const u8) Ctx {
        return .{};
    }
};

pub const sys = struct {
    pub const WindowsFileAttributes = struct {
        is_directory: bool,
        is_reparse_point: bool,
    };

    pub fn syslog(comptime format: []const u8, arguments: anytype) void {
        if (@import("builtin").mode == .Debug) std.debug.print(format ++ "\n", arguments);
    }

    pub const SystemErrno = enum(i32) {
        SUCCESS = 0,
        NOENT = 2,
        AGAIN = 11,
        _,
    };

    pub const Error = struct {
        errno: SystemErrno = .SUCCESS,
        syscall: []const u8 = "",
        path: []const u8 = "",
        /// The concrete zig error that produced this failure, when known.
        /// Preserved so callers (e.g. the resolver's directory cache) can
        /// distinguish a soft miss like `error.FileNotFound` from a real
        /// I/O failure instead of collapsing everything into
        /// `error.SystemError`, which escalated missing directories into
        /// fatal bundle errors.
        zig_error: anyerror = error.SystemError,

        pub fn fromZigErr(err_value: anyerror, syscall_name: []const u8, pathname: []const u8) Error {
            return .{
                .errno = if (err_value == error.FileNotFound) .NOENT else .SUCCESS,
                .syscall = syscall_name,
                .path = pathname,
                .zig_error = err_value,
            };
        }

        pub fn toSystemError(self: Error) Error {
            return self;
        }

        pub fn getErrno(self: Error) SystemErrno {
            return self.errno;
        }

        pub fn getErrorCodeTagName(self: *const Error) ?struct { [:0]const u8, SystemErrno } {
            if (self.errno == .SUCCESS) return null;
            return .{ @tagName(self.errno), self.errno };
        }

        pub fn format(self: Error, writer: *std.Io.Writer) std.Io.Writer.Error!void {
            if (self.path.len > 0) {
                try writer.print("{s}: {s} ({s})", .{ self.syscall, self.path, @tagName(self.errno) });
            } else {
                try writer.print("{s} ({s})", .{ self.syscall, @tagName(self.errno) });
            }
        }
    };

    pub const coreutils_error_map = struct {
        pub fn get(_: SystemErrno) ?[]const u8 {
            return null;
        }
    };

    pub const workaround_symbols = struct {
        pub const memmem = c.memmem;
    };

    pub fn SysMaybe(comptime Type: type) type {
        return union(enum) {
            result: Type,
            err: Error,

            pub fn unwrap(self: @This()) !Type {
                return switch (self) {
                    .result => |value| value,
                    .err => |e| e.zig_error,
                };
            }
        };
    }

    pub fn openA(pathname: []const u8, flags: i32, _: Mode) SysMaybe(FD) {
        const io_instance = std.Io.Threaded.global_single_threaded.io();
        if (flags & O.DIRECTORY != 0) {
            const directory = std.Io.Dir.cwd().openDir(io_instance, pathname, .{ .iterate = true }) catch |err| return .{ .err = .fromZigErr(err, "open", pathname) };
            return .{ .result = FD.fromStdDir(directory) };
        }
        const mode: std.Io.Dir.OpenFileOptions.Mode = if (flags & O.WRONLY != 0) .write_only else .read_only;
        const file = std.Io.Dir.cwd().openFile(io_instance, pathname, .{ .mode = mode }) catch |err| return .{ .err = .fromZigErr(err, "open", pathname) };
        return .{ .result = FD.fromStdFile(file) };
    }

    pub fn open(pathname: [:0]const u8, flags: i32, mode: Mode) SysMaybe(FD) {
        return openA(pathname, flags, mode);
    }

    pub fn openat(dirfd: FD, pathname: [:0]const u8, flags: i32, _: Mode) SysMaybe(FD) {
        const io_instance = std.Io.Threaded.global_single_threaded.io();
        if (flags & O.DIRECTORY != 0) {
            const directory = dirfd.stdDir().openDir(io_instance, pathname, .{ .iterate = true }) catch |err| return .{ .err = .fromZigErr(err, "openat", pathname) };
            return .{ .result = FD.fromStdDir(directory) };
        }
        const file = if (flags & O.CREAT != 0)
            dirfd.stdDir().createFile(io_instance, pathname, .{ .truncate = flags & O.TRUNC != 0 }) catch |err| return .{ .err = .fromZigErr(err, "openat", pathname) }
        else
            dirfd.stdDir().openFile(io_instance, pathname, .{ .mode = if (flags & O.WRONLY != 0) .write_only else .read_only }) catch |err| return .{ .err = .fromZigErr(err, "openat", pathname) };
        return .{ .result = FD.fromStdFile(file) };
    }

    pub fn openDirAtWindowsA(dirfd: FD, pathname: []const u8, open_options_input: anytype) SysMaybe(FD) {
        const io_instance = std.Io.Threaded.global_single_threaded.io();
        const follow_symlinks = if (@hasField(@TypeOf(open_options_input), "no_follow")) !open_options_input.no_follow else true;
        const open_options: std.Io.Dir.OpenOptions = .{
            .iterate = if (@hasField(@TypeOf(open_options_input), "iterable")) open_options_input.iterable else false,
            .follow_symlinks = follow_symlinks,
        };
        const directory = if (dirfd.isValid())
            dirfd.stdDir().openDir(io_instance, pathname, open_options)
        else
            std.Io.Dir.openDirAbsolute(io_instance, pathname, open_options);
        return .{ .result = FD.fromStdDir(directory catch |err| return .{ .err = .fromZigErr(err, "open", pathname) }) };
    }

    pub fn renameat(from_dir: FD, from: [:0]const u8, to_dir: FD, to: [:0]const u8) SysMaybe(void) {
        std.Io.Dir.rename(from_dir.stdDir(), from, to_dir.stdDir(), to, std.Io.Threaded.global_single_threaded.io()) catch
            return .{ .err = .{ .path = from, .syscall = "renameat" } };
        return .{ .result = {} };
    }

    pub fn exists(pathname: []const u8) bool {
        std.Io.Dir.cwd().access(std.Io.Threaded.global_single_threaded.io(), pathname, .{}) catch return false;
        return true;
    }

    pub fn existsZ(pathname: [:0]const u8) bool {
        return exists(pathname);
    }

    pub fn getFileAttributes(pathname: anytype) ?WindowsFileAttributes {
        const path_slice = std.mem.sliceTo(pathname, 0);
        const stat_value = std.Io.Dir.cwd().statFile(
            std.Io.Threaded.global_single_threaded.io(),
            path_slice,
            .{ .follow_symlinks = false },
        ) catch return null;
        return .{
            .is_directory = stat_value.kind == .directory,
            .is_reparse_point = stat_value.kind == .sym_link,
        };
    }

    pub fn getErrno(result: anytype) SystemErrno {
        if (result == 0) return .SUCCESS;
        if (comptime Environment.isPosix) {
            return @enumFromInt(@intFromEnum(std.posix.errno(result)));
        }
        return @enumFromInt(1);
    }

    pub const File = struct {
        handle: FD = .invalid,

        pub fn readFrom(_: FD, pathname: []const u8, allocator: std.mem.Allocator) SysMaybe([]u8) {
            const bytes = std.Io.Dir.cwd().readFileAlloc(
                std.Io.Threaded.global_single_threaded.io(),
                pathname,
                allocator,
                .unlimited,
            ) catch return .{ .err = .{ .errno = .NOENT, .path = pathname } };
            return .{ .result = bytes };
        }

        pub fn readFillBuf(self: File, buffer: []u8) SysMaybe([]u8) {
            const count = std.Io.File.readStreaming(
                self.handle.stdFile(),
                std.Io.Threaded.global_single_threaded.io(),
                &.{buffer},
            ) catch return .{ .err = .{} };
            return .{ .result = buffer[0..count] };
        }
    };

    pub fn stat(pathname: [:0]const u8) SysMaybe(Stat) {
        const value = std.Io.Dir.cwd().statFile(
            std.Io.Threaded.global_single_threaded.io(),
            pathname,
            .{},
        ) catch return .{ .err = .{ .errno = .NOENT, .path = pathname } };
        return .{ .result = value };
    }
};

pub const Mode = u32;
pub const O = struct {
    pub const RDONLY: i32 = 0;
    pub const WRONLY: i32 = 1 << 0;
    pub const CREAT: i32 = 1 << 1;
    pub const TRUNC: i32 = 1 << 2;
    pub const DIRECTORY: i32 = 1 << 3;
    pub const CLOEXEC: i32 = 1 << 4;
};

pub const NullableAllocator = allocators.NullableAllocator;
pub const MimallocArena = allocators.MimallocArena;

pub const StackCheck = struct {
    cached_stack_end: usize = 0,

    pub fn configureThread() void {}

    pub fn init() StackCheck {
        return .{};
    }

    pub fn update(_: *StackCheck) void {}

    pub fn isSafeToRecurse(_: StackCheck) bool {
        return true;
    }
};

pub const mimalloc = struct {
    extern fn malloc(size: usize) ?*anyopaque;
    extern fn calloc(count: usize, size: usize) ?*anyopaque;
    extern fn free(ptr: ?*anyopaque) void;
    extern fn malloc_size(ptr: ?*const anyopaque) usize;
    extern fn malloc_usable_size(ptr: ?*const anyopaque) usize;
    extern fn _msize(ptr: ?*const anyopaque) usize;

    pub fn mi_malloc(size: usize) ?*anyopaque {
        return malloc(size);
    }

    pub fn mi_calloc(count: usize, size: usize) ?*anyopaque {
        return calloc(count, size);
    }

    pub fn mi_usable_size(pointer: ?*const anyopaque) usize {
        return switch (@import("builtin").os.tag) {
            .macos => malloc_size(pointer),
            .windows => _msize(pointer),
            else => malloc_usable_size(pointer),
        };
    }

    pub fn mi_is_in_heap_region(_: anytype) bool {
        return false;
    }

    pub fn mi_check_owned(_: anytype) bool {
        return false;
    }

    pub fn mi_free(pointer: *anyopaque) void {
        free(pointer);
    }

    pub fn mi_thread_set_in_threadpool() void {}
};

pub const Global = struct {
    pub const user_agent = "Cottontail";

    pub fn mimalloc_cleanup(_: bool) void {}

    pub fn crash() noreturn {
        @panic("fatal compiler error");
    }
};

pub const bake = struct {
    pub const DevServer = struct {
        allocator_value: std.mem.Allocator = default_allocator,
        barrel_files_with_deferrals: StringArrayHashMapUnmanaged(void) = .empty,
        barrel_needed_exports: StringArrayHashMapUnmanaged(StringHashMapUnmanaged(void)) = .empty,

        pub fn allocator(self: *DevServer) std.mem.Allocator {
            return self.allocator_value;
        }
    };
    pub const Side = enum(u1) { client, server };
    pub const Graph = enum(u2) { client, server, ssr };
    pub const HmrRuntime = struct {
        code: [:0]const u8,
        line_count: u32,
    };

    pub fn getHmrRuntime(_: Side) HmrRuntime {
        unreachable;
    }

    pub const Framework = struct {
        is_built_in_react: bool = false,
        server_components: ?ServerComponents = null,
        react_fast_refresh: ?ReactFastRefresh = null,
        built_in_modules: StringArrayHashMapUnmanaged(BuiltInModule) = .empty,

        pub const BuiltInModule = union(enum) {
            import: []const u8,
            code: []const u8,
        };

        pub const ServerComponents = struct {
            server_runtime_import: []const u8 = "",
            server_register_client_reference: []const u8 = "",
            server_register_server_reference: []const u8 = "",
            separate_ssr_graph: bool = true,
        };

        pub const ReactFastRefresh = struct {
            import_source: []const u8 = "react-refresh/runtime",
        };
    };

    pub const server_virtual_source = logger.Source.initPathString("bun:bake/server", "");
    pub const client_virtual_source = logger.Source.initPathString("bun:bake/client", "");
};

pub fn DebugOnlyDisabler(comptime Type: type) type {
    return struct {
        threadlocal var disable_create_in_debug: if (Environment.isDebug) usize else u0 = 0;

        pub inline fn disable() void {
            if (comptime !Environment.isDebug) return;
            disable_create_in_debug += 1;
        }

        pub inline fn enable() void {
            if (comptime !Environment.isDebug) return;
            disable_create_in_debug -= 1;
        }

        pub inline fn assert() void {
            if (comptime !Environment.isDebug) return;
            if (disable_create_in_debug > 0) {
                Output.panic(comptime "[" ++ @typeName(Type) ++ "] called while disabled", .{});
            }
        }
    };
}

pub const StackOverflow = error{StackOverflow};

pub noinline fn throwStackOverflow() StackOverflow!void {
    @branchHint(.cold);
    return error.StackOverflow;
}

pub const collections = @import("collections/collections.zig");
pub const MultiArrayList = collections.MultiArrayList;
pub const BabyList = collections.BabyList;
pub const ByteList = collections.ByteList;
pub const OffsetByteList = collections.OffsetByteList;
pub const bit_set = collections.bit_set;
pub const HiveArray = collections.HiveArray;
pub const BoundedArray = collections.BoundedArray;
pub const ObjectPool = @import("collections/pool.zig").ObjectPool;
pub const LinearFifo = @import("collections/linear_fifo.zig").LinearFifo;

pub const comptime_string_map = @import("collections/comptime_string_map.zig");
pub const ComptimeStringMap = comptime_string_map.ComptimeStringMap;
pub const ComptimeStringMap16 = comptime_string_map.ComptimeStringMap16;
pub const ComptimeStringMapWithKeyType = comptime_string_map.ComptimeStringMapWithKeyType;

pub fn ComptimeEnumMap(comptime T: type) type {
    var entries: [std.enums.values(T).len]struct { [:0]const u8, T } = undefined;
    for (std.enums.values(T), &entries) |value, *entry| {
        entry.* = .{ .@"0" = @tagName(value), .@"1" = value };
    }
    return ComptimeStringMap(T, entries);
}

pub const Output = struct {
    pub var enable_ansi_colors_stderr = false;
    pub var enable_ansi_colors_stdout = false;

    pub const Source = struct {
        pub fn configureThread() void {}
        pub fn configureNamedThread(_: [:0]const u8) void {}
    };

    var output_buffer: [4096]u8 = undefined;
    var output_writer: std.Io.Writer = std.Io.Writer.fixed(&output_buffer);

    pub const color_map = struct {
        pub fn get(_: @This(), comptime _: []const u8) ?[]const u8 {
            return "";
        }
    }{};

    pub fn prettyFmt(comptime fmt_text: []const u8, comptime _: bool) []const u8 {
        return fmt_text;
    }

    pub fn writer() *std.Io.Writer {
        output_writer.end = 0;
        return &output_writer;
    }

    pub fn errorWriter() *std.Io.Writer {
        return writer();
    }

    pub fn flush() void {}
    pub fn initTest() void {}

    pub fn print(comptime fmt_text: []const u8, args: anytype) void {
        std.debug.print(fmt_text, args);
    }

    pub fn printErrorln(comptime fmt_text: []const u8, args: anytype) void {
        std.debug.print(fmt_text ++ "\n", args);
    }

    pub fn prettyError(comptime fmt_text: []const u8, args: anytype) void {
        std.debug.print(fmt_text, args);
    }

    pub fn prettyErrorln(comptime fmt_text: []const u8, args: anytype) void {
        std.debug.print(fmt_text ++ "\n", args);
    }

    pub fn printError(comptime fmt_text: []const u8, args: anytype) void {
        std.debug.print(fmt_text, args);
    }

    pub fn warn(comptime fmt_text: []const u8, args: anytype) void {
        std.debug.print(fmt_text ++ "\n", args);
    }

    pub fn debugWarn(comptime fmt_text: []const u8, args: anytype) void {
        std.debug.print(fmt_text ++ "\n", args);
    }

    pub fn err(_: anytype, comptime fmt_text: []const u8, args: anytype) void {
        std.debug.print(fmt_text ++ "\n", args);
    }

    pub fn printElapsed(elapsed: f64) void {
        if (elapsed <= 1500.0) {
            std.debug.print("[{d:.2}ms]", .{elapsed});
        } else {
            std.debug.print("[{d:.2}s]", .{elapsed / 1000.0});
        }
    }

    pub fn note(comptime fmt_text: []const u8, args: anytype) void {
        std.debug.print(fmt_text ++ "\n", args);
    }

    pub fn prettyln(comptime fmt_text: []const u8, args: anytype) void {
        std.debug.print(fmt_text ++ "\n", args);
    }

    pub fn debug(comptime fmt_text: []const u8, args: anytype) void {
        if (@import("builtin").mode == .Debug) std.debug.print(fmt_text, args);
    }

    pub fn errGeneric(comptime fmt_text: []const u8, args: anytype) void {
        std.debug.print(fmt_text ++ "\n", args);
    }

    pub fn panic(comptime fmt_text: []const u8, args: anytype) noreturn {
        std.debug.panic(fmt_text, args);
    }

    fn scopedNoop(comptime _: []const u8, _: anytype) void {}

    pub fn scoped(_: anytype, _: anytype) @TypeOf(scopedNoop) {
        return scopedNoop;
    }

    pub fn Scoped(comptime _: anytype, comptime _: anytype) type {
        return struct {
            pub fn isVisible() bool {
                return false;
            }

            pub fn log(comptime _: []const u8, _: anytype) void {}
        };
    }
};
pub const FeatureFlags = @import("bun_core/feature_flags.zig");
pub const fmt = @import("bun_core/fmt.zig");
pub const env_var = @import("bun_core/env_var.zig");
pub const feature_flag = env_var.feature_flag;
pub const logger = @import("logger/logger.zig");
pub const meta = @import("meta/meta.zig");
pub const bits = @import("meta/bits.zig");
pub const schema = @import("options_types/schema.zig");
pub const api = struct {
    pub const server = struct {
        pub const ServerConfig = struct {
            pub const SSLConfig = @import("runtime/socket/SSLConfig.zig");
        };
    };
    pub const Timer = struct {
        pub const EventLoopTimer = struct {
            next: timespec = .epoch,
            state: enum { PENDING, ACTIVE, CANCELLED, FIRED } = .PENDING,
            tag: enum { UpgradedDuplex } = .UpgradedDuplex,
            heap: io.heap.IntrusiveField(@This()) = .{},
        };
    };
};
pub const brotli = @import("brotli/brotli.zig");
pub const zstd = @import("zstd/zstd.zig");
pub const BoringSSL = @import("boringssl/boringssl.zig");
pub const libdeflate = @import("libdeflate_sys/libdeflate.zig");
pub const io = struct {
    pub const heap = @import("io/heap.zig");
    pub const StreamBuffer = @import("io/PipeWriter.zig").StreamBuffer;
    pub const BufferedReader = @import("io/PipeReader.zig").BufferedReader;
};
pub const spawn = @import("runtime/api/bun/spawn.zig").PosixSpawn;
pub const SignalCode = @import("sys/SignalCode.zig").SignalCode;

pub fn span(pointer: anytype) @TypeOf(std.mem.span(pointer)) {
    return std.mem.span(pointer);
}

pub fn asByteSlice(value: anytype) []const u8 {
    return std.mem.span(value);
}

pub fn fastRandom() u64 {
    return @truncate(@as(u128, @bitCast(nanoTimestamp())));
}

fn parseDateDigits(value: []const u8, start: usize, count: usize) !i64 {
    if (start + count > value.len) return error.InvalidDate;
    var result: i64 = 0;
    for (value[start .. start + count]) |character| {
        if (character < '0' or character > '9') return error.InvalidDate;
        result = result * 10 + character - '0';
    }
    return result;
}

fn daysFromCivil(year_input: i64, month: i64, day: i64) i64 {
    const year = year_input - @intFromBool(month <= 2);
    const era = @divFloor(year, 400);
    const year_of_era = year - era * 400;
    const shifted_month = month + (if (month > 2) @as(i64, -3) else 9);
    const day_of_year = @divFloor(153 * shifted_month + 2, 5) + day - 1;
    const day_of_era = year_of_era * 365 + @divFloor(year_of_era, 4) - @divFloor(year_of_era, 100) + day_of_year;
    return era * 146097 + day_of_era - 719468;
}

fn parseIso8601Milliseconds(value: []const u8) !f64 {
    if (value.len < 20 or value[4] != '-' or value[7] != '-' or
        (value[10] != 'T' and value[10] != 't' and value[10] != ' ') or
        value[13] != ':' or value[16] != ':') return error.InvalidDate;

    const year = try parseDateDigits(value, 0, 4);
    const month = try parseDateDigits(value, 5, 2);
    const day = try parseDateDigits(value, 8, 2);
    const hour = try parseDateDigits(value, 11, 2);
    const minute = try parseDateDigits(value, 14, 2);
    const second = try parseDateDigits(value, 17, 2);
    if (month < 1 or month > 12 or day < 1 or day > 31 or hour > 23 or minute > 59 or second > 59) return error.InvalidDate;

    var index: usize = 19;
    var milliseconds: i64 = 0;
    if (index < value.len and value[index] == '.') {
        index += 1;
        var digits: usize = 0;
        while (index < value.len and value[index] >= '0' and value[index] <= '9') : (index += 1) {
            if (digits < 3) milliseconds = milliseconds * 10 + value[index] - '0';
            digits += 1;
        }
        if (digits == 0) return error.InvalidDate;
        while (digits < 3) : (digits += 1) milliseconds *= 10;
    }

    var timezone_offset_minutes: i64 = 0;
    if (index >= value.len) return error.InvalidDate;
    if (value[index] == 'Z' or value[index] == 'z') {
        index += 1;
    } else if (value[index] == '+' or value[index] == '-') {
        const sign: i64 = if (value[index] == '+') 1 else -1;
        index += 1;
        const timezone_hour = try parseDateDigits(value, index, 2);
        index += 2;
        if (index < value.len and value[index] == ':') index += 1;
        const timezone_minute = try parseDateDigits(value, index, 2);
        index += 2;
        if (timezone_hour > 23 or timezone_minute > 59) return error.InvalidDate;
        timezone_offset_minutes = sign * (timezone_hour * 60 + timezone_minute);
    } else return error.InvalidDate;
    if (index != value.len) return error.InvalidDate;

    const seconds_since_epoch = daysFromCivil(year, month, day) * std.time.s_per_day +
        hour * std.time.s_per_hour + minute * std.time.s_per_min + second - timezone_offset_minutes * std.time.s_per_min;
    return @floatFromInt(seconds_since_epoch * std.time.ms_per_s + milliseconds);
}

pub fn serializable(input: anytype) @TypeOf(input) {
    return input;
}

pub inline fn serializableInto(comptime T: type, init_value: anytype) T {
    var bytes: [@sizeOf(T)]u8 align(@alignOf(T)) = std.mem.zeroes([@sizeOf(T)]u8);
    const result: *T = @ptrCast(&bytes);
    inline for (comptime std.meta.fieldNames(@TypeOf(init_value))) |field_name| {
        @field(result, field_name) = @field(init_value, field_name);
    }
    return result.*;
}

pub fn errnoToZigErr(err: anytype) anyerror {
    const number: i32 = if (@typeInfo(@TypeOf(err)) == .@"enum") @intFromEnum(err) else @intCast(err);
    return switch (@abs(number)) {
        2 => error.FileNotFound,
        11 => error.WouldBlock,
        13 => error.AccessDenied,
        17 => error.PathAlreadyExists,
        20 => error.NotDir,
        21 => error.IsDir,
        28 => error.NoSpaceLeft,
        else => error.Unexpected,
    };
}

pub const timespec = extern struct {
    sec: i64 = 0,
    nsec: i64 = 0,

    pub const epoch: timespec = .{};

    pub fn ns(self: timespec) u64 {
        return @intCast(@max(0, self.sec * std.time.ns_per_s + self.nsec));
    }

    pub fn msFromNow(comptime _: anytype, interval: i64) timespec {
        const now_ns = std.Io.Clock.awake.now(std.Io.Threaded.global_single_threaded.io()).nanoseconds;
        const target = now_ns + interval * std.time.ns_per_ms;
        return .{
            .sec = @intCast(@divFloor(target, std.time.ns_per_s)),
            .nsec = @intCast(@mod(target, std.time.ns_per_s)),
        };
    }
};
pub const options = @import("bundler/options.zig");
pub const defines = @import("bundler/defines.zig");
pub const Define = defines.Define;
pub const json = @import("interchange/json.zig");
pub const interchange = @import("interchange/interchange.zig");
pub const ImportRecord = @import("options_types/import_record.zig").ImportRecord;
pub const ImportKind = @import("options_types/import_record.zig").ImportKind;
pub const SourceMap = @import("sourcemap/sourcemap.zig");
pub const resolver = @import("resolver/resolver.zig");
pub const fs = @import("resolver/fs.zig");
pub const path = @import("paths/resolve_path.zig");
pub const paths = @import("paths/paths.zig");
pub const MAX_PATH_BYTES = paths.MAX_PATH_BYTES;
pub const PathBuffer = paths.PathBuffer;
pub const WPathBuffer = paths.WPathBuffer;
pub const OSPathBuffer = paths.OSPathBuffer;
pub const path_buffer_pool = paths.path_buffer_pool;
pub const w_path_buffer_pool = paths.w_path_buffer_pool;
pub const os_path_buffer_pool = paths.os_path_buffer_pool;

pub fn threadLocalAllocator() std.mem.Allocator {
    return default_allocator;
}

pub inline fn pathLiteral(comptime literal: anytype) *const [literal.len:0]u8 {
    if (!Environment.isWindows) return @ptrCast(literal);
    return comptime {
        var buffer: [literal.len:0]u8 = undefined;
        for (literal, 0..) |char, index| buffer[index] = if (char == '/') '\\' else char;
        buffer[buffer.len] = 0;
        const final = buffer[0..buffer.len :0].*;
        return &final;
    };
}
pub const StringHashMapContext = struct {
    pub fn hash(_: @This(), s: []const u8) u64 {
        return std.hash.Wyhash.hash(0, s);
    }

    pub fn eql(_: @This(), a: []const u8, b: []const u8) bool {
        return strings.eqlLong(a, b, true);
    }

    pub fn pre(input: []const u8) Prehashed {
        return .{ .value = StringHashMapContext.hash(.{}, input), .input = input };
    }

    pub const Prehashed = struct {
        value: u64,
        input: []const u8,

        pub fn hash(self: @This(), s: []const u8) u64 {
            if (s.ptr == self.input.ptr and s.len == self.input.len) return self.value;
            return StringHashMapContext.hash(.{}, s);
        }

        pub fn eql(_: @This(), a: []const u8, b: []const u8) bool {
            return strings.eqlLong(a, b, true);
        }
    };

    pub const PrehashedCaseInsensitive = struct {
        value: u64,
        input: []const u8,

        pub fn init(allocator: std.mem.Allocator, input: []const u8) PrehashedCaseInsensitive {
            const lowercase = allocator.alloc(u8, input.len) catch outOfMemory();
            _ = strings.copyLowercase(input, lowercase);
            return .{
                .value = StringHashMapContext.hash(.{}, lowercase),
                .input = lowercase,
            };
        }

        pub fn deinit(self: PrehashedCaseInsensitive, allocator: std.mem.Allocator) void {
            allocator.free(self.input);
        }

        pub fn hash(self: PrehashedCaseInsensitive, value: []const u8) u64 {
            if (value.ptr == self.input.ptr and value.len == self.input.len) return self.value;
            return StringHashMapContext.hash(.{}, value);
        }

        pub fn eql(_: PrehashedCaseInsensitive, a: []const u8, b: []const u8) bool {
            return strings.eqlCaseInsensitiveASCIIICheckLength(a, b);
        }
    };
};

pub fn StringHashMap(comptime Type: type) type {
    return std.HashMap([]const u8, Type, StringHashMapContext, std.hash_map.default_max_load_percentage);
}

pub fn StringHashMapUnmanaged(comptime Type: type) type {
    return std.HashMapUnmanaged([]const u8, Type, StringHashMapContext, std.hash_map.default_max_load_percentage);
}

pub const StringHashMapUnowned = struct {
    pub const Key = struct {
        hash: u64,
        len: usize,

        pub fn init(value: []const u8) Key {
            return .{ .hash = rootHash(value), .len = value.len };
        }

        fn rootHash(value: []const u8) u64 {
            return std.hash.Wyhash.hash(0, value);
        }
    };

    pub const Adapter = struct {
        pub fn eql(_: Adapter, a: Key, b: Key) bool {
            return a.hash == b.hash and a.len == b.len;
        }

        pub fn hash(_: Adapter, key: Key) u64 {
            return key.hash;
        }
    };
};

pub const install = @import("install/install.zig");
pub const PackageManager = install.PackageManager;

pub fn StringArrayHashMap(comptime Type: type) type {
    return ManagedStringArrayHashMap(Type, std.StringArrayHashMapUnmanaged(Type));
}

fn ManagedStringArrayHashMap(comptime Type: type, comptime UnmanagedType: type) type {
    return struct {
        unmanaged: Unmanaged = .empty,
        allocator: std.mem.Allocator,

        pub const Unmanaged = UnmanagedType;
        pub const Entry = Unmanaged.Entry;
        pub const Iterator = Unmanaged.Iterator;

        pub fn init(allocator: std.mem.Allocator) @This() {
            return .{ .allocator = allocator };
        }

        pub fn initContext(allocator: std.mem.Allocator, _: anytype) @This() {
            return init(allocator);
        }

        pub fn deinit(self: *@This()) void {
            self.unmanaged.deinit(self.allocator);
        }

        pub fn clearAndFree(self: *@This()) void {
            self.unmanaged.clearAndFree(self.allocator);
        }

        pub fn clearRetainingCapacity(self: *@This()) void {
            self.unmanaged.clearRetainingCapacity();
        }

        pub fn count(self: @This()) usize {
            return self.unmanaged.count();
        }

        pub fn capacity(self: @This()) usize {
            return self.unmanaged.capacity();
        }

        pub fn keys(self: @This()) []const []const u8 {
            return self.unmanaged.keys();
        }

        pub fn values(self: @This()) []Type {
            return self.unmanaged.values();
        }

        pub fn iterator(self: @This()) Iterator {
            return self.unmanaged.iterator();
        }

        pub fn ensureTotalCapacity(self: *@This(), new_capacity: usize) !void {
            return self.unmanaged.ensureTotalCapacity(self.allocator, new_capacity);
        }

        pub fn ensureUnusedCapacity(self: *@This(), additional_capacity: usize) !void {
            return self.unmanaged.ensureUnusedCapacity(self.allocator, additional_capacity);
        }

        pub fn shrinkAndFree(self: *@This(), new_len: usize) void {
            self.unmanaged.shrinkAndFree(self.allocator, new_len);
        }

        pub fn putAssumeCapacity(self: *@This(), key: []const u8, value: Type) void {
            self.unmanaged.putAssumeCapacity(key, value);
        }

        pub fn put(self: *@This(), key: []const u8, value: Type) !void {
            return self.unmanaged.put(self.allocator, key, value);
        }

        pub fn getOrPut(self: *@This(), key: []const u8) !Unmanaged.GetOrPutResult {
            return self.unmanaged.getOrPut(self.allocator, key);
        }

        pub fn getOrPutValue(self: *@This(), key: []const u8, value: Type) !Unmanaged.GetOrPutResult {
            return self.unmanaged.getOrPutValue(self.allocator, key, value);
        }

        pub fn sort(self: *@This(), context: anytype) void {
            self.unmanaged.entries.sort(context);
            handleOom(self.unmanaged.reIndex(self.allocator));
        }

        pub fn get(self: @This(), key: []const u8) ?Type {
            return self.unmanaged.get(key);
        }

        pub fn getPtr(self: @This(), key: []const u8) ?*Type {
            return self.unmanaged.getPtr(key);
        }

        pub fn getIndex(self: @This(), key: []const u8) ?usize {
            return self.unmanaged.getIndex(key);
        }

        pub fn getEntry(self: @This(), key: []const u8) ?Entry {
            return self.unmanaged.getEntry(key);
        }

        pub fn getKey(self: @This(), key: []const u8) ?[]const u8 {
            return self.unmanaged.getKey(key);
        }

        pub fn getKeyPtr(self: @This(), key: []const u8) ?*[]const u8 {
            return self.unmanaged.getKeyPtr(key);
        }

        pub fn contains(self: @This(), key: []const u8) bool {
            return self.unmanaged.contains(key);
        }

        pub fn swapRemove(self: *@This(), key: []const u8) bool {
            return self.unmanaged.swapRemove(key);
        }

        pub fn fetchSwapRemove(self: *@This(), key: []const u8) ?Unmanaged.KV {
            return self.unmanaged.fetchSwapRemove(key);
        }

        pub fn orderedRemove(self: *@This(), key: []const u8) bool {
            return self.unmanaged.orderedRemove(key);
        }

        pub fn clone(self: @This()) !@This() {
            return .{
                .unmanaged = try self.unmanaged.clone(self.allocator),
                .allocator = self.allocator,
            };
        }
    };
}

pub const CaseInsensitiveASCIIStringContext = struct {
    pub fn hash(_: @This(), input: []const u8) u32 {
        var buffer: [1024]u8 = undefined;
        var remaining = input;
        var hasher = std.hash.Wyhash.init(0);
        while (remaining.len > 0) {
            const length = @min(remaining.len, buffer.len);
            hasher.update(strings.copyLowercase(remaining[0..length], &buffer));
            remaining = remaining[length..];
        }
        return @truncate(hasher.final());
    }

    pub fn eql(_: @This(), a: []const u8, b: []const u8, _: usize) bool {
        return strings.eqlCaseInsensitiveASCIIICheckLength(a, b);
    }
};

pub fn CaseInsensitiveASCIIStringArrayHashMap(comptime Type: type) type {
    const Unmanaged = std.array_hash_map.Custom([]const u8, Type, CaseInsensitiveASCIIStringContext, true);
    return ManagedStringArrayHashMap(Type, Unmanaged);
}

pub fn StringArrayHashMapUnmanaged(comptime Type: type) type {
    return std.StringArrayHashMapUnmanaged(Type);
}

pub const StringMap = struct {
    map: StringArrayHashMap([]const u8),
    dupe_keys: bool = false,

    pub fn init(allocator: std.mem.Allocator, dupe_keys: bool) StringMap {
        return .{ .map = StringArrayHashMap([]const u8).init(allocator), .dupe_keys = dupe_keys };
    }

    pub fn clone(self: StringMap) !StringMap {
        return .{ .map = try self.map.clone(), .dupe_keys = self.dupe_keys };
    }

    pub fn keys(self: StringMap) []const []const u8 {
        return self.map.keys();
    }

    pub fn values(self: StringMap) []const []const u8 {
        return self.map.values();
    }

    pub fn count(self: StringMap) usize {
        return self.map.count();
    }

    pub fn insert(self: *StringMap, key: []const u8, value: []const u8) !void {
        const entry = try self.map.getOrPut(key);
        if (!entry.found_existing) {
            if (self.dupe_keys) entry.key_ptr.* = try self.map.allocator.dupe(u8, key);
        } else {
            self.map.allocator.free(entry.value_ptr.*);
        }
        entry.value_ptr.* = try self.map.allocator.dupe(u8, value);
    }

    pub const put = insert;

    pub fn get(self: *const StringMap, key: []const u8) ?[]const u8 {
        return self.map.get(key);
    }

    pub fn sort(self: *StringMap, context: anytype) void {
        self.map.sort(context);
    }

    pub fn deinit(self: *StringMap) void {
        for (self.map.values()) |value| self.map.allocator.free(value);
        if (self.dupe_keys) {
            for (self.map.keys()) |key| self.map.allocator.free(key);
        }
        self.map.deinit();
    }
};

pub fn AutoArrayHashMap(comptime Key: type, comptime Value: type) type {
    return struct {
        unmanaged: Unmanaged = .empty,
        allocator: std.mem.Allocator,

        pub const Unmanaged = std.AutoArrayHashMapUnmanaged(Key, Value);
        pub const Entry = Unmanaged.Entry;
        pub const Iterator = Unmanaged.Iterator;

        pub fn init(allocator: std.mem.Allocator) @This() {
            return .{ .allocator = allocator };
        }

        pub fn deinit(self: *@This()) void {
            self.unmanaged.deinit(self.allocator);
        }

        pub fn clearAndFree(self: *@This()) void {
            self.unmanaged.clearAndFree(self.allocator);
        }

        pub fn clearRetainingCapacity(self: *@This()) void {
            self.unmanaged.clearRetainingCapacity();
        }

        pub fn count(self: @This()) usize {
            return self.unmanaged.count();
        }

        pub fn capacity(self: @This()) usize {
            return self.unmanaged.capacity();
        }

        pub fn keys(self: @This()) []Key {
            return self.unmanaged.keys();
        }

        pub fn values(self: @This()) []Value {
            return self.unmanaged.values();
        }

        pub fn iterator(self: @This()) Iterator {
            return self.unmanaged.iterator();
        }

        pub fn ensureTotalCapacity(self: *@This(), new_capacity: usize) !void {
            return self.unmanaged.ensureTotalCapacity(self.allocator, new_capacity);
        }

        pub fn ensureUnusedCapacity(self: *@This(), additional_capacity: usize) !void {
            return self.unmanaged.ensureUnusedCapacity(self.allocator, additional_capacity);
        }

        pub fn shrinkAndFree(self: *@This(), new_len: usize) void {
            self.unmanaged.shrinkAndFree(self.allocator, new_len);
        }

        pub fn putAssumeCapacity(self: *@This(), key: Key, value: Value) void {
            self.unmanaged.putAssumeCapacity(key, value);
        }

        pub fn putNoClobber(self: *@This(), key: Key, value: Value) !void {
            return self.unmanaged.putNoClobber(self.allocator, key, value);
        }

        pub fn put(self: *@This(), key: Key, value: Value) !void {
            return self.unmanaged.put(self.allocator, key, value);
        }

        pub fn getOrPut(self: *@This(), key: Key) !Unmanaged.GetOrPutResult {
            return self.unmanaged.getOrPut(self.allocator, key);
        }

        pub fn get(self: @This(), key: Key) ?Value {
            return self.unmanaged.get(key);
        }

        pub fn getPtr(self: @This(), key: Key) ?*Value {
            return self.unmanaged.getPtr(key);
        }

        pub fn getIndex(self: @This(), key: Key) ?usize {
            return self.unmanaged.getIndex(key);
        }

        pub fn reIndex(self: *@This()) !void {
            return self.unmanaged.reIndex(self.allocator);
        }

        pub fn getEntry(self: @This(), key: Key) ?Entry {
            return self.unmanaged.getEntry(key);
        }

        pub fn getKey(self: @This(), key: Key) ?Key {
            return self.unmanaged.getKey(key);
        }

        pub fn getKeyPtr(self: @This(), key: Key) ?*Key {
            return self.unmanaged.getKeyPtr(key);
        }

        pub fn contains(self: @This(), key: Key) bool {
            return self.unmanaged.contains(key);
        }

        pub fn swapRemove(self: *@This(), key: Key) bool {
            return self.unmanaged.swapRemove(key);
        }

        pub fn orderedRemove(self: *@This(), key: Key) bool {
            return self.unmanaged.orderedRemove(key);
        }

        pub fn clone(self: @This()) !@This() {
            return .{
                .unmanaged = try self.unmanaged.clone(self.allocator),
                .allocator = self.allocator,
            };
        }
    };
}

pub const StringSet = struct {
    map: Map,

    pub const Map = StringArrayHashMap(void);

    pub fn clone(self: *const StringSet) !StringSet {
        var new_map = Map.init(self.map.allocator);
        try new_map.ensureTotalCapacity(self.map.count());
        for (self.map.keys()) |key| {
            new_map.putAssumeCapacity(try self.map.allocator.dupe(u8, key), {});
        }
        return .{ .map = new_map };
    }

    pub fn init(allocator: std.mem.Allocator) StringSet {
        return .{ .map = Map.init(allocator) };
    }

    pub fn initComptime() StringSet {
        return .{ .map = Map.initContext(undefined, .{}) };
    }

    pub fn isEmpty(self: *const StringSet) bool {
        return self.count() == 0;
    }

    pub fn count(self: *const StringSet) usize {
        return self.map.count();
    }

    pub fn keys(self: *const StringSet) []const []const u8 {
        return self.map.keys();
    }

    pub fn insert(self: *StringSet, key: []const u8) !void {
        const entry = try self.map.getOrPut(key);
        if (!entry.found_existing) {
            entry.key_ptr.* = try self.map.allocator.dupe(u8, key);
        }
    }

    pub fn contains(self: *StringSet, key: []const u8) bool {
        return self.map.contains(key);
    }

    pub fn swapRemove(self: *StringSet, key: []const u8) bool {
        return self.map.swapRemove(key);
    }

    pub fn clearAndFree(self: *StringSet) void {
        for (self.map.keys()) |key| {
            self.map.allocator.free(key);
        }
        self.map.clearAndFree();
    }

    pub fn deinit(self: *StringSet) void {
        for (self.map.keys()) |key| {
            self.map.allocator.free(key);
        }
        self.map.deinit();
    }
};

pub const string = @import("string/string.zig");
pub const String = string.String;
pub const ZigString = string.ZigString;
pub const MutableString = string.MutableString;
pub const PathString = string.PathString;
pub const StringBuilder = string.StringBuilder;
pub const StringJoiner = string.StringJoiner;
pub const DotEnv = @import("dotenv/env_loader.zig");
pub const strings = string.immutable;
pub const CodePoint = strings.CodePoint;
pub const Semver = @import("semver/semver.zig");

pub fn copy(comptime Type: type, dest: []Type, src: []const Type) void {
    @memmove(dest[0..src.len], src);
}

pub fn create(allocator: std.mem.Allocator, comptime Type: type, value: Type) *Type {
    const pointer = allocator.create(Type) catch outOfMemory();
    pointer.* = value;
    return pointer;
}

pub fn destroy(value: anytype) void {
    default_allocator.destroy(value);
}

pub fn TrivialNew(comptime Type: type) fn (Type) *Type {
    return struct {
        fn new(value: Type) *Type {
            return create(default_allocator, Type, value);
        }
    }.new;
}

pub fn TrivialDeinit(comptime Type: type) fn (*Type) void {
    return struct {
        fn deinit(value: *Type) void {
            default_allocator.destroy(value);
        }
    }.deinit;
}

pub fn reinterpretSlice(comptime To: type, input: anytype) []const To {
    return std.mem.bytesAsSlice(To, std.mem.sliceAsBytes(input));
}

pub const cpp = struct {
    /// Emulates WTF::dtoa: ECMAScript Number::toString(10) semantics
    /// (shortest round-trip digits, exponential notation for exponents
    /// >= 21 or <= -7). The previous `{d}` formatting expanded large and
    /// tiny values to their full decimal form (e.g. 3.40282e38 became a
    /// 39-digit integer) and overflowed the buffer for subnormals.
    pub fn WTF__dtoa(buf: anytype, number: f64) usize {
        const out_ptr: [*]u8 = @ptrCast(buf);
        const out = out_ptr[0..124];
        const write = struct {
            fn write(destination: []u8, text: []const u8) usize {
                @memcpy(destination[0..text.len], text);
                return text.len;
            }
        }.write;
        if (std.math.isNan(number)) return write(out, "NaN");
        if (std.math.isPositiveInf(number)) return write(out, "Infinity");
        if (std.math.isNegativeInf(number)) return write(out, "-Infinity");
        if (number == 0) return write(out, "0");

        // Shortest round-trip scientific form: [-]d[.ddd]e[-]X
        var scientific_buf: [64]u8 = undefined;
        const scientific = std.fmt.bufPrint(&scientific_buf, "{e}", .{number}) catch return 0;
        var rest: []const u8 = scientific;
        var length: usize = 0;
        if (rest.len > 0 and rest[0] == '-') {
            out[length] = '-';
            length += 1;
            rest = rest[1..];
        }
        const e_index = std.mem.indexOfScalar(u8, rest, 'e') orelse return write(out, scientific);
        const mantissa = rest[0..e_index];
        const exponent = std.fmt.parseInt(i32, rest[e_index + 1 ..], 10) catch return write(out, scientific);

        // Digits without the decimal point.
        var digits_buf: [32]u8 = undefined;
        var digit_count: usize = 0;
        for (mantissa) |char| {
            if (char == '.') continue;
            digits_buf[digit_count] = char;
            digit_count += 1;
        }
        // Strip trailing zeros (shortest form should not have them, but be safe).
        while (digit_count > 1 and digits_buf[digit_count - 1] == '0') digit_count -= 1;
        const digits = digits_buf[0..digit_count];
        const k: i32 = @intCast(digit_count);
        const n: i32 = exponent + 1; // decimal point position: value = 0.digits * 10^n

        if (k <= n and n <= 21) {
            // Integer with trailing zeros.
            length += write(out[length..], digits);
            var index: i32 = 0;
            while (index < n - k) : (index += 1) {
                out[length] = '0';
                length += 1;
            }
        } else if (0 < n and n <= 21) {
            // Decimal point inside the digits.
            length += write(out[length..], digits[0..@intCast(n)]);
            out[length] = '.';
            length += 1;
            length += write(out[length..], digits[@intCast(n)..]);
        } else if (-6 < n and n <= 0) {
            // 0.000digits
            length += write(out[length..], "0.");
            var index: i32 = n;
            while (index < 0) : (index += 1) {
                out[length] = '0';
                length += 1;
            }
            length += write(out[length..], digits);
        } else {
            // Exponential notation.
            out[length] = digits[0];
            length += 1;
            if (digit_count > 1) {
                out[length] = '.';
                length += 1;
                length += write(out[length..], digits[1..]);
            }
            out[length] = 'e';
            length += 1;
            const printed = std.fmt.bufPrint(out[length..], "{s}{d}", .{
                if (n - 1 >= 0) "+" else "",
                n - 1,
            }) catch return 0;
            length += printed.len;
        }
        return length;
    }

    pub fn JSC__jsToNumber(bytes_ptr: [*]const u8, len: usize) f64 {
        return std.fmt.parseFloat(f64, bytes_ptr[0..len]) catch std.math.nan(f64);
    }

    pub fn Bun__WTFStringImpl__deref(_: anytype) void {}
    pub fn Bun__WTFStringImpl__ref(_: anytype) void {}
    pub fn Bun__WTFStringImpl__ensureHash(_: anytype) void {}
    pub fn WTFStringImpl__isThreadSafe(_: anytype) bool {
        return true;
    }
};

pub const base64 = struct {
    pub const DecodeResult = struct {
        count: usize,
        success: bool,

        pub fn isSuccessful(self: *const DecodeResult) bool {
            return self.success;
        }
    };

    pub fn decodeLen(source: []const u8) usize {
        const decoder = if (std.mem.endsWith(u8, source, "=")) std.base64.standard.Decoder else std.base64.standard_no_pad.Decoder;
        return decoder.calcSizeForSlice(source) catch source.len / 4 * 3 + 2;
    }

    pub fn decode(destination: []u8, source: []const u8) DecodeResult {
        const decoder = if (std.mem.endsWith(u8, source, "=")) std.base64.standard.Decoder else std.base64.standard_no_pad.Decoder;
        const count = decoder.calcSizeForSlice(source) catch return .{ .count = 0, .success = false };
        decoder.decode(destination[0..count], source) catch return .{ .count = 0, .success = false };
        return .{ .count = count, .success = true };
    }

    pub fn encodeLen(source: anytype) usize {
        return encodeLenFromSize(source.len);
    }

    pub fn encodeLenFromSize(source_len: usize) usize {
        return std.base64.standard.Encoder.calcSize(source_len);
    }

    pub fn encode(destination: []u8, source: []const u8) usize {
        const encoded = std.base64.standard.Encoder.encode(destination, source);
        return encoded.len;
    }

    pub fn encodeURLSafe(destination: []u8, source: []const u8) usize {
        const encoded = std.base64.url_safe_no_pad.Encoder.encode(destination, source);
        return encoded.len;
    }

    pub fn simdutfEncodeLenUrlSafe(source_len: usize) usize {
        return std.base64.url_safe_no_pad.Encoder.calcSize(source_len);
    }

    pub fn simdutfEncodeUrlSafe(destination: []u8, source: []const u8) usize {
        return std.base64.url_safe_no_pad.Encoder.encode(destination, source).len;
    }
};

pub const glob = struct {
    pub const MatchResult = struct {
        matched: bool,

        pub fn matches(self: MatchResult) bool {
            return self.matched;
        }
    };

    pub fn match(pattern: []const u8, text: []const u8) MatchResult {
        return .{ .matched = wildcardMatch(pattern, text) };
    }

    fn wildcardMatch(pattern: []const u8, text: []const u8) bool {
        var p: usize = 0;
        var t: usize = 0;
        var star: ?usize = null;
        var match_index: usize = 0;

        while (t < text.len) {
            if (p < pattern.len and (pattern[p] == text[t] or pattern[p] == '?')) {
                p += 1;
                t += 1;
            } else if (p < pattern.len and pattern[p] == '*') {
                star = p;
                match_index = t;
                p += 1;
            } else if (star) |star_index| {
                p = star_index + 1;
                match_index += 1;
                t = match_index;
            } else {
                return false;
            }
        }

        while (p < pattern.len and pattern[p] == '*') p += 1;
        return p == pattern.len;
    }
};

pub fn writeAnyToHasher(hasher: anytype, thing: anytype) void {
    const Thing = @TypeOf(thing);
    switch (@typeInfo(Thing)) {
        .float => hasher.update(std.mem.asBytes(&thing)),
        .int, .comptime_int, .bool, .@"enum" => std.hash.autoHash(hasher, thing),
        .enum_literal => hasher.update(@tagName(thing)),
        .@"struct" => |info| {
            inline for (info.fields) |field| {
                writeAnyToHasher(hasher, @field(thing, field.name));
            }
        },
        .array => {
            for (thing) |item| writeAnyToHasher(hasher, item);
        },
        .optional => {
            if (thing) |value| {
                writeAnyToHasher(hasher, true);
                writeAnyToHasher(hasher, value);
            } else {
                writeAnyToHasher(hasher, false);
            }
        },
        else => hasher.update(std.mem.asBytes(&thing)),
    }
}

pub fn todoPanic(_: std.builtin.SourceLocation, comptime message: []const u8, args: anytype) noreturn {
    std.debug.panic(message, args);
}

pub const c = struct {
    pub fn memmem(haystack: ?[*]const u8, haystacklen: usize, needle: ?[*]const u8, needlelen: usize) ?[*]const u8 {
        if (haystack == null or needle == null) return null;
        if (needlelen == 0) return haystack;
        if (needlelen > haystacklen) return null;
        const hay = haystack.?[0..haystacklen];
        const nee = needle.?[0..needlelen];
        const index = std.mem.indexOf(u8, hay, nee) orelse return null;
        return hay.ptr + index;
    }

    pub fn memrchr(bytes_ptr: [*]const u8, char: u8, len: usize) ?[*]const u8 {
        const slice = bytes_ptr[0..len];
        const index = std.mem.lastIndexOfScalar(u8, slice, char) orelse return null;
        return slice.ptr + index;
    }

    pub fn memcmp(a: [*]const u8, b: [*]const u8, len: usize) c_int {
        return switch (std.mem.order(u8, a[0..len], b[0..len])) {
            .lt => -1,
            .eq => 0,
            .gt => 1,
        };
    }

    pub fn memmove(dest: [*]u8, src: [*]const u8, len: usize) [*]u8 {
        @memmove(dest[0..len], src[0..len]);
        return dest;
    }

    pub fn strncasecmp(a: [*]const u8, b: [*]const u8, len: usize) c_int {
        for (a[0..len], b[0..len]) |left, right| {
            const lower_left = std.ascii.toLower(left);
            const lower_right = std.ascii.toLower(right);
            if (lower_left < lower_right) return -1;
            if (lower_left > lower_right) return 1;
        }
        return 0;
    }
};

pub const ast = @import("js_parser/js_parser.zig");
pub const js_parser = @import("js_parser/parser.zig");
pub const js_lexer = @import("js_parser/lexer.zig");
pub const js_printer = @import("js_printer/js_printer.zig");
pub const renamer = @import("js_printer/renamer.zig");
pub const highway = @import("highway/highway.zig");
pub const Wyhash11 = @import("wyhash/wyhash.zig").Wyhash11;
pub const BundleV2 = bundle_v2.BundleV2;

pub fn new(comptime Type: type, value: Type) *Type {
    return create(default_allocator, Type, value);
}

pub fn concat(comptime Type: type, destination: []Type, slices: []const []const Type) void {
    var offset: usize = 0;
    for (slices) |slice| {
        @memcpy(destination[offset..][0..slice.len], slice);
        offset += slice.len;
    }
}

pub fn pow(base: f64, exponent: f64) f64 {
    return std.math.pow(f64, base, exponent);
}

pub fn powf(base: f32, exponent: f32) f32 {
    return std.math.pow(f32, base, exponent);
}

pub inline fn clamp(value: anytype, minimum: @TypeOf(value), maximum: @TypeOf(value)) @TypeOf(value) {
    if (comptime @TypeOf(value) == f32 or @TypeOf(value) == f64) {
        if (value < minimum) return minimum;
        if (value > maximum) return maximum;
        return value;
    }
    return std.math.clamp(value, minimum, maximum);
}

pub fn intFromFloat(comptime Int: type, value: anytype) Int {
    if (std.math.isNan(value)) return 0;
    const truncated = @trunc(value);
    const maximum = std.math.maxInt(Int);
    const minimum = std.math.minInt(Int);
    if (truncated > @as(@TypeOf(value), @floatFromInt(maximum))) return maximum;
    if (truncated < @as(@TypeOf(value), @floatFromInt(minimum))) return minimum;
    return @intFromFloat(truncated);
}

pub fn splitAtMut(comptime Type: type, slice: []Type, middle: usize) struct { []Type, []Type } {
    return .{ slice[0..middle], slice[middle..] };
}

pub inline fn take(value: anytype) ?@typeInfo(@typeInfo(@TypeOf(value)).pointer.child).optional.child {
    const result = value.*;
    value.* = null;
    return result;
}

pub inline fn clear(value: anytype, allocator: std.mem.Allocator) void {
    if (value.*) |*item| {
        if (@hasDecl(@TypeOf(item.*), "deinit")) item.deinit(allocator);
        value.* = null;
    }
}

pub inline fn wrappingNegation(value: anytype) @TypeOf(value) {
    return 0 -% value;
}

pub const FD = struct {
    value: Native = invalid_value,

    const Native = std.Io.File.Handle;
    const invalid_value: Native = if (Environment.isWindows)
        std.os.windows.INVALID_HANDLE_VALUE
    else
        -1;

    pub const invalid: FD = .{};

    pub fn fromStdDir(dir: std.Io.Dir) FD {
        return .{ .value = dir.handle };
    }

    pub fn fromStdFile(file: std.Io.File) FD {
        return .{ .value = file.handle };
    }

    pub fn fromNative(value: Native) FD {
        return .{ .value = value };
    }

    pub fn cwd() FD {
        return fromStdDir(std.Io.Dir.cwd());
    }

    pub fn isValid(self: FD) bool {
        return if (Environment.isWindows)
            self.value != std.os.windows.INVALID_HANDLE_VALUE
        else
            self.value >= 0;
    }

    pub fn unwrapValid(self: FD) ?FD {
        return if (self.isValid()) self else null;
    }

    pub fn native(self: FD) Native {
        return self.value;
    }

    pub fn format(self: FD, writer: *std.Io.Writer) std.Io.Writer.Error!void {
        if (Environment.isWindows) {
            try writer.print("0x{x}", .{@intFromPtr(self.value)});
        } else {
            try writer.print("{d}", .{self.value});
        }
    }

    pub const cast = native;

    pub fn stdDir(self: FD) std.Io.Dir {
        return .{ .handle = self.value };
    }

    pub fn stdFile(self: FD) std.Io.File {
        return .{ .handle = self.value, .flags = .{ .nonblocking = false } };
    }

    pub fn readlinkat(self: FD, pathname: []const u8, buffer: []u8) sys.SysMaybe([]u8) {
        const length = self.stdDir().readLink(
            std.Io.Threaded.global_single_threaded.io(),
            pathname,
            buffer,
        ) catch return .{ .err = .{ .path = pathname } };
        return .{ .result = buffer[0..length] };
    }

    pub fn unlinkat(self: FD, pathname: []const u8) sys.SysMaybe(void) {
        self.stdDir().deleteFile(std.Io.Threaded.global_single_threaded.io(), pathname) catch
            return .{ .err = .{ .path = pathname } };
        return .{ .result = {} };
    }

    pub fn close(self: FD) void {
        if (self.isValid()) self.stdDir().close(std.Io.Threaded.global_single_threaded.io());
    }

    pub fn closeAllowingBadFileDescriptor(self: FD, _: usize) ?sys.Error {
        self.close();
        return null;
    }

    pub const Stdio = enum { stdin, stdout, stderr };

    pub fn stdioTag(self: FD) ?Stdio {
        if (Environment.isWindows) {
            if (self.value == std.Io.File.stdin().handle) return .stdin;
            if (self.value == std.Io.File.stdout().handle) return .stdout;
            if (self.value == std.Io.File.stderr().handle) return .stderr;
            return null;
        }
        return switch (self.value) {
            0 => .stdin,
            1 => .stdout,
            2 => .stderr,
            else => null,
        };
    }
};
pub const invalid_fd: FD = .invalid;

pub const DirIterator = struct {
    pub const IteratorResult = struct {
        name: PathString,
        kind: std.Io.File.Kind,
    };

    pub const Result = union(enum) {
        result: ?IteratorResult,
        err: anyerror,

        pub fn unwrap(self: Result) anyerror!?IteratorResult {
            return switch (self) {
                .result => |value| value,
                .err => |value| value,
            };
        }
    };

    pub const Iterator = struct {
        inner: std.Io.Dir.Iterator,

        pub fn next(self: *Iterator) Result {
            const entry = self.inner.next(std.Io.Threaded.global_single_threaded.io()) catch |err| {
                return .{ .err = err };
            };
            return .{ .result = if (entry) |value| .{
                .name = PathString.init(value.name),
                .kind = value.kind,
            } else null };
        }
    };
};

pub fn iterateDir(dir: FD) DirIterator.Iterator {
    return .{ .inner = dir.stdDir().iterate() };
}

pub const OpenDirResult = union(enum) {
    result: FD,
    err: anyerror,

    pub fn unwrap(self: OpenDirResult) anyerror!FD {
        return switch (self) {
            .result => |value| value,
            .err => |value| value,
        };
    }
};

pub fn openDirForIteration(parent: FD, path_name: []const u8) OpenDirResult {
    const directory = parent.stdDir().openDir(
        std.Io.Threaded.global_single_threaded.io(),
        path_name,
        .{ .iterate = true },
    ) catch |err| return .{ .err = err };
    return .{ .result = FD.fromStdDir(directory) };
}

test "directory descriptors opened through sys can be iterated" {
    const directory = try sys.openA(".", O.DIRECTORY | O.RDONLY, 0).unwrap();
    defer directory.close();

    var iterator = iterateDir(directory);
    _ = try iterator.next().unwrap();

    const child = try sys.openat(directory, ".", O.DIRECTORY | O.RDONLY, 0).unwrap();
    defer child.close();

    var child_iterator = iterateDir(child);
    _ = try child_iterator.next().unwrap();
}

pub fn getcwd(buffer: []u8) ![]u8 {
    if (comptime Environment.isWindows) {
        const result = _getcwd(buffer.ptr, @intCast(buffer.len)) orelse return error.CurrentWorkingDirectoryUnavailable;
        return std.mem.sliceTo(result, 0);
    }
    const len = try std.process.currentPath(std.Io.Threaded.global_single_threaded.io(), buffer);
    return buffer[0..len];
}

pub fn getcwdAlloc(allocator: std.mem.Allocator) ![:0]u8 {
    var buffer: [std.fs.max_path_bytes]u8 = undefined;
    const result = try getcwd(&buffer);
    return try allocator.dupeZ(u8, result);
}

extern fn _getcwd(buffer: [*]u8, size: c_int) callconv(.c) ?[*:0]u8;

pub fn getenvZ(name: [:0]const u8) ?[:0]const u8 {
    const value = std.c.getenv(name.ptr) orelse return null;
    return std.mem.span(value);
}

pub fn getenvZAnyCase(name: [:0]const u8) ?[]const u8 {
    return getenvZ(name);
}

pub fn getenvTruthy(name: [:0]const u8) bool {
    const value = getenvZ(name) orelse return false;
    return std.mem.eql(u8, value, "1") or std.mem.eql(u8, value, "true");
}

pub const asan = struct {
    pub fn poison(_: *anyopaque, _: usize) void {}
    pub fn unpoison(_: *anyopaque, _: usize) void {}
    pub fn assertUnpoisoned(_: *const anyopaque) void {}
};

pub fn OrdinalT(comptime Int: type) type {
    return enum(Int) {
        invalid = if (@typeInfo(Int).int.signedness == .unsigned) std.math.maxInt(Int) else -1,
        start = 0,
        _,

        pub fn fromZeroBased(value: Int) @This() {
            return @enumFromInt(value);
        }

        pub fn fromOneBased(value: Int) @This() {
            return @enumFromInt(value - 1);
        }

        pub fn zeroBased(self: @This()) Int {
            return @intFromEnum(self);
        }

        pub fn oneBased(self: @This()) Int {
            return @intFromEnum(self) + 1;
        }

        pub fn add(self: @This(), other: @This()) @This() {
            return fromZeroBased(self.zeroBased() + other.zeroBased());
        }

        pub fn addScalar(self: @This(), value: Int) @This() {
            return fromZeroBased(self.zeroBased() + value);
        }

        pub fn isValid(self: @This()) bool {
            return self != .invalid;
        }
    };
}

pub const Ordinal = OrdinalT(c_int);

pub fn cast(comptime To: type, value: anytype) To {
    return @ptrCast(@alignCast(value));
}

pub fn handleOom(value: anytype) switch (@typeInfo(@TypeOf(value))) {
    .error_union => |info| info.payload,
    .error_set => noreturn,
    else => @TypeOf(value),
} {
    return switch (@typeInfo(@TypeOf(value))) {
        .error_union => value catch outOfMemory(),
        .error_set => outOfMemory(),
        else => value,
    };
}

pub fn outOfMemory() noreturn {
    @panic("out of memory");
}

pub fn unreachablePanic(comptime message: []const u8, args: anytype) noreturn {
    std.debug.panic(message, args);
}

pub fn assert(ok: bool) void {
    std.debug.assert(ok);
}

pub fn unsafeAssert(ok: bool) void {
    std.debug.assert(ok);
}

pub fn debugAssert(ok: bool) void {
    std.debug.assert(ok);
}

pub fn assertWithLocation(ok: bool, _: std.builtin.SourceLocation) void {
    std.debug.assert(ok);
}

pub fn assertf(ok: bool, comptime message: []const u8, args: anytype) void {
    if (!ok) std.debug.panic(message, args);
}

pub fn assert_eql(comptime expected: anytype, actual: @TypeOf(expected)) void {
    std.debug.assert(expected == actual);
}

pub fn hash(content: []const u8) u64 {
    return std.hash.Wyhash.hash(0, content);
}

pub fn hash32(content: []const u8) u32 {
    return @truncate(hash(content));
}

pub fn parseDouble(input: []const u8) !f64 {
    return std.fmt.parseFloat(f64, input);
}

pub fn zero(comptime Type: type) Type {
    return std.mem.zeroes(Type);
}

pub fn GenericIndex(comptime backing_int: type, comptime uid: anytype) type {
    const null_value = std.math.maxInt(backing_int);

    return enum(backing_int) {
        _,

        const Index = @This();

        comptime {
            _ = uid;
        }

        pub inline fn init(int: backing_int) Index {
            std.debug.assert(int != null_value);
            return @enumFromInt(int);
        }

        pub inline fn get(i: Index) backing_int {
            std.debug.assert(@intFromEnum(i) != null_value);
            return @intFromEnum(i);
        }

        pub inline fn toOptional(oi: Index) Optional {
            return @enumFromInt(oi.get());
        }

        pub fn sortFnAsc(_: void, a: Index, b: Index) bool {
            return a.get() < b.get();
        }

        pub fn sortFnDesc(_: void, a: Index, b: Index) bool {
            return a.get() > b.get();
        }

        pub fn format(this: Index, writer: *std.Io.Writer) !void {
            return writer.print("{d}", .{@intFromEnum(this)});
        }

        pub const Optional = enum(backing_int) {
            none = std.math.maxInt(backing_int),
            _,

            pub inline fn init(maybe: anytype) Optional {
                comptime var info = @typeInfo(@TypeOf(maybe));
                if (info == .optional) info = @typeInfo(info.optional.child);
                if (info == .int or info == .comptime_int) {
                    return if (@as(?backing_int, maybe)) |int| Index.init(int).toOptional() else .none;
                }
                return if (@as(?Index, maybe)) |index| index.toOptional() else .none;
            }

            pub inline fn unwrap(oi: Optional) ?Index {
                return if (oi == .none) null else @enumFromInt(@intFromEnum(oi));
            }

            pub inline fn unwrapGet(oi: Optional) ?backing_int {
                return if (oi == .none) null else @intFromEnum(oi);
            }
        };
    };
}
