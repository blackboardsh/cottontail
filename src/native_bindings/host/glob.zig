const glob_match = @import("../../glob_match.zig");

pub fn forceLink() void {
    _ = &glob_match.ct_glob_match;
}
