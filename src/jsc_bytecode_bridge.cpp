/*
 * Cached bytecode is a private JavaScriptCore facility. The declarations in
 * this file are pinned to WebKit-7624.2.5.10.6, matching the vendored JSCOnly
 * archive. They adapt stock JSC APIs; no Bun-patched JSC symbols are used.
 */

// The vendored JSC archive uses WTF's release layouts. They change return ABIs
// and container field offsets, so this translation unit must match them even
// when the surrounding Cottontail build is unoptimized.
#ifndef NDEBUG
#define NDEBUG 1
#ifndef RELEASE_WITHOUT_OPTIMIZATIONS
#define RELEASE_WITHOUT_OPTIMIZATIONS 1
#endif
#endif

// The Linux archive is produced by CMake with HAVE_MMAP enabled. The installed
// WTF headers do not carry that generated definition, but MappedFileData is
// part of CachePayload's private ABI, so the bridge must restore it before
// including those headers.
#if defined(__linux__) && !defined(HAVE_MMAP)
#define HAVE_MMAP 1
#endif

#include <JavaScriptCore/JSContextRef.h>
#include <JavaScriptCore/JSStringRef.h>
#include <JavaScriptCore/JSValueRef.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <span>
#include <type_traits>
#include <utility>

#include <wtf/FastMalloc.h>
#include <wtf/Function.h>
#include <wtf/HashMap.h>
#include <wtf/MallocSpan.h>
#include <wtf/MappedFileData.h>
#include <wtf/Ref.h>
#include <wtf/RefCounted.h>
#include <wtf/RefPtr.h>
#include <wtf/ThreadSafeRefCounted.h>
#include <wtf/URL.h>
#include <wtf/Variant.h>
#include <wtf/Vector.h>
#include <wtf/text/OrdinalNumber.h>
#include <wtf/text/StringImpl.h>
#include <wtf/text/StringView.h>
#include <wtf/text/TextPosition.h>
#include <wtf/text/WTFString.h>

namespace WTF::FileSystemImpl {

// FileHandle's public header pulls optional platform headers that are not part
// of the JSCOnly SDK. Its pinned storage is one Markable platform handle.
class FileHandle {
public:
    FileHandle();
    ~FileHandle();

private:
#if defined(_WIN32)
    void* m_handle;
#else
    int m_handle;
#endif
};

} // namespace WTF::FileSystemImpl

struct OpaqueJSScript;
using JSScriptRef = OpaqueJSScript*;

extern "C" JSScriptRef JSScriptCreateFromString(
    JSContextGroupRef, JSStringRef, int, JSStringRef, JSStringRef* error_message, int* error_line);
extern "C" void JSScriptRelease(JSScriptRef);
extern "C" JSValueRef JSScriptEvaluate(JSContextRef, JSScriptRef, JSValueRef, JSValueRef* exception);

struct OpaqueJSString {
    WTF::String string() const;
};

namespace JSC {

class CodeBlockHash;
class Identifier;
class ScriptFetcher;
class SourceCode;
class UnlinkedFunctionCodeBlock;
class UnlinkedFunctionExecutable;
class VM;

using SourceID = int;
using VMMalloc = WTF::FastMalloc;

enum class CodeSpecializationKind : uint8_t {
    CodeForCall,
    CodeForConstruct,
};

enum class SourceTaintedOrigin : uint8_t {
    Untainted,
    IndirectlyTainted,
    Tainted,
};

enum class SourceProviderSourceType : uint8_t {
    Program,
    Module,
    WebAssembly,
    JSON,
    ImportMap,
};

enum JSTokenType {
    ERRORTOK = 1 << 20,
};

struct JSTextPosition {
    int line { -1 };
    int offset { -1 };
    int lineStartOffset { -1 };
};

union JSTokenData {
    struct {
        const Identifier* cooked;
        const Identifier* raw;
        bool isTail;
    } string;
    double doubleValue;
    const Identifier* identifiers[2];
};

struct JSToken {
    JSTokenType m_type { ERRORTOK };
    JSTokenData m_data { .string = { nullptr, nullptr, false } };
    JSTextPosition m_startPosition;
    JSTextPosition m_endPosition;
};

class ParserError {
public:
    enum SyntaxErrorType : uint8_t {
        SyntaxErrorNone,
        SyntaxErrorIrrecoverable,
        SyntaxErrorUnterminatedLiteral,
        SyntaxErrorRecoverable,
    };
    enum ErrorType : uint8_t {
        ErrorNone,
        StackOverflow,
        EvalError,
        OutOfMemory,
        SyntaxError,
    };

private:
    JSToken m_token;
    WTF::String m_message;
    int m_line { -1 };
    ErrorType m_type { ErrorNone };
    SyntaxErrorType m_syntaxErrorType { SyntaxErrorNone };
};

class BytecodeCacheError {
public:
    class StandardError {
        int m_errno;
    };
    class WriteError {
        size_t m_written;
        size_t m_expected;
    };

    bool isValid() const;
    WTF::String message() const;

private:
    WTF::Variant<ParserError, StandardError, WriteError> m_error;
};

static_assert(sizeof(JSToken) == 56);
static_assert(sizeof(ParserError) == 72);

class SourceOrigin {
public:
    SourceOrigin() = default;
    explicit SourceOrigin(const WTF::URL& url)
        : m_url(url)
    {
    }

private:
    WTF::URL m_url;
    // Cottontail creates only fetcher-less origins. A raw null pointer keeps
    // the pinned RefPtr storage shape without importing ScriptFetcher internals.
    ScriptFetcher* m_fetcher { nullptr };
};

class CachePayload {
public:
    static CachePayload makeMallocPayload(WTF::MallocSpan<uint8_t, VMMalloc>&&);
    CachePayload(CachePayload&&);
    ~CachePayload();
    std::span<const uint8_t> span() const;
    size_t size() const { return span().size(); }

private:
    using DataType = WTF::Variant<
        WTF::MallocSpan<uint8_t, VMMalloc>,
        WTF::FileSystemImpl::MappedFileData>;
    DataType m_data;
};

using CodeFeatures = uint16_t;
using LexicallyScopedFeatures = uint8_t;

struct CachedFunctionExecutableMetadata {
    CodeFeatures m_features;
    LexicallyScopedFeatures m_lexicallyScopedFeatures;
    bool m_hasCapturedVariables;
};

class CacheUpdate {
public:
    struct GlobalUpdate {
        CachePayload m_payload;
    };

    struct FunctionUpdate {
        ptrdiff_t m_base;
        CodeSpecializationKind m_kind;
        CachedFunctionExecutableMetadata m_metadata;
        CachePayload m_payload;
    };

    CacheUpdate(GlobalUpdate&&);
    CacheUpdate(FunctionUpdate&&);
    CacheUpdate(CacheUpdate&&);
    CacheUpdate& operator=(CacheUpdate&&);

    bool isGlobal() const;
    const GlobalUpdate& asGlobal() const;
    const FunctionUpdate& asFunction() const;

private:
    WTF::Variant<GlobalUpdate, FunctionUpdate> m_update;
};

class LeafExecutable {
public:
    LeafExecutable() = default;

private:
    ptrdiff_t m_base;
};

using LeafExecutableMap = WTF::UncheckedKeyHashMap<const UnlinkedFunctionExecutable*, LeafExecutable>;

class CachedBytecode : public WTF::RefCounted<CachedBytecode> {
public:
    static WTF::Ref<CachedBytecode> create(
        WTF::MallocSpan<uint8_t, VMMalloc>&& data,
        LeafExecutableMap&& leaf_executables)
    {
        return WTF::adoptRef(*new CachedBytecode(
            CachePayload::makeMallocPayload(WTF::move(data)),
            WTF::move(leaf_executables)));
    }

    std::span<const uint8_t> span() const { return m_payload.span(); }

private:
    CachedBytecode(CachePayload&& payload, LeafExecutableMap&& leaf_executables)
        : m_size(payload.size())
        , m_payload(WTF::move(payload))
        , m_leafExecutables(WTF::move(leaf_executables))
    {
    }

    size_t m_size { 0 };
    CachePayload m_payload;
    LeafExecutableMap m_leafExecutables;
    WTF::Vector<CacheUpdate> m_updates;
};

constexpr size_t expected_cache_payload_size = 0x20;
constexpr size_t expected_function_update_size = 0x30;
constexpr size_t expected_cache_update_size = 0x38;
constexpr size_t expected_cached_bytecode_size = 0x48;

static_assert(sizeof(CachePayload) == expected_cache_payload_size,
    "pinned CachePayload layout changed; update the stock-JSC bytecode bridge");
static_assert(sizeof(CachedFunctionExecutableMetadata) == 0x4,
    "pinned function metadata layout changed; update the stock-JSC bytecode bridge");
static_assert(sizeof(CacheUpdate::GlobalUpdate) == expected_cache_payload_size,
    "pinned global cache update layout changed; update the stock-JSC bytecode bridge");
static_assert(offsetof(CacheUpdate::FunctionUpdate, m_payload) == 0x10
        && sizeof(CacheUpdate::FunctionUpdate) == expected_function_update_size,
    "pinned function cache update layout changed; update the stock-JSC bytecode bridge");
static_assert(sizeof(CacheUpdate) == expected_cache_update_size,
    "pinned CacheUpdate layout changed; update the stock-JSC bytecode bridge");
static_assert(sizeof(LeafExecutableMap) == 0x8,
    "pinned LeafExecutableMap layout changed; update the stock-JSC bytecode bridge");
static_assert(sizeof(CachedBytecode) == expected_cached_bytecode_size,
    "pinned CachedBytecode layout changed; update the stock-JSC bytecode bridge");

} // namespace JSC

namespace WTF {

// Use JSC's explicit instantiation so destruction follows the stock private
// CachedBytecode shape, including any serialized leaf-executable metadata.
template<> void RefCounted<JSC::CachedBytecode>::deref() const;

} // namespace WTF

namespace JSC {

using BytecodeCacheGenerator = WTF::Function<WTF::RefPtr<CachedBytecode>()>;

class SourceProvider : public WTF::ThreadSafeRefCounted<SourceProvider> {
public:
    static const intptr_t nullID = 1;

    SourceProvider(
        const SourceOrigin&,
        WTF::String&& source_url,
        WTF::String&& pre_redirect_url,
        SourceTaintedOrigin,
        const WTF::TextPosition&,
        SourceProviderSourceType);
    virtual ~SourceProvider();

    virtual unsigned hash() const = 0;
    virtual WTF::StringView source() const = 0;
    virtual WTF::RefPtr<CachedBytecode> cachedBytecode() const { return nullptr; }
    virtual void cacheBytecode(const BytecodeCacheGenerator&) const { }
    virtual void updateCache(
        const UnlinkedFunctionExecutable*,
        const SourceCode&,
        CodeSpecializationKind,
        const UnlinkedFunctionCodeBlock*) const
    {
    }
    virtual void commitCachedBytecode() const { }

    const SourceOrigin& sourceOrigin() const { return m_sourceOrigin; }
    const WTF::String& sourceURL() const { return m_sourceURL; }
    WTF::TextPosition startPosition() const { return m_startPosition; }

    virtual CodeBlockHash codeBlockHashConcurrently(int, int, CodeSpecializationKind);
    virtual bool isScriptBufferSourceProvider() const { return false; }

private:
    virtual void lockUnderlyingBufferImpl();
    virtual void unlockUnderlyingBufferImpl();
    void getID();

    std::atomic<unsigned> m_lockingCount { 0 };
    SourceProviderSourceType m_sourceType;
    SourceOrigin m_sourceOrigin;
    WTF::String m_sourceURL;
    WTF::String m_sourceURLStripped;
    WTF::String m_preRedirectURL;
    WTF::String m_sourceURLDirective;
    WTF::String m_sourceMappingURLDirective;
    WTF::TextPosition m_startPosition;
    SourceID m_id { 0 };
    SourceTaintedOrigin m_taintedness;
};

class UnlinkedSourceCode {
public:
    explicit UnlinkedSourceCode(WTF::Ref<SourceProvider>&& provider)
        : m_provider(WTF::move(provider))
        , m_startOffset(0)
        , m_endOffset(m_provider->source().length())
    {
    }

    UnlinkedSourceCode(WTF::RefPtr<SourceProvider>&& provider, int start_offset, int end_offset)
        : m_provider(WTF::move(provider))
        , m_startOffset(start_offset)
        , m_endOffset(end_offset)
    {
    }

protected:
    WTF::RefPtr<SourceProvider> m_provider;
    int m_startOffset;
    int m_endOffset;
};

static_assert(sizeof(void*) == 8, "cached-bytecode bridge supports Cottontail's 64-bit targets");
static_assert(sizeof(WTF::StringView) == 16,
    "pinned release JSC StringView layout changed; update the stock-JSC bytecode bridge");
static_assert(std::is_trivially_copy_constructible_v<WTF::StringView>
        && std::is_trivially_destructible_v<WTF::StringView>,
    "pinned release JSC StringView return ABI changed; update the stock-JSC bytecode bridge");
static_assert(sizeof(SourceProvider) == 0x80,
    "pinned SourceProvider layout changed; update the stock-JSC bytecode bridge");

class SourceCode : public UnlinkedSourceCode {
public:
    explicit SourceCode(WTF::Ref<SourceProvider>&& provider)
        : UnlinkedSourceCode(WTF::move(provider))
    {
    }

    SourceCode(
        WTF::RefPtr<SourceProvider>&& provider,
        int start_offset,
        int end_offset,
        int first_line,
        int start_column)
        : UnlinkedSourceCode(WTF::move(provider), start_offset, end_offset)
        , m_firstLine(WTF::OrdinalNumber::fromOneBasedInt(std::max(first_line, 1)))
        , m_startColumn(WTF::OrdinalNumber::fromOneBasedInt(std::max(start_column, 1)))
    {
    }

private:
    WTF::OrdinalNumber m_firstLine;
    WTF::OrdinalNumber m_startColumn;
};

WTF::RefPtr<CachedBytecode> generateProgramBytecode(
    VM&,
    const SourceCode&,
    WTF::FileSystemImpl::FileHandle&,
    BytecodeCacheError&);

class BytecodeSourceProvider final : public SourceProvider {
public:
    static WTF::Ref<BytecodeSourceProvider> create(
        VM& vm,
        const SourceOrigin& source_origin,
        WTF::String source_url,
        const WTF::String& source,
        CachedBytecode* cached_bytecode)
    {
        return WTF::adoptRef(*new BytecodeSourceProvider(
            vm,
            source_origin,
            WTF::move(source_url),
            source,
            cached_bytecode));
    }

    unsigned hash() const final { return m_source.get().hash(); }
    WTF::StringView source() const final { return m_source.get(); }
    WTF::RefPtr<CachedBytecode> cachedBytecode() const final
    {
        return m_cachedBytecode;
    }

    VM& vm() const { return m_vm; }

private:
    BytecodeSourceProvider(
        VM& vm,
        const SourceOrigin& source_origin,
        WTF::String&& source_url,
        const WTF::String& source,
        CachedBytecode* cached_bytecode)
        : SourceProvider(
            source_origin,
            WTF::move(source_url),
            WTF::String(),
            SourceTaintedOrigin::Untainted,
            WTF::TextPosition(),
            SourceProviderSourceType::Program)
        , m_vm(vm)
        , m_source(source.isNull() ? *WTF::StringImpl::empty() : *source.impl())
        , m_cachedBytecode(cached_bytecode)
    {
    }

    ~BytecodeSourceProvider() final = default;

    // These two fields deliberately match OpaqueJSScript's private prefix.
    // JSScriptEvaluate is stock JSC's supported evaluator but JSScriptRef is
    // opaque, so the adapter supplies the same pinned provider shape.
    VM& m_vm;
    const WTF::Ref<WTF::StringImpl> m_source;
    WTF::RefPtr<CachedBytecode> m_cachedBytecode;
};

} // namespace JSC

namespace {

constexpr std::array<uint8_t, 8> cache_magic { 'C', 'T', 'J', 'S', 'C', 'B', '0', '1' };
constexpr uint32_t cache_schema = 1;
constexpr size_t cache_header_size = 56;
constexpr char jsc_vendor_identity[] = "WebKit-7624.2.5.10.6-53fd9fcd3043";
constexpr uint64_t fnv_offset = UINT64_C(14695981039346656037);
constexpr uint64_t fnv_prime = UINT64_C(1099511628211);

uint64_t hash_bytes(std::span<const uint8_t> bytes)
{
    uint64_t hash = fnv_offset;
    for (uint8_t byte : bytes) {
        hash ^= byte;
        hash *= fnv_prime;
    }
    return hash;
}

uint64_t hash_string(JSStringRef string)
{
    uint64_t hash = fnv_offset;
    const size_t length = string ? JSStringGetLength(string) : 0;
    const JSChar* characters = string ? JSStringGetCharactersPtr(string) : nullptr;
    for (size_t index = 0; index < length; ++index) {
        const uint16_t character = characters[index];
        hash ^= static_cast<uint8_t>(character);
        hash *= fnv_prime;
        hash ^= static_cast<uint8_t>(character >> 8);
        hash *= fnv_prime;
    }
    for (unsigned shift = 0; shift < 64; shift += 8) {
        hash ^= static_cast<uint8_t>(length >> shift);
        hash *= fnv_prime;
    }
    return hash;
}

uint64_t engine_identity()
{
    return hash_bytes({
        reinterpret_cast<const uint8_t*>(jsc_vendor_identity),
        sizeof(jsc_vendor_identity) - 1,
    });
}

void write_u32(uint8_t* output, uint32_t value)
{
    for (unsigned index = 0; index < 4; ++index)
        output[index] = static_cast<uint8_t>(value >> (index * 8));
}

void write_u64(uint8_t* output, uint64_t value)
{
    for (unsigned index = 0; index < 8; ++index)
        output[index] = static_cast<uint8_t>(value >> (index * 8));
}

uint32_t read_u32(const uint8_t* input)
{
    uint32_t value = 0;
    for (unsigned index = 0; index < 4; ++index)
        value |= static_cast<uint32_t>(input[index]) << (index * 8);
    return value;
}

uint64_t read_u64(const uint8_t* input)
{
    uint64_t value = 0;
    for (unsigned index = 0; index < 8; ++index)
        value |= static_cast<uint64_t>(input[index]) << (index * 8);
    return value;
}

bool unpack_cache(
    JSStringRef source,
    JSStringRef source_url,
    const uint8_t* bytes,
    size_t length,
    std::span<const uint8_t>& payload)
{
    if (!bytes || length < cache_header_size)
        return false;
    if (!std::equal(cache_magic.begin(), cache_magic.end(), bytes))
        return false;
    if (read_u32(bytes + 8) != cache_schema || read_u32(bytes + 12) != cache_header_size)
        return false;
    if (read_u64(bytes + 16) != engine_identity())
        return false;
    if (read_u64(bytes + 24) != hash_string(source))
        return false;
    if (read_u64(bytes + 32) != hash_string(source_url))
        return false;

    const uint64_t payload_length_64 = read_u64(bytes + 48);
    if (payload_length_64 > std::numeric_limits<size_t>::max())
        return false;
    const size_t payload_length = static_cast<size_t>(payload_length_64);
    if (!payload_length || payload_length > length - cache_header_size)
        return false;
    if (cache_header_size + payload_length != length)
        return false;
    payload = { bytes + cache_header_size, payload_length };
    return read_u64(bytes + 40) == hash_bytes(payload);
}

JSC::VM* to_vm(JSContextGroupRef group)
{
    return reinterpret_cast<JSC::VM*>(const_cast<OpaqueJSContextGroup*>(group));
}

} // namespace

extern "C" int ct_jsc_bytecode_generate(
    JSContextGroupRef group,
    JSStringRef source,
    JSStringRef source_url,
    uint8_t** output,
    size_t* output_length,
    JSStringRef* error_message)
{
    if (output)
        *output = nullptr;
    if (output_length)
        *output_length = 0;
    if (error_message)
        *error_message = nullptr;
    if (!group || !source || !source_url || !output || !output_length)
        return -1;

    JSStringRef parse_error = nullptr;
    int error_line = 0;
    JSScriptRef script = JSScriptCreateFromString(
        group, source_url, 1, source, &parse_error, &error_line);
    if (!script) {
        if (error_message)
            *error_message = parse_error;
        else if (parse_error)
            JSStringRelease(parse_error);
        return -1;
    }

    const size_t source_length = JSStringGetLength(source);
    if (source_length > static_cast<size_t>(std::numeric_limits<int>::max())) {
        JSScriptRelease(script);
        return -1;
    }

    // The public script API creates the exact SourceProvider implementation
    // compiled into stock JSC. Supplying explicit offsets keeps StringView's
    // private return ABI inside JSC.
    auto& provider = *reinterpret_cast<JSC::SourceProvider*>(script);
    JSC::SourceCode source_code {
        WTF::RefPtr<JSC::SourceProvider>(&provider),
        0,
        static_cast<int>(source_length),
        1,
        1,
    };
    WTF::FileSystemImpl::FileHandle invalid_file;

    JSC::BytecodeCacheError cache_error;
    WTF::RefPtr<JSC::CachedBytecode> cached = JSC::generateProgramBytecode(
        *to_vm(group), source_code, invalid_file, cache_error);
    JSScriptRelease(script);
    if (!cached) {
        if (error_message && cache_error.isValid()) {
            auto message = cache_error.message().utf8();
            *error_message = JSStringCreateWithUTF8CString(message.data());
        }
        return -1;
    }

    const std::span<const uint8_t> payload = cached->span();
    if (!payload.size() || payload.size() > std::numeric_limits<size_t>::max() - cache_header_size)
        return -1;

    const size_t result_length = cache_header_size + payload.size();
    auto* result = static_cast<uint8_t*>(std::malloc(result_length));
    if (!result)
        return -1;

    std::copy(cache_magic.begin(), cache_magic.end(), result);
    write_u32(result + 8, cache_schema);
    write_u32(result + 12, cache_header_size);
    write_u64(result + 16, engine_identity());
    write_u64(result + 24, hash_string(source));
    write_u64(result + 32, hash_string(source_url));
    write_u64(result + 40, hash_bytes(payload));
    write_u64(result + 48, payload.size());
    std::memcpy(result + cache_header_size, payload.data(), payload.size());

    *output = result;
    *output_length = result_length;
    return 0;
}

extern "C" int ct_jsc_bytecode_evaluate(
    JSContextRef context,
    JSStringRef source,
    JSStringRef source_url,
    const uint8_t* bytes,
    size_t length,
    JSValueRef* exception)
{
    if (exception)
        *exception = nullptr;
    if (!context || !source || !source_url)
        return 1;

    std::span<const uint8_t> payload;
    if (!unpack_cache(source, source_url, bytes, length, payload))
        return 1;

    auto allocation = WTF::MallocSpan<uint8_t, JSC::VMMalloc>::tryMalloc(payload.size());
    if (!allocation)
        return 1;
    std::memcpy(allocation.mutableSpan().data(), payload.data(), payload.size());
    auto cached = JSC::CachedBytecode::create(WTF::move(allocation), { });

    JSContextGroupRef group = JSContextGetGroup(context);
    WTF::String source_string = const_cast<OpaqueJSString*>(source)->string();
    WTF::String source_url_string = const_cast<OpaqueJSString*>(source_url)->string();
    WTF::URL parsed_source_url { WTF::URL(), source_url_string };
    JSC::SourceOrigin source_origin(parsed_source_url);
    auto provider = JSC::BytecodeSourceProvider::create(
        *to_vm(group), source_origin, parsed_source_url.string(), source_string, cached.ptr());

    JSValueRef result = JSScriptEvaluate(
        context,
        reinterpret_cast<JSScriptRef>(provider.ptr()),
        nullptr,
        exception);

    return result || (exception && *exception) ? 0 : 1;
}
