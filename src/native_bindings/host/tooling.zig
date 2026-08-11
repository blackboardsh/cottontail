const host = @import("../../host.zig");

pub fn forceLink() void {
    _ = &host.ct_semver_order;
    _ = &host.ct_semver_satisfies;
}
