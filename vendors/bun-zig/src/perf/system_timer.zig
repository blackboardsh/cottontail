fn NewTimer() type {
    if (Environment.isWasm) {
        return struct {
            pub fn start() anyerror!@This() {
                return @This(){};
            }

            pub fn read(_: anytype) u64 {
                @compileError("FeatureFlags.tracing should be disabled in WASM");
            }

            pub fn lap(_: anytype) u64 {
                @compileError("FeatureFlags.tracing should be disabled in WASM");
            }

            pub fn reset(_: anytype) u64 {
                @compileError("FeatureFlags.tracing should be disabled in WASM");
            }
        };
    }

    return struct {
        started: i128,

        pub fn start() anyerror!@This() {
            return .{ .started = std.time.nanoTimestamp() };
        }

        pub fn read(this: @This()) u64 {
            return @intCast(@max(0, std.time.nanoTimestamp() - this.started));
        }

        pub fn lap(this: *@This()) u64 {
            const now = std.time.nanoTimestamp();
            const elapsed: u64 = @intCast(@max(0, now - this.started));
            this.started = now;
            return elapsed;
        }

        pub fn reset(this: *@This()) void {
            this.started = std.time.nanoTimestamp();
        }
    };
}
pub const Timer = NewTimer();

const Environment = @import("../bun_core/env.zig");
const std = @import("std");
