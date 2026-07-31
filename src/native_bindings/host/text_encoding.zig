const text_encoding = @import("../../text_encoding.zig");
const compiler = @import("cottontail_compiler");

pub export fn ct_text_encoding_utf8_length_latin1(
    input: [*]const u8,
    input_len: usize,
) usize {
    var length: usize = 0;
    for (input[0..input_len]) |byte| {
        length += if (byte < 0x80) 1 else 2;
    }
    return length;
}

pub export fn ct_text_encoding_utf8_length_utf16(
    input: [*]const u16,
    input_len: usize,
) usize {
    const code_units = input[0..input_len];
    var length: usize = 0;
    var index: usize = 0;
    while (index < code_units.len) : (index += 1) {
        const code_unit = code_units[index];
        if (code_unit < 0x80) {
            length += 1;
        } else if (code_unit < 0x800) {
            length += 2;
        } else if (code_unit >= 0xd800 and code_unit <= 0xdbff and
            index + 1 < code_units.len and
            code_units[index + 1] >= 0xdc00 and code_units[index + 1] <= 0xdfff)
        {
            length += 4;
            index += 1;
        } else {
            length += 3;
        }
    }
    return length;
}

pub export fn ct_text_encoding_encode_latin1(
    input: [*]const u8,
    input_len: usize,
    output: [*]u8,
    output_len: usize,
) usize {
    const result = compiler.strings.copyLatin1IntoUTF8(
        output[0..output_len],
        input[0..input_len],
    );
    return if (result.read == input_len) result.written else 0;
}

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
    _ = &ct_text_encoding_utf8_length_latin1;
    _ = &ct_text_encoding_utf8_length_utf16;
    _ = &ct_text_encoding_encode_latin1;
    _ = &ct_text_encoding_encode_utf16;
}
