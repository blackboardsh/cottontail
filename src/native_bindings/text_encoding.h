#ifndef COTTONTAIL_TEXT_ENCODING_H
#define COTTONTAIL_TEXT_ENCODING_H

#include <stddef.h>
#include <stdint.h>

typedef enum {
    CT_TEXT_ENCODING_UTF8 = 0,
    CT_TEXT_ENCODING_IBM866,
    CT_TEXT_ENCODING_ISO_8859_2,
    CT_TEXT_ENCODING_ISO_8859_3,
    CT_TEXT_ENCODING_ISO_8859_4,
    CT_TEXT_ENCODING_ISO_8859_5,
    CT_TEXT_ENCODING_ISO_8859_6,
    CT_TEXT_ENCODING_ISO_8859_7,
    CT_TEXT_ENCODING_ISO_8859_8,
    CT_TEXT_ENCODING_ISO_8859_8_I,
    CT_TEXT_ENCODING_ISO_8859_10,
    CT_TEXT_ENCODING_ISO_8859_13,
    CT_TEXT_ENCODING_ISO_8859_14,
    CT_TEXT_ENCODING_ISO_8859_15,
    CT_TEXT_ENCODING_ISO_8859_16,
    CT_TEXT_ENCODING_KOI8_R,
    CT_TEXT_ENCODING_KOI8_U,
    CT_TEXT_ENCODING_MACINTOSH,
    CT_TEXT_ENCODING_WINDOWS_874,
    CT_TEXT_ENCODING_WINDOWS_1250,
    CT_TEXT_ENCODING_WINDOWS_1251,
    CT_TEXT_ENCODING_WINDOWS_1252,
    CT_TEXT_ENCODING_WINDOWS_1253,
    CT_TEXT_ENCODING_WINDOWS_1254,
    CT_TEXT_ENCODING_WINDOWS_1255,
    CT_TEXT_ENCODING_WINDOWS_1256,
    CT_TEXT_ENCODING_WINDOWS_1257,
    CT_TEXT_ENCODING_WINDOWS_1258,
    CT_TEXT_ENCODING_X_MAC_CYRILLIC,
    CT_TEXT_ENCODING_GBK,
    CT_TEXT_ENCODING_GB18030,
    CT_TEXT_ENCODING_BIG5,
    CT_TEXT_ENCODING_EUC_JP,
    CT_TEXT_ENCODING_ISO_2022_JP,
    CT_TEXT_ENCODING_SHIFT_JIS,
    CT_TEXT_ENCODING_EUC_KR,
    CT_TEXT_ENCODING_REPLACEMENT,
    CT_TEXT_ENCODING_UTF16BE,
    CT_TEXT_ENCODING_UTF16LE,
    CT_TEXT_ENCODING_X_USER_DEFINED,
    CT_TEXT_ENCODING_COUNT,
} CtTextEncoding;

int ct_text_encoding_lookup(const uint8_t *input, size_t input_len);
int ct_text_encoding_decode_single_byte(
    int encoding,
    const uint8_t *input,
    size_t input_len,
    uint16_t *output,
    int fatal
);
size_t ct_text_encoding_utf8_length_latin1(
    const uint8_t *input,
    size_t input_len
);
size_t ct_text_encoding_utf8_length_utf16(
    const uint16_t *input,
    size_t input_len
);
size_t ct_text_encoding_encode_latin1(
    const uint8_t *input,
    size_t input_len,
    uint8_t *output,
    size_t output_len
);
size_t ct_text_encoding_encode_utf16(
    const uint16_t *input,
    size_t input_len,
    uint8_t *output,
    size_t output_len
);

#endif
