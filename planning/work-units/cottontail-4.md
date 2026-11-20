# Asynchronous FFI C-string ownership

Owning issue: <https://github.com/kortexa-ai/cottontail/issues/4>.

Threadsafe void callbacks can return to a native caller before the JavaScript
thread drains their jobs. Each queued `cstring` argument therefore needs an
owned NUL-terminated copy. Null pointers remain null; empty strings get a copy
of their terminator. Plain `ptr` arguments remain borrowed. Synchronous calls
and foreign-thread calls that wait for a result retain their pointer identity.

Free the copies after delivery, when a closed callback is skipped, when queue
cleanup discards a job, and after a partial allocation failure. A copied pointer
is valid during the JavaScript callback only; consumers must decode or copy it
before returning.

The native test joins a worker before the JavaScript owner can drain callbacks.
The worker reuses the same buffers for a burst of ASCII and Unicode values, so
the old behavior fails deterministically without reading freed memory. Additional
cases cover pointer borrowing, foreign-thread return values, and closing before
or during queue delivery.

Run `./zig-out/bin/cottontail test tests/js/bun-ffi-threadsafe-cstrings.test.ts`
after building the runtime. `scripts/test-js.js` includes the regression in the
repository suite. Consumer validation must also repeat Electrobun's native
rapid text-input fixture. This change supplies string lifetime; it does not
implement an input method editor.
