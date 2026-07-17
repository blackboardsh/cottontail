#include <JavaScriptCore/JSContextRef.h>
#include <JavaScriptCore/JSValueRef.h>

#include <cstdint>
#include <cstring>
#include <limits>

#if defined(__APPLE__)
#include <CoreFoundation/CoreFoundation.h>
#endif

namespace WTF {

// The JSCOnly artifact omits private platform headers pulled in by
// wtf/DateMath.h. This is the release StringView ABI from the pinned WebKit
// source: characters, 32-bit length, and the 8-bit flag.
class StringView final {
public:
    StringView(const void* characters, unsigned length, bool is_8_bit)
        : m_characters(characters)
        , m_length(length)
        , m_is_8_bit(is_8_bit)
    {
    }

private:
    const void* m_characters;
    unsigned m_length;
    bool m_is_8_bit;
};

bool setTimeZoneOverride(StringView);

}

namespace JSC {

// This declaration binds to the stock JSC symbol without requiring WebKit's
// private Heap.h and its platform-header dependency graph.
class DateCache final {
public:
    void resetIfNecessarySlow();
};

class Heap final {
public:
    std::size_t protectedObjectCount();
};

}

namespace {

constexpr std::size_t invalid_count = std::numeric_limits<std::size_t>::max();
constexpr std::size_t vm_heap_offset = 0xf8;
constexpr std::size_t vm_date_cache_offset = 0x1e638;
constexpr std::size_t heap_protected_values_offset = 0x198;
constexpr std::size_t heap_strong_list_offset = 0x228;
constexpr uintptr_t deleted_hash_key = std::numeric_limits<uintptr_t>::max();
constexpr uintptr_t js_cell_excluded_bits = UINT64_C(0xfffe000000000002);

struct ProtectedValueEntry final {
    uintptr_t cell;
    unsigned count;
    unsigned padding;
};

struct StrongHandleNode final {
    const StrongHandleNode* next;
    const StrongHandleNode* previous;
    uintptr_t value;
};

static_assert(sizeof(void*) == 8);
static_assert(sizeof(ProtectedValueEntry) == 16);
static_assert(sizeof(StrongHandleNode) == 24);

bool is_cell_value(uintptr_t value)
{
    return value && !(value & js_cell_excluded_bits);
}

bool protected_values_contains(const ProtectedValueEntry* entries, unsigned capacity, uintptr_t cell)
{
    for (unsigned index = 0; index < capacity; ++index) {
        if (entries[index].cell == cell)
            return true;
    }
    return false;
}

void append_value(JSValueRef* values, std::size_t capacity, std::size_t index, uintptr_t value)
{
    if (index < capacity)
        values[index] = reinterpret_cast<JSValueRef>(value);
}

}

extern "C" bool ct_jsc_value_is_rope(JSContextRef context, JSValueRef value)
{
    if (context == nullptr || value == nullptr || !JSValueIsString(context, value))
        return false;

    // WebKit-7624.2.5.10.6 JSString is a two-word JSCell. The second word is
    // m_fiber and its low bit is JSC::JSString::isRopeInPointer.
    const auto* words = reinterpret_cast<const uintptr_t*>(value);
    return words[1] & 0x1;
}

extern "C" bool ct_jsc_set_time_zone(JSContextRef context, const char* time_zone)
{
    if (context == nullptr || time_zone == nullptr)
        return false;

    auto length = std::strlen(time_zone);
    if (length > std::numeric_limits<unsigned>::max())
        return false;
    if (!WTF::setTimeZoneOverride(WTF::StringView(time_zone, static_cast<unsigned>(length), true)))
        return false;

#if defined(__APPLE__)
    // Cocoa's stock JSC Date cache also keys a process-wide cache from this
    // notification. Posting it makes the public override observable without
    // patching JavaScriptCore.
    CFNotificationCenterPostNotification(
        CFNotificationCenterGetLocalCenter(),
        kCFTimeZoneSystemTimeZoneDidChangeNotification,
        nullptr,
        nullptr,
        true);
#endif

    const auto* vm = reinterpret_cast<const std::uint8_t*>(JSContextGetGroup(context));
    if (vm == nullptr)
        return false;
    auto* date_cache = reinterpret_cast<JSC::DateCache*>(
        const_cast<std::uint8_t*>(vm + vm_date_cache_offset));
    date_cache->resetIfNecessarySlow();
    return true;
}

extern "C" std::size_t ct_jsc_copy_protected_objects(JSContextRef context, JSValueRef* values, std::size_t capacity)
{
    if (context == nullptr || (capacity && values == nullptr))
        return invalid_count;

    // COTTONTAIL-COMPAT: Stock JSC has no public protected-cell iterator. These
    // offsets and entry layouts come from WebKit-7624.2.5.10.6's VM, Heap,
    // HashCountedSet, and HandleNode definitions. Keep this adapter pinned to
    // that release and reject a count mismatch when upgrading JSC.
    const auto* vm = reinterpret_cast<const std::uint8_t*>(JSContextGetGroup(context));
    if (vm == nullptr)
        return invalid_count;

    auto* heap = reinterpret_cast<JSC::Heap*>(const_cast<std::uint8_t*>(vm + vm_heap_offset));
    const std::size_t expected_count = heap->protectedObjectCount();
    const auto* heap_bytes = reinterpret_cast<const std::uint8_t*>(heap);
    const auto* entries = *reinterpret_cast<const ProtectedValueEntry* const*>(
        heap_bytes + heap_protected_values_offset);

    unsigned table_capacity = 0;
    if (entries != nullptr) {
        const auto* table_bytes = reinterpret_cast<const std::uint8_t*>(entries);
        table_capacity = *reinterpret_cast<const unsigned*>(table_bytes - sizeof(unsigned));
        if (table_capacity > (1U << 30))
            return invalid_count;
    }

    std::size_t actual_count = 0;
    for (unsigned index = 0; index < table_capacity; ++index) {
        const uintptr_t cell = entries[index].cell;
        if (!cell || cell == deleted_hash_key)
            continue;
        append_value(values, capacity, actual_count, cell);
        ++actual_count;
        if (actual_count > expected_count)
            return invalid_count;
    }

    const auto* sentinel = reinterpret_cast<const StrongHandleNode*>(heap_bytes + heap_strong_list_offset);
    const StrongHandleNode* node = sentinel->next;
    std::size_t visited_nodes = 0;
    const std::size_t visit_limit = expected_count > (invalid_count - 1024) / 16
        ? invalid_count
        : expected_count * 16 + 1024;
    while (node != sentinel) {
        if (node == nullptr || ++visited_nodes > visit_limit)
            return invalid_count;

        const uintptr_t value = node->value;
        if (is_cell_value(value) && !protected_values_contains(entries, table_capacity, value)) {
            append_value(values, capacity, actual_count, value);
            ++actual_count;
            if (actual_count > expected_count)
                return invalid_count;
        }
        node = node->next;
    }

    return actual_count == expected_count ? actual_count : invalid_count;
}
