const text_encoding = @import("../../text_encoding.zig");
const compiler = @import("cottontail_compiler");

pub export fn ct_text_encoding_encode_utf16(
    input: [*]const u16,
    input_len: usize,
    output: [*]u8,
    output_len: usize,
) usize {
    const result = compiler.strings.copyUTF16IntoUTF8(
        output[0..output_len],
        input[0..input_len],
    );
    return if (result.read == input_len) result.written else 0;
}

pub fn forceLink() void {
    _ = &text_encoding.ct_text_encoding_lookup;
    _ = &text_encoding.ct_text_encoding_decode_single_byte;
    _ = &ct_text_encoding_encode_utf16;
}
