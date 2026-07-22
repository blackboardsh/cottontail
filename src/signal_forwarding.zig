const std = @import("std");
const builtin = @import("builtin");

extern "c" fn ct_sync_signal_forwarding_begin() void;
extern "c" fn ct_sync_signal_forwarding_set_pid(pid: i64) void;
extern "c" fn ct_sync_signal_forwarding_end() void;
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
        ct_sync_signal_forwarding_set_pid(@intCast(id));
    }

    pub fn waitAndPropagate(self: *Scope, io: std.Io, child: *std.process.Child) !u8 {
        if (child.id) |id| self.setChild(id);
        const term = try child.wait(io);
        self.deinit();
        return switch (term) {
            .exited => |code| @intCast(@min(code, 255)),
            .signal => |signal_number| ct_exit_with_signal(@intCast(@intFromEnum(signal_number))),
            .stopped, .unknown => 1,
        };
    }
};
