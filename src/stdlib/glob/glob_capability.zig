const glob = @import("native_glob");

comptime {
    _ = &glob.ct_glob_match;
}
