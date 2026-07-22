const host = @import("../../host.zig");

pub fn forceLink() void {
    _ = &host.ct_host_spawn_sync;
}
