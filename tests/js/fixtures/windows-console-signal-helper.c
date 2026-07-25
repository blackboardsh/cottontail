#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>

typedef LPWSTR *(WINAPI *CtCommandLineToArgvW)(LPCWSTR command_line, int *argument_count);

enum {
    CT_EXIT_USAGE = 10,
    CT_EXIT_ARGUMENTS = 11,
    CT_EXIT_CONSOLE = 12,
    CT_EXIT_CREATE_PROCESS = 13,
    CT_EXIT_CHILD_BEFORE_READY = 14,
    CT_EXIT_READY_TIMEOUT = 15,
    CT_EXIT_GENERATE_EVENT = 16,
    CT_EXIT_CHILD_TIMEOUT = 17,
    CT_EXIT_CHILD_STATUS = 18,
};

static wchar_t **ct_command_line_arguments(int *argument_count) {
    HMODULE shell32 = LoadLibraryW(L"shell32.dll");
    if (shell32 == NULL) return NULL;

    CtCommandLineToArgvW parse = (CtCommandLineToArgvW)(void *)GetProcAddress(shell32, "CommandLineToArgvW");
    if (parse == NULL) {
        FreeLibrary(shell32);
        return NULL;
    }

    wchar_t **arguments = parse(GetCommandLineW(), argument_count);
    FreeLibrary(shell32);
    return arguments;
}

static int ct_child_exit_code(HANDLE process, DWORD *exit_code) {
    if (!GetExitCodeProcess(process, exit_code)) return CT_EXIT_CHILD_STATUS;
    return 0;
}

int main(void) {
    int argument_count = 0;
    wchar_t **arguments = ct_command_line_arguments(&argument_count);
    if (arguments == NULL) return CT_EXIT_ARGUMENTS;
    if (argument_count != 5) {
        LocalFree(arguments);
        return CT_EXIT_USAGE;
    }

    /*
     * Give the target an isolated console so CTRL_BREAK_EVENT cannot reach the
     * test runner or its shell. The target gets a distinct process group in
     * this console, which lets GenerateConsoleCtrlEvent address it precisely.
     */
    (void)FreeConsole();
    if (!AllocConsole()) {
        LocalFree(arguments);
        return CT_EXIT_CONSOLE;
    }
    HWND console_window = GetConsoleWindow();
    if (console_window != NULL) (void)ShowWindow(console_window, SW_HIDE);

    const wchar_t *executable = arguments[1];
    const wchar_t *script = arguments[2];
    const wchar_t *result_path = arguments[3];
    const wchar_t *ready_path = arguments[4];
    if (wcschr(executable, L'"') != NULL ||
        wcschr(script, L'"') != NULL ||
        wcschr(result_path, L'"') != NULL ||
        wcschr(ready_path, L'"') != NULL) {
        (void)FreeConsole();
        LocalFree(arguments);
        return CT_EXIT_ARGUMENTS;
    }

    size_t command_capacity =
        wcslen(executable) + wcslen(script) + wcslen(result_path) + wcslen(ready_path) + 16;
    wchar_t *command_line = (wchar_t *)calloc(command_capacity, sizeof(wchar_t));
    if (command_line == NULL) {
        (void)FreeConsole();
        LocalFree(arguments);
        return CT_EXIT_ARGUMENTS;
    }
    if (swprintf(
            command_line,
            command_capacity,
            L"\"%ls\" \"%ls\" \"%ls\" \"%ls\"",
            executable,
            script,
            result_path,
            ready_path
        ) < 0) {
        free(command_line);
        (void)FreeConsole();
        LocalFree(arguments);
        return CT_EXIT_ARGUMENTS;
    }

    STARTUPINFOW startup;
    PROCESS_INFORMATION process;
    ZeroMemory(&startup, sizeof(startup));
    ZeroMemory(&process, sizeof(process));
    startup.cb = sizeof(startup);

    BOOL created = CreateProcessW(
        executable,
        command_line,
        NULL,
        NULL,
        FALSE,
        CREATE_NEW_PROCESS_GROUP | CREATE_UNICODE_ENVIRONMENT,
        NULL,
        NULL,
        &startup,
        &process
    );
    free(command_line);
    if (!created) {
        (void)FreeConsole();
        LocalFree(arguments);
        return CT_EXIT_CREATE_PROCESS;
    }

    DWORD ready_elapsed = 0;
    while (GetFileAttributesW(ready_path) == INVALID_FILE_ATTRIBUTES && ready_elapsed < 10000) {
        if (WaitForSingleObject(process.hProcess, 0) == WAIT_OBJECT_0) {
            CloseHandle(process.hThread);
            CloseHandle(process.hProcess);
            (void)FreeConsole();
            LocalFree(arguments);
            return CT_EXIT_CHILD_BEFORE_READY;
        }
        Sleep(10);
        ready_elapsed += 10;
    }

    if (GetFileAttributesW(ready_path) == INVALID_FILE_ATTRIBUTES) {
        (void)TerminateProcess(process.hProcess, CT_EXIT_READY_TIMEOUT);
        (void)WaitForSingleObject(process.hProcess, 1000);
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
        (void)FreeConsole();
        LocalFree(arguments);
        return CT_EXIT_READY_TIMEOUT;
    }

    if (!GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, process.dwProcessId)) {
        (void)TerminateProcess(process.hProcess, CT_EXIT_GENERATE_EVENT);
        (void)WaitForSingleObject(process.hProcess, 1000);
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
        (void)FreeConsole();
        LocalFree(arguments);
        return CT_EXIT_GENERATE_EVENT;
    }

    DWORD wait_result = WaitForSingleObject(process.hProcess, 10000);
    if (wait_result != WAIT_OBJECT_0) {
        (void)TerminateProcess(process.hProcess, CT_EXIT_CHILD_TIMEOUT);
        (void)WaitForSingleObject(process.hProcess, 1000);
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
        (void)FreeConsole();
        LocalFree(arguments);
        return CT_EXIT_CHILD_TIMEOUT;
    }

    DWORD exit_code = 0;
    int status = ct_child_exit_code(process.hProcess, &exit_code);
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    (void)FreeConsole();
    LocalFree(arguments);
    if (status != 0) return status;
    return exit_code <= 255 ? (int)exit_code : CT_EXIT_CHILD_STATUS;
}
