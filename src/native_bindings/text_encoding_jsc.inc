#include "text_encoding.h"

#define CT_TEXT_ENCODING_STACK_CODE_UNITS 256

static const char *ct_text_encoding_converter_name(CtTextEncoding encoding) {
    switch (encoding) {
        case CT_TEXT_ENCODING_UTF8: return "UTF-8";
        case CT_TEXT_ENCODING_IBM866: return "ibm866";
        case CT_TEXT_ENCODING_ISO_8859_2: return "iso-8859-2";
        case CT_TEXT_ENCODING_ISO_8859_3: return "iso-8859-3";
        case CT_TEXT_ENCODING_ISO_8859_4: return "iso-8859-4";
        case CT_TEXT_ENCODING_ISO_8859_5: return "iso-8859-5";
        case CT_TEXT_ENCODING_ISO_8859_6: return "iso-8859-6";
        case CT_TEXT_ENCODING_ISO_8859_7: return "iso-8859-7";
        case CT_TEXT_ENCODING_ISO_8859_8:
        case CT_TEXT_ENCODING_ISO_8859_8_I:
            return "iso-8859-8";
        case CT_TEXT_ENCODING_ISO_8859_10: return "iso-8859-10";
        case CT_TEXT_ENCODING_ISO_8859_13: return "iso-8859-13";
        case CT_TEXT_ENCODING_ISO_8859_14: return "iso-8859-14";
        case CT_TEXT_ENCODING_ISO_8859_15: return "iso-8859-15";
        case CT_TEXT_ENCODING_ISO_8859_16: return "iso-8859-16";
        case CT_TEXT_ENCODING_KOI8_R: return "koi8-r";
        case CT_TEXT_ENCODING_KOI8_U: return "koi8-u";
        case CT_TEXT_ENCODING_MACINTOSH: return "macintosh";
        case CT_TEXT_ENCODING_WINDOWS_874: return "windows-874";
        case CT_TEXT_ENCODING_WINDOWS_1250: return "windows-1250";
        case CT_TEXT_ENCODING_WINDOWS_1251: return "windows-1251";
        case CT_TEXT_ENCODING_WINDOWS_1252: return "windows-1252";
        case CT_TEXT_ENCODING_WINDOWS_1253: return "windows-1253";
        case CT_TEXT_ENCODING_WINDOWS_1254: return "windows-1254";
        case CT_TEXT_ENCODING_WINDOWS_1255: return "windows-1255";
        case CT_TEXT_ENCODING_WINDOWS_1256: return "windows-1256";
        case CT_TEXT_ENCODING_WINDOWS_1257: return "windows-1257";
        case CT_TEXT_ENCODING_WINDOWS_1258: return "windows-1258";
        case CT_TEXT_ENCODING_X_MAC_CYRILLIC: return "x-mac-cyrillic";
        // Preserve Cottontail's existing WHATWG-compatible converter choices.
        case CT_TEXT_ENCODING_GBK:
        case CT_TEXT_ENCODING_GB18030:
            return "gb18030";
        case CT_TEXT_ENCODING_BIG5: return "big5";
        case CT_TEXT_ENCODING_EUC_JP: return "euc-jp";
        case CT_TEXT_ENCODING_ISO_2022_JP: return "ISO-2022-JP";
        case CT_TEXT_ENCODING_SHIFT_JIS: return "windows-31j";
        case CT_TEXT_ENCODING_EUC_KR: return "windows-949";
        case CT_TEXT_ENCODING_UTF16BE: return "UTF-16BE";
        case CT_TEXT_ENCODING_UTF16LE: return "UTF-16LE";
        case CT_TEXT_ENCODING_REPLACEMENT:
        case CT_TEXT_ENCODING_X_USER_DEFINED:
        case CT_TEXT_ENCODING_COUNT:
            return NULL;
    }
    return NULL;
}

static JSValueRef ct_text_encoding_lookup_native(
    JSContextRef context,
    JSObjectRef function,
    JSObjectRef this_object,
    size_t argument_count,
    const JSValueRef arguments[],
    JSValueRef *exception
) {
    (void)function;
    (void)this_object;
    if (argument_count < 1) {
        ct_throw_type_error(context, exception, "textEncodingLookup requires a label");
        return JSValueMakeUndefined(context);
    }

    size_t label_length = 0;
    char *label = ct_value_to_utf8_copy_checked(
        context,
        arguments[0],
        &label_length,
        exception
    );
    if (label == NULL) {
        if (exception == NULL || *exception == NULL) {
            ct_throw_message(context, exception, "Out of memory");
        }
        return JSValueMakeUndefined(context);
    }
    int encoding = ct_text_encoding_lookup((const uint8_t *)label, label_length);
    free(label);
    return JSValueMakeNumber(context, (double)encoding);
}

static JSValueRef ct_text_decode_x_user_defined(
    JSContextRef context,
    const uint8_t *data,
    size_t data_length,
    JSValueRef *exception
) {
    if (data_length == 0) return ct_make_string(context, "");
    if (data_length > SIZE_MAX / sizeof(JSChar)) {
        ct_throw_message(context, exception, "Out of memory");
        return JSValueMakeUndefined(context);
    }
    JSChar stack_characters[CT_TEXT_ENCODING_STACK_CODE_UNITS];
    const bool uses_heap = data_length > CT_TEXT_ENCODING_STACK_CODE_UNITS;
    JSChar *characters = uses_heap
        ? (JSChar *)malloc(data_length * sizeof(JSChar))
        : stack_characters;
    if (uses_heap && characters == NULL) {
        ct_throw_message(context, exception, "Out of memory");
        return JSValueMakeUndefined(context);
    }
    for (size_t index = 0; index < data_length; index += 1) {
        const uint8_t byte = data[index];
        characters[index] = byte < 0x80
            ? (JSChar)byte
            : (JSChar)(0xf780 + byte - 0x80);
    }
    JSStringRef text = JSStringCreateWithCharacters(characters, data_length);
    if (uses_heap) free(characters);
    JSValueRef result = JSValueMakeString(context, text);
    JSStringRelease(text);
    return result;
}

static JSValueRef ct_text_decode_indexed_single_byte(
    JSContextRef context,
    CtTextEncoding encoding,
    const uint8_t *data,
    size_t data_length,
    bool fatal,
    JSValueRef *exception
) {
    if (data_length == 0) {
        const int status = ct_text_encoding_decode_single_byte(
            (int)encoding,
            NULL,
            0,
            NULL,
            fatal ? 1 : 0
        );
        return status == 1 ? ct_make_string(context, "") : JSValueMakeNull(context);
    }
    if (data_length > SIZE_MAX / sizeof(JSChar)) {
        ct_throw_message(context, exception, "Out of memory");
        return JSValueMakeUndefined(context);
    }
    JSChar stack_characters[CT_TEXT_ENCODING_STACK_CODE_UNITS];
    const bool uses_heap = data_length > CT_TEXT_ENCODING_STACK_CODE_UNITS;
    JSChar *characters = uses_heap
        ? (JSChar *)malloc(data_length * sizeof(JSChar))
        : stack_characters;
    if (uses_heap && characters == NULL) {
        ct_throw_message(context, exception, "Out of memory");
        return JSValueMakeUndefined(context);
    }
    const int status = ct_text_encoding_decode_single_byte(
        (int)encoding,
        data,
        data_length,
        (uint16_t *)characters,
        fatal ? 1 : 0
    );
    if (status == 0) {
        if (uses_heap) free(characters);
        return JSValueMakeNull(context);
    }
    if (status == 2) {
        if (uses_heap) free(characters);
        ct_throw_message(context, exception, "The encoded data was not valid for the requested encoding");
        return JSValueMakeUndefined(context);
    }
    JSStringRef text = JSStringCreateWithCharacters(characters, data_length);
    if (uses_heap) free(characters);
    JSValueRef result = JSValueMakeString(context, text);
    JSStringRelease(text);
    return result;
}

static JSValueRef ct_text_decode_with_icu(
    JSContextRef context,
    CtTextEncoding encoding,
    const uint8_t *data,
    size_t data_length,
    bool fatal,
    bool strip_bom,
    JSValueRef *exception
) {
    const CtIcuConverterApi *api = ct_icu_converter_api();
    const char *converter_name = ct_text_encoding_converter_name(encoding);
    if (api == NULL || converter_name == NULL) return JSValueMakeNull(context);

    CtUConverter *converter = ct_icu_cached_converter(api, converter_name);
    if (converter == NULL) return JSValueMakeNull(context);
    if (data_length == 0) return ct_make_string(context, "");
    if (data_length > INT32_MAX || data_length > (SIZE_MAX / sizeof(uint16_t)) - 1) {
        ct_throw_message(context, exception, "TextDecoder input is too large");
        return JSValueMakeUndefined(context);
    }

    int32_t status = 0;
    api->set_to_u_callback(
        converter,
        fatal ? api->callback_stop : api->callback_substitute,
        NULL,
        NULL,
        NULL,
        &status
    );
    api->reset_to_unicode(converter);
    if (status > 0) {
        ct_throw_message(context, exception, "Failed to configure the text decoder");
        return JSValueMakeUndefined(context);
    }

    const size_t capacity = data_length + 1;
    uint16_t *buffer = (uint16_t *)malloc(capacity * sizeof(uint16_t));
    if (buffer == NULL) {
        ct_throw_message(context, exception, "Out of memory");
        return JSValueMakeUndefined(context);
    }
    status = 0;
    int32_t written = api->to_uchars(
        converter,
        buffer,
        (int32_t)capacity,
        (const char *)data,
        (int32_t)data_length,
        &status
    );
    if (status > 0 || written < 0) {
        free(buffer);
        ct_throw_message(context, exception, "The encoded data was not valid for the requested encoding");
        return JSValueMakeUndefined(context);
    }

    size_t start = 0;
    if (strip_bom &&
        (encoding == CT_TEXT_ENCODING_UTF8 ||
         encoding == CT_TEXT_ENCODING_UTF16BE ||
         encoding == CT_TEXT_ENCODING_UTF16LE) &&
        written > 0 &&
        buffer[0] == 0xfeff) {
        start = 1;
    }
    JSStringRef text = JSStringCreateWithCharacters(
        (const JSChar *)(buffer + start),
        (size_t)written - start
    );
    free(buffer);
    JSValueRef result = JSValueMakeString(context, text);
    JSStringRelease(text);
    return result;
}

static JSValueRef ct_text_decode_native(
    JSContextRef context,
    JSObjectRef function,
    JSObjectRef this_object,
    size_t argument_count,
    const JSValueRef arguments[],
    JSValueRef *exception
) {
    (void)function;
    (void)this_object;
    if (argument_count < 2) {
        ct_throw_type_error(context, exception, "textDecode requires an encoding and bytes");
        return JSValueMakeUndefined(context);
    }

    JSValueRef number_exception = NULL;
    double encoding_number = JSValueToNumber(context, arguments[0], &number_exception);
    if (number_exception != NULL) {
        if (exception != NULL) *exception = number_exception;
        return JSValueMakeUndefined(context);
    }
    if (!isfinite(encoding_number) ||
        floor(encoding_number) != encoding_number ||
        encoding_number < 0 ||
        encoding_number >= CT_TEXT_ENCODING_COUNT) {
        ct_throw_type_error(context, exception, "textDecode received an invalid encoding");
        return JSValueMakeUndefined(context);
    }

    uint8_t *data = NULL;
    size_t data_length = 0;
    if (ct_get_bytes(context, arguments[1], &data, &data_length) != 0) {
        ct_throw_type_error(context, exception, "textDecode requires an ArrayBuffer or typed array");
        return JSValueMakeUndefined(context);
    }

    const CtTextEncoding encoding = (CtTextEncoding)(int)encoding_number;
    if (encoding == CT_TEXT_ENCODING_X_USER_DEFINED) {
        return ct_text_decode_x_user_defined(context, data, data_length, exception);
    }
    if (encoding == CT_TEXT_ENCODING_REPLACEMENT) {
        return data_length == 0 ? ct_make_string(context, "") : ct_make_string(context, "\xef\xbf\xbd");
    }

    const bool fatal = argument_count >= 3 && JSValueToBoolean(context, arguments[2]);
    const bool strip_bom = argument_count >= 4 && JSValueToBoolean(context, arguments[3]);
    JSValueRef indexed = ct_text_decode_indexed_single_byte(
        context,
        encoding,
        data,
        data_length,
        fatal,
        exception
    );
    if (!JSValueIsNull(context, indexed)) return indexed;
    return ct_text_decode_with_icu(
        context,
        encoding,
        data,
        data_length,
        fatal,
        strip_bom,
        exception
    );
}

static JSValueRef ct_text_encode_native(
    JSContextRef context,
    JSObjectRef function,
    JSObjectRef this_object,
    size_t argument_count,
    const JSValueRef arguments[],
    JSValueRef *exception
) {
    (void)function;
    (void)this_object;
    if (argument_count < 1) {
        return JSObjectMakeTypedArray(
            context,
            kJSTypedArrayTypeUint8Array,
            0,
            exception
        );
    }

    JSStringRef string = JSValueToStringCopy(context, arguments[0], exception);
    if (string == NULL || (exception != NULL && *exception != NULL)) {
        return JSValueMakeUndefined(context);
    }
    const size_t input_length = JSStringGetLength(string);
    const JSChar *characters = JSStringGetCharactersPtr(string);
    if (input_length > SIZE_MAX / 3 || (input_length > 0 && characters == NULL)) {
        JSStringRelease(string);
        ct_throw_message(context, exception, "Out of memory");
        return JSValueMakeUndefined(context);
    }
    const size_t capacity = input_length * 3;
    char *bytes = (char *)malloc(capacity > 0 ? capacity : 1);
    if (bytes == NULL) {
        JSStringRelease(string);
        ct_throw_message(context, exception, "Out of memory");
        return JSValueMakeUndefined(context);
    }
    const size_t byte_length = input_length == 0
        ? 0
        : ct_text_encoding_encode_utf16(
            (const uint16_t *)characters,
            input_length,
            (uint8_t *)bytes,
            capacity
        );
    JSStringRelease(string);
    if (input_length > 0 && byte_length == 0) {
        free(bytes);
        ct_throw_message(context, exception, "Failed to encode UTF-16 input");
        return JSValueMakeUndefined(context);
    }

    JSObjectRef result = JSObjectMakeTypedArrayWithBytesNoCopy(
        context,
        kJSTypedArrayTypeUint8Array,
        bytes,
        byte_length,
        ct_array_buffer_free,
        NULL,
        exception
    );
    if (result == NULL || (exception != NULL && *exception != NULL)) {
        free(bytes);
        return JSValueMakeUndefined(context);
    }
    return result;
}
