#include <stdint.h>

#if defined(_WIN32)
#include <windows.h>

void ct_sync_signal_forwarding_begin(void) {}
void ct_sync_signal_forwarding_set_pid(int64_t pid) { (void)pid; }
void ct_sync_signal_forwarding_end(void) {}

__declspec(noreturn) void ct_exit_with_signal(int signal_number) {
    ExitProcess((UINT)(128 + signal_number));
}
#else
#include <signal.h>
#include <string.h>
#include <unistd.h>

static volatile sig_atomic_t ct_forward_pid = 0;
static volatile sig_atomic_t ct_pending_signal = 0;
static volatile sig_atomic_t ct_forwarding_active = 0;
static struct sigaction ct_previous_actions[NSIG];
static unsigned char ct_action_installed[NSIG];

static const int ct_forwarded_signals[] = {
    SIGABRT,
    SIGALRM,
    SIGHUP,
    SIGINT,
    SIGTERM,
    SIGVTALRM,
    SIGXCPU,
    SIGXFSZ,
    SIGUSR2,
    SIGTRAP,
    SIGSYS,
    SIGQUIT,
    SIGIO,
#if defined(__linux__)
    SIGPWR,
    SIGSTKFLT,
#endif
};

static void ct_forward_signal(int signal_number) {
    sig_atomic_t pid = ct_forward_pid;
    if (pid == 0) {
        ct_pending_signal = signal_number;
        return;
    }
    (void)kill((pid_t)pid, signal_number);
}

void ct_sync_signal_forwarding_begin(void) {
    if (ct_forwarding_active) return;
    ct_forwarding_active = 1;
    ct_forward_pid = 0;
    ct_pending_signal = 0;
    memset(ct_action_installed, 0, sizeof(ct_action_installed));

    struct sigaction action;
    memset(&action, 0, sizeof(action));
    sigemptyset(&action.sa_mask);
    action.sa_flags = SA_RESETHAND;
    action.sa_handler = ct_forward_signal;

    for (size_t index = 0; index < sizeof(ct_forwarded_signals) / sizeof(ct_forwarded_signals[0]); index++) {
        int signal_number = ct_forwarded_signals[index];
        if (signal_number <= 0 || signal_number >= NSIG || ct_action_installed[signal_number]) continue;
        if (sigaction(signal_number, &action, &ct_previous_actions[signal_number]) == 0) {
            ct_action_installed[signal_number] = 1;
        }
    }
}

void ct_sync_signal_forwarding_set_pid(int64_t pid) {
    ct_forward_pid = (sig_atomic_t)pid;
    sig_atomic_t pending = ct_pending_signal;
    ct_pending_signal = 0;
    if (pending != 0 && ct_forward_pid != 0) {
        (void)kill((pid_t)ct_forward_pid, (int)pending);
    }
}

void ct_sync_signal_forwarding_end(void) {
    if (!ct_forwarding_active) return;
    ct_forward_pid = 0;
    ct_pending_signal = 0;
    for (size_t index = 0; index < sizeof(ct_forwarded_signals) / sizeof(ct_forwarded_signals[0]); index++) {
        int signal_number = ct_forwarded_signals[index];
        if (signal_number <= 0 || signal_number >= NSIG || !ct_action_installed[signal_number]) continue;
        (void)sigaction(signal_number, &ct_previous_actions[signal_number], NULL);
        ct_action_installed[signal_number] = 0;
    }
    ct_forwarding_active = 0;
}

__attribute__((noreturn)) void ct_exit_with_signal(int signal_number) {
    struct sigaction action;
    memset(&action, 0, sizeof(action));
    sigemptyset(&action.sa_mask);
    action.sa_handler = SIG_DFL;
    (void)sigaction(signal_number, &action, NULL);

    sigset_t unblocked;
    sigemptyset(&unblocked);
    sigaddset(&unblocked, signal_number);
    (void)sigprocmask(SIG_UNBLOCK, &unblocked, NULL);
    (void)raise(signal_number);
    _exit(128 + signal_number);
}
#endif
