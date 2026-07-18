#pragma once

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

int cottontail_icu_try_system(void);
int cottontail_icu_use_fallback(const void* data, size_t length);
const char* cottontail_icu_last_error(void);

#ifdef __cplusplus
}
#endif
