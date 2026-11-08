#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <pthread.h>
#include <time.h>
#include <unistd.h>

static void record(const char *event) {
    FILE *trace = fopen(getenv("COTTONTAIL_TEST_STARTUP_TRACE"), "a");
    if (!trace || fprintf(trace, "%s\n", event) < 0 || fclose(trace) != 0) _exit(70);
}

#ifdef FIXTURE_CORE
int electrobun_core_run_main_thread(const char *identifier, const char *name,
                                   const char *channel, int exit_code) {
    if (!pthread_main_np()) return 71;
    // Force the old startup order to expose itself: Core's ordinary lazy load
    // cannot happen until the script has observed whether its preload ran.
    const struct timespec interval = { .tv_sec = 0, .tv_nsec = 10000000 };
    int attempts = 0;
    while (access(getenv("COTTONTAIL_TEST_SCRIPT_DONE"), F_OK) != 0) {
        if (++attempts == 2000) return 72;
        nanosleep(&interval, NULL);
    }
    char path[4096];
    snprintf(path, sizeof(path), "%s/libNativeWrapper.dylib",
             getenv("COTTONTAIL_ELECTROBUN_DIST"));
    void *wrapper = dlopen(path, RTLD_NOW | RTLD_LOCAL);
    if (!wrapper) return 73;
    record("main-loop");
    dlclose(wrapper);
    const char *status = getenv("COTTONTAIL_TEST_CORE_STATUS");
    return status ? atoi(status) : 0;
}

const char *electrobun_core_last_error(void) {
    return "native startup fixture failure";
}
#else
__attribute__((constructor)) static void native_loaded(void) {
    if (!pthread_main_np()) _exit(74);
    record("native-loaded");
}

__attribute__((destructor)) static void native_unloaded(void) {
    record("native-unloaded");
}
#endif
