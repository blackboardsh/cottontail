const std = @import("std");
const builtin = @import("builtin");

extern "c" fn ct_sync_signal_forwarding_begin() void;
extern "c" fn ct_sync_signal_forwarding_set_pid(pid: i64) void;
extern "c" fn ct_sync_signal_forwarding_end() void;
extern "c" fn ct_sync_signal_forwarding_forwarded_termination() c_int;
extern "c" fn ct_exit_with_signal(signal_number: c_int) noreturn;

pub const Scope = struct {
    active: bool,

    pub fn begin() Scope {
        if (builtin.os.tag == .windows) return .{ .active = false };
        ct_sync_signal_forwarding_begin();
        return .{ .active = true };
    }

    pub fn deinit(self: *Scope) void {
        if (!self.active) return;
        ct_sync_signal_forwarding_end();
        self.active = false;
    }

    pub fn setChild(self: *Scope, id: std.process.Child.Id) void {
        if (!self.active) return;
        if (comptime builtin.os.tag != .windows) {
            ct_sync_signal_forwarding_set_pid(@intCast(id));
        }
    }

    /// A termination signal delivered to this process while the scope was
    /// active was handed to the child instead. Reports it exactly once so the
    /// caller can honour it after the child is reaped; otherwise the parent
    /// would keep running (and keep spawning) as if it were never signalled.
    pub fn takeForwardedTermination(self: *const Scope) ?c_int {
        if (!self.active) return null;
        if (comptime builtin.os.tag == .windows) return null;
        const signal_number = ct_sync_signal_forwarding_forwarded_termination();
        return if (signal_number == 0) null else signal_number;
    }

    pub fn waitAndPropagate(self: *Scope, io: std.Io, child: *std.process.Child) !u8 {
        return propagate(try self.wait(io, child));
    }

    pub fn wait(self: *Scope, io: std.Io, child: *std.process.Child) !std.process.Child.Term {
        if (child.id) |id| self.setChild(id);
        const term = try child.wait(io);
        const forwarded = self.takeForwardedTermination();
        self.deinit();
        if (forwarded) |signal_number| exitWithSignalNumber(signal_number);
        return term;
    }
};

pub fn propagate(term: std.process.Child.Term) u8 {
    return switch (term) {
        .exited => |code| @intCast(@min(code, 255)),
        .signal => |signal_number| exitWithSignal(signal_number),
        .stopped, .unknown => 1,
    };
}

pub fn exitWithSignal(signal_number: std.posix.SIG) noreturn {
    ct_exit_with_signal(@intCast(@intFromEnum(signal_number)));
}

pub fn exitWithSignalNumber(signal_number: c_int) noreturn {
    ct_exit_with_signal(signal_number);
}
