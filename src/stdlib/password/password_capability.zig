const password = @import("password_native");

comptime {
    _ = &password.ct_password_hash;
    _ = &password.ct_password_verify;
}
