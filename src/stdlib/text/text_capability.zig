const string_width = @import("string_width");
const strip_ansi = @import("strip_ansi");

comptime {
    _ = &string_width.ct_string_width_utf16;
    _ = &strip_ansi.ct_strip_ansi_utf16;
    _ = &strip_ansi.ct_strip_ansi_free_utf16;
}
