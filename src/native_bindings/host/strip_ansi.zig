const strip_ansi = @import("../../strip_ansi.zig");

pub fn forceLink() void {
    _ = &strip_ansi.ct_strip_ansi_latin1;
    _ = &strip_ansi.ct_strip_ansi_utf16;
    _ = &strip_ansi.ct_strip_ansi_free_latin1;
    _ = &strip_ansi.ct_strip_ansi_free_utf16;
}
