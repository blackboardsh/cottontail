const host = @import("../../host.zig");

pub fn forceLink() void {
    _ = &host.ct_semver_order;
    _ = &host.ct_semver_satisfies;
    _ = &host.ct_hosted_git_info_parse_url;
    _ = &host.ct_hosted_git_info_from_url;
    _ = &host.ct_package_manager_parse_lockfile;
}
