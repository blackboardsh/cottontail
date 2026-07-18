#if defined(__linux__) && !defined(_GNU_SOURCE)
#define _GNU_SOURCE
#endif

#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#if defined(_WIN32)
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#else
#include <dlfcn.h>
#endif

#ifndef COTTONTAIL_ICU_MIN_VERSION
#define COTTONTAIL_ICU_MIN_VERSION 70
#endif
#ifndef COTTONTAIL_ICU_MAX_VERSION
#define COTTONTAIL_ICU_MAX_VERSION 99
#endif
#ifndef COTTONTAIL_ICU_FALLBACK_VERSION
#define COTTONTAIL_ICU_FALLBACK_VERSION 70
#endif

#define ICU_SYMBOL(name) void* cottontail_icu_target_##name;
#include "icu-symbols.inc"
#undef ICU_SYMBOL

struct ICUEntry {
    const char* name;
    void** target;
};

static struct ICUEntry entries[] = {
#define ICU_SYMBOL(name) { #name, &cottontail_icu_target_##name },
#include "icu-symbols.inc"
#undef ICU_SYMBOL
};

#define CT_JOIN_INNER(name, version) name##_##version
#define CT_JOIN(name, version) CT_JOIN_INNER(name, version)

#if defined(COTTONTAIL_ICU_HAS_FALLBACK)
#define ICU_SYMBOL(name) extern void CT_JOIN(name, COTTONTAIL_ICU_FALLBACK_VERSION)(void);
#include "icu-symbols.inc"
#undef ICU_SYMBOL

extern void CT_JOIN(udata_setCommonData, COTTONTAIL_ICU_FALLBACK_VERSION)(const void*, int32_t*);
extern void CT_JOIN(u_init, COTTONTAIL_ICU_FALLBACK_VERSION)(int32_t*);

static void* fallback_targets[] = {
#define ICU_SYMBOL(name) (void*)&CT_JOIN(name, COTTONTAIL_ICU_FALLBACK_VERSION),
#include "icu-symbols.inc"
#undef ICU_SYMBOL
};
#endif

static int initialized;
static char last_error[256];

static void set_error(const char* message, const char* detail)
{
    snprintf(last_error, sizeof(last_error), "%s%s%s",
        message, detail ? ": " : "", detail ? detail : "");
}

const char* cottontail_icu_last_error(void)
{
    return last_error[0] ? last_error : "unknown ICU initialization error";
}

static void commit(void** resolved)
{
    for (size_t i = 0; i < sizeof(entries) / sizeof(entries[0]); ++i)
        *entries[i].target = resolved[i];
    initialized = 1;
}

#if defined(_WIN32)
static void* lookup(void* library, const char* name)
{
    return (void*)GetProcAddress((HMODULE)library, name);
}
#else
static void* lookup(void* library, const char* name)
{
    return dlsym(library, name);
}
#endif

static int resolve_all(void* common, void* i18n, int version, int renamed, void** resolved)
{
    for (size_t i = 0; i < sizeof(entries) / sizeof(entries[0]); ++i) {
        char versioned[128];
        void* symbol = NULL;
        if (renamed) {
            snprintf(versioned, sizeof(versioned), "%s_%d", entries[i].name, version);
            symbol = lookup(i18n, versioned);
            if (!symbol)
                symbol = lookup(common, versioned);
        }
        if (!symbol)
            symbol = lookup(i18n, entries[i].name);
        if (!symbol)
            symbol = lookup(common, entries[i].name);
        if (!symbol) {
            set_error("ICU is missing a required C API", entries[i].name);
            return 0;
        }
        resolved[i] = symbol;
    }
    return 1;
}

int cottontail_icu_try_system(void)
{
    void* resolved[sizeof(entries) / sizeof(entries[0])] = { 0 };
    if (initialized)
        return 1;

#if defined(__linux__)
    for (int version = COTTONTAIL_ICU_MAX_VERSION; version >= COTTONTAIL_ICU_MIN_VERSION; --version) {
        char common_name[32];
        char i18n_name[32];
        snprintf(common_name, sizeof(common_name), "libicuuc.so.%d", version);
        snprintf(i18n_name, sizeof(i18n_name), "libicui18n.so.%d", version);
        void* common = dlopen(common_name, RTLD_NOW | RTLD_LOCAL);
        if (!common)
            continue;
        void* i18n = dlopen(i18n_name, RTLD_NOW | RTLD_LOCAL);
        if (i18n && resolve_all(common, i18n, version, 1, resolved)) {
            commit(resolved);
            return 1;
        }
        if (i18n)
            dlclose(i18n);
        dlclose(common);
    }
#elif defined(__APPLE__)
    void* system = dlopen("/usr/lib/libicucore.A.dylib", RTLD_NOW | RTLD_LOCAL);
    if (system) {
        typedef void (*GetVersion)(uint8_t[4]);
        uint8_t version[4] = { 0 };
        GetVersion get_version = (GetVersion)lookup(system, "u_getVersion");
        if (get_version)
            get_version(version);
        if (version[0] >= COTTONTAIL_ICU_MIN_VERSION
            && resolve_all(system, system, 0, 0, resolved)) {
            commit(resolved);
            return 1;
        }
        if (version[0] < COTTONTAIL_ICU_MIN_VERSION)
            set_error("system ICU is older than the required ABI", NULL);
    }
    if (system)
        dlclose(system);
#elif defined(_WIN32)
    HMODULE system = LoadLibraryW(L"icu.dll");
    if (system) {
        typedef void (__cdecl *GetVersion)(uint8_t[4]);
        uint8_t version[4] = { 0 };
        GetVersion get_version = (GetVersion)GetProcAddress(system, "u_getVersion");
        if (get_version)
            get_version(version);
        if (version[0] >= COTTONTAIL_ICU_MIN_VERSION
            && resolve_all(system, system, 0, 0, resolved)) {
            commit(resolved);
            return 1;
        }
        if (version[0] < COTTONTAIL_ICU_MIN_VERSION)
            set_error("system ICU is older than the required ABI", NULL);
    }
    if (system)
        FreeLibrary(system);
#endif

    if (!last_error[0])
        set_error("no compatible system ICU found", NULL);
    return 0;
}

int cottontail_icu_use_fallback(const void* data, size_t length)
{
    if (initialized)
        return 1;
#if defined(COTTONTAIL_ICU_HAS_FALLBACK)
    if (!data || length < 32) {
        set_error("pinned ICU data is empty", NULL);
        return 0;
    }
    int32_t status = 0;
    CT_JOIN(udata_setCommonData, COTTONTAIL_ICU_FALLBACK_VERSION)(data, &status);
    if (status > 0) {
        set_error("ICU rejected the pinned data", NULL);
        return 0;
    }
    CT_JOIN(u_init, COTTONTAIL_ICU_FALLBACK_VERSION)(&status);
    if (status > 0) {
        set_error("ICU fallback initialization failed", NULL);
        return 0;
    }
    commit(fallback_targets);
    return 1;
#else
    (void)data;
    (void)length;
    set_error("this build has no static ICU fallback", NULL);
    return 0;
#endif
}
