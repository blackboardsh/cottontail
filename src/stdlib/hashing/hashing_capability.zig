const hashing = @import("native_hashing");

comptime {
    _ = &hashing.ct_hash_value;
}
