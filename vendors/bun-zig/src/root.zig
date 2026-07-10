const std = @import("std");

pub const Environment = @import("bun_core/env.zig");
pub const OOM = std.mem.Allocator.Error;
pub const default_allocator = std.heap.page_allocator;
pub const Generation = u16;
pub const ArenaAllocator = std.heap.ArenaAllocator;
pub const StandaloneModuleGraph = opaque {};
pub const Mutex = struct {
    pub fn lock(_: *Mutex) void {}
    pub fn unlock(_: *Mutex) void {}
};
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
    pub const VirtualMachine = struct {
        pub fn runWithAPILock(_: *VirtualMachine, comptime Wrapper: type, wrapper: *Wrapper, comptime callback: anytype) void {
            callback(wrapper);
        }
    };
    pub const VM = VirtualMachine;
    pub const C = struct {};
    pub const math = struct {
        pub fn pow(a: f64, b: f64) f64 {
            return std.math.pow(f64, a, b);
        }
    };
    pub const URL = struct {
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
    };
    pub const RuntimeTranspilerCache = struct {
        input_hash: ?u64 = null,

        pub fn get(_: *RuntimeTranspilerCache, _: anytype, _: anytype, _: bool) bool {
            return false;
        }
    };
    pub fn markBinding(_: std.builtin.SourceLocation) void {}
    pub const CachedBytecode = struct {
        pub fn isInstance(_: std.mem.Allocator) bool {
            return false;
        }
    };
    pub const WebCore = struct {
        pub const Blob = opaque {};
    };
    pub const ModuleLoader = struct {
        pub const HardcodedModule = struct {
            pub const Alias = struct {
                pub fn has(_: []const u8, _: anytype, _: anytype) bool {
                    return false;
                }

                pub fn get(_: []const u8, _: anytype, _: anytype) ?struct { path: []const u8 } {
                    return null;
                }
            };
        };
    };
};

pub const bundle_v2 = struct {
    pub const MangledProps = struct {
        pub fn get(_: *const MangledProps, _: anytype) ?[]const u8 {
            return null;
        }
    };
    pub const AstBuilder = opaque {};
    pub fn allocatorHasPointer(_: std.mem.Allocator) bool {
        return false;
    }
};

pub const http = struct {
    pub const MimeType = @import("http_types/MimeType.zig");
};

pub const Transpiler = opaque {};

pub const transpiler = struct {
    pub const EntryPoints = struct {
        pub const MacroEntryPoint = struct {
            pub fn generateID(entry_path: []const u8, function_name: []const u8, buf: []u8, len: *u32) i32 {
                var hasher = std.hash.Wyhash.init(0);
                hasher.update("macro:");
                hasher.update(entry_path);
                hasher.update(function_name);
                const digest = hasher.final();
                const specifier = std.fmt.bufPrint(buf, "macro://{x}.js", .{digest}) catch unreachable;
                len.* = @truncate(specifier.len);
                return generateIDFromSpecifier(specifier);
            }

            pub fn generateIDFromSpecifier(specifier: []const u8) i32 {
                return @bitCast(@as(u32, @truncate(hash(specifier))));
            }
        };
    };
};

pub const crash_handler = struct {
    pub const Action = union(enum) {
        parse: []const u8,
        visit: []const u8,
        print: []const u8,
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
        if (comptime @hasDecl(T, "allocator")) return allocator.allocator();
        if (comptime @typeInfo(T) == .pointer and @hasDecl(std.meta.Child(T), "allocator")) return allocator.allocator();
        return std.heap.page_allocator;
    }

    pub fn borrow(allocator: anytype) @TypeOf(allocator) {
        return allocator;
    }

    pub fn Borrowed(comptime Allocator: type) type {
        return Allocator;
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

            fn normalize(key: []const u8) []const u8 {
                return if (comptime remove_trailing_slashes) std.mem.trimRight(u8, key, std.fs.path.sep_str) else key;
            }

            pub fn init(allocator: std.mem.Allocator) *Self {
                const self = allocator.create(Self) catch outOfMemory();
                self.* = .{ .allocator = allocator };
                return self;
            }

            pub fn deinit(self: *Self) void {
                self.indexes.deinit(self.allocator);
                self.values_list.deinit(self.allocator);
                self.allocator.destroy(self);
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
                const ptr = try self.map.put(result, value);
                if (store_key) {
                    while (self.keys.items.len <= result.index.index) {
                        try self.keys.append(self.map.allocator, &.{});
                    }
                    self.keys.items[result.index.index] = try self.map.allocator.dupe(u8, key);
                }
                return ptr;
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
        pub fn isInstance(_: std.mem.Allocator) bool {
            return false;
        }
    };

    pub const NullableAllocator = struct {
        value: ?std.mem.Allocator = null,
        pub fn init(value: ?std.mem.Allocator) @This() {
            return .{ .value = value };
        }
        pub fn get(self: @This()) ?std.mem.Allocator {
            return self.value;
        }
        pub fn isNull(self: @This()) bool {
            return self.value == null;
        }
    };

    pub const MimallocArena = struct {
        pub const Borrowed = struct {
            pub fn allocator(_: @This()) std.mem.Allocator {
                return std.heap.page_allocator;
            }
        };
        pub fn isInstance(_: std.mem.Allocator) bool {
            return false;
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

pub const memory = struct {
    pub fn initDefault(comptime Allocator: type) Allocator {
        if (Allocator == std.mem.Allocator) return std.heap.page_allocator;
        return .{};
    }

    pub fn deinit(_: anytype) void {}
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
    pub const SystemErrno = enum(i32) {
        SUCCESS = 0,
        _,
    };

    pub const Error = struct {
        errno: SystemErrno = .SUCCESS,
        syscall: []const u8 = "",
        path: []const u8 = "",

        pub fn toSystemError(self: Error) Error {
            return self;
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
};

pub const NullableAllocator = allocators.NullableAllocator;

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
    pub fn mi_is_in_heap_region(_: anytype) bool {
        return false;
    }

    pub fn mi_check_owned(_: anytype) bool {
        return false;
    }

    pub fn mi_free(_: *anyopaque) void {}
};

pub const bake = struct {
    pub const DevServer = opaque {};

    pub const Framework = struct {
        server_components: ?ServerComponents = null,
        react_fast_refresh: ?ReactFastRefresh = null,

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
};
pub const FeatureFlags = @import("bun_core/feature_flags.zig");
pub const fmt = @import("bun_core/fmt.zig");
pub const env_var = @import("bun_core/env_var.zig");
pub const feature_flag = env_var.feature_flag;
pub const logger = @import("logger/logger.zig");
pub const meta = struct {
    pub fn ReturnOf(comptime function: anytype) type {
        return ReturnOfType(@TypeOf(function));
    }

    pub fn ReturnOfType(comptime Type: type) type {
        const typeinfo: std.builtin.Type.Fn = @typeInfo(Type).@"fn";
        return typeinfo.return_type orelse void;
    }

    pub fn typeName(comptime Type: type) []const u8 {
        const name = @typeName(Type);
        if (std.mem.lastIndexOfScalar(u8, name, '.')) |index| return name[index + 1 ..];
        return name;
    }
};
pub const schema = @import("options_types/schema.zig");
pub const options = @import("bundler/options.zig");
pub const Define = @import("bundler/defines.zig").Define;
pub const ImportRecord = @import("options_types/import_record.zig").ImportRecord;
pub const ImportKind = @import("options_types/import_record.zig").ImportKind;
pub const SourceMap = @import("sourcemap/sourcemap.zig");
pub const fs = @import("resolver/fs.zig");
pub const path = @import("paths/resolve_path.zig");
pub const paths = @import("paths/paths.zig");
pub const PathBuffer = paths.PathBuffer;
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
};

pub fn StringHashMap(comptime Type: type) type {
    return std.HashMap([]const u8, Type, StringHashMapContext, std.hash_map.default_max_load_percentage);
}

pub fn StringHashMapUnmanaged(comptime Type: type) type {
    return std.HashMapUnmanaged([]const u8, Type, StringHashMapContext, std.hash_map.default_max_load_percentage);
}

pub fn StringArrayHashMap(comptime Type: type) type {
    return struct {
        unmanaged: Unmanaged = .empty,
        allocator: std.mem.Allocator,

        pub const Unmanaged = std.StringArrayHashMapUnmanaged(Type);
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

        pub fn count(self: @This()) usize {
            return self.unmanaged.count();
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

pub fn StringArrayHashMapUnmanaged(comptime Type: type) type {
    return std.StringArrayHashMapUnmanaged(Type);
}

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

        pub fn count(self: @This()) usize {
            return self.unmanaged.count();
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
pub const StringBuilder = string.StringBuilder;
pub const strings = string.immutable;
pub const CodePoint = strings.CodePoint;
pub const Semver = @import("semver/semver.zig");

pub fn copy(comptime Type: type, dest: []Type, src: []const Type) void {
    std.mem.copyForwards(Type, dest, src);
}

pub fn create(allocator: std.mem.Allocator, comptime Type: type, value: Type) *Type {
    const pointer = allocator.create(Type) catch outOfMemory();
    pointer.* = value;
    return pointer;
}

pub fn reinterpretSlice(comptime To: type, input: anytype) []const To {
    return std.mem.bytesAsSlice(To, std.mem.sliceAsBytes(input));
}

pub const cpp = struct {
    pub fn WTF__dtoa(buf: anytype, number: f64) usize {
        const out_ptr: [*]u8 = @ptrCast(buf);
        const out = std.fmt.bufPrint(out_ptr[0..128], "{d}", .{number}) catch return 0;
        return out.len;
    }

    pub fn JSC__jsToNumber(ptr: [*]const u8, len: usize) f64 {
        return std.fmt.parseFloat(f64, ptr[0..len]) catch std.math.nan(f64);
    }

    pub fn Bun__WTFStringImpl__deref(_: anytype) void {}
    pub fn Bun__WTFStringImpl__ref(_: anytype) void {}
    pub fn Bun__WTFStringImpl__ensureHash(_: anytype) void {}
    pub fn WTFStringImpl__isThreadSafe(_: anytype) bool {
        return true;
    }
};

pub const base64 = struct {
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

    pub fn memrchr(ptr: [*]const u8, char: u8, len: usize) ?[*]const u8 {
        const slice = ptr[0..len];
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
        std.mem.copyForwards(u8, dest[0..len], src[0..len]);
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

pub const FD = enum(i32) {
    invalid = -1,
};

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
