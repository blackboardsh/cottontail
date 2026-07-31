const string_width = @import("../../string_width.zig");

pub fn forceLink() void {
    _ = &string_width.ct_string_width_utf16;
    _ = &string_width.ct_string_width_latin1;
}
