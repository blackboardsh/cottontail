const hashing = @import("native_hashing");

// A Zig-rooted DLL otherwise gets std.start's _DllMainCRTStartup, which skips
// the MSVC CRT's per-module DLL initialization. Static OpenSSL registers its
// cleanup with atexit() on first use, and without that initialization the
// registration corrupted the heap. Declaring the name here leaves the entry
// point to msvcrt.lib on Windows; it has no effect on other targets.
pub const _DllMainCRTStartup = {};

comptime {
    _ = &hashing.ct_hash_value;
    _ = &hashing.ct_blake2b256_create;
    _ = &hashing.ct_blake2b256_copy;
    _ = &hashing.ct_blake2b256_update;
    _ = &hashing.ct_blake2b256_digest;
    _ = &hashing.ct_blake2b256_free;
}
