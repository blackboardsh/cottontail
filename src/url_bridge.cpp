// Match the release-mode WTF header layout used by the vendored JSC artifacts.
#ifndef NDEBUG
#define NDEBUG 1
#endif
#ifndef RELEASE_WITHOUT_OPTIMIZATIONS
#define RELEASE_WITHOUT_OPTIMIZATIONS 1
#endif
#define U_DISABLE_RENAMING 1
#define U_SHOW_CPLUSPLUS_API 0

#include "url_bridge.h"

#include <wtf/KeyValuePair.h>
#include <wtf/URLParser.h>
#include <wtf/text/StringView.h>
#include <wtf/text/WTFString.h>

#include <limits>
#include <span>
#include <vector>

static_assert(sizeof(WTF::StringView) == 16);

namespace {

bool isHighSurrogate(char16_t value)
{
    return value >= 0xD800 && value <= 0xDBFF;
}

bool isLowSurrogate(char16_t value)
{
    return value >= 0xDC00 && value <= 0xDFFF;
}

WTF::String fromJSString(JSStringRef value)
{
    if (!value)
        return { };
    const size_t length = JSStringGetLength(value);
    if (length > std::numeric_limits<unsigned>::max())
        return { };

    const auto* characters =
        reinterpret_cast<const char16_t*>(JSStringGetCharactersPtr(value));
    bool needsNormalization = false;
    for (size_t index = 0; index < length; ++index) {
        if (isHighSurrogate(characters[index])
            && index + 1 < length
            && isLowSurrogate(characters[index + 1])) {
            ++index;
            continue;
        }
        if (isHighSurrogate(characters[index]) || isLowSurrogate(characters[index])) {
            needsNormalization = true;
            break;
        }
    }
    if (!needsNormalization)
        return WTF::String(std::span { characters, length });

    std::vector<char16_t> normalized(characters, characters + length);
    for (size_t index = 0; index < length; ++index) {
        if (isHighSurrogate(normalized[index])
            && index + 1 < length
            && isLowSurrogate(normalized[index + 1])) {
            ++index;
            continue;
        }
        if (isHighSurrogate(normalized[index]) || isLowSurrogate(normalized[index]))
            normalized[index] = 0xFFFD;
    }
    return WTF::String(std::span { normalized });
}

JSStringRef toJSString(const WTF::String& value)
{
    if (value.isNull())
        return JSStringCreateWithUTF8CString("");
    if (!value.is8Bit()) {
        const auto characters = value.span16();
        return JSStringCreateWithCharacters(
            reinterpret_cast<const JSChar*>(characters.data()),
            characters.size());
    }

    const auto characters = value.span8();
    std::vector<JSChar> widened(characters.size());
    for (size_t index = 0; index < characters.size(); ++index)
        widened[index] = static_cast<JSChar>(characters[index]);
    return JSStringCreateWithCharacters(widened.data(), widened.size());
}

JSValueRef makeStringValue(JSContextRef context, const WTF::String& value)
{
    JSStringRef string = toJSString(value);
    if (!string)
        return JSValueMakeUndefined(context);
    JSValueRef result = JSValueMakeString(context, string);
    JSStringRelease(string);
    return result;
}

}

extern "C" JSObjectRef ct_url_parse_form(
    JSContextRef context,
    JSStringRef input,
    JSValueRef* exception)
{
    const auto pairs = WTF::URLParser::parseURLEncodedForm(fromJSString(input));
    JSObjectRef result = JSObjectMakeArray(context, 0, nullptr, exception);
    if (!result || (exception && *exception))
        return nullptr;

    for (size_t index = 0; index < pairs.size(); ++index) {
        JSValueRef values[] = {
            makeStringValue(context, pairs[index].key),
            makeStringValue(context, pairs[index].value),
        };
        JSObjectRef pair = JSObjectMakeArray(context, 2, values, exception);
        if (!pair || (exception && *exception))
            return nullptr;
        JSObjectSetPropertyAtIndex(
            context,
            result,
            static_cast<unsigned>(index),
            pair,
            exception);
        if (exception && *exception)
            return nullptr;
    }
    return result;
}
