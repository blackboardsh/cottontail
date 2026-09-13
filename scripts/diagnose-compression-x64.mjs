import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, writeFileSync, createWriteStream, existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createServer } from 'node:http';
import { gzipSync, deflateSync, brotliCompressSync, zstdCompressSync } from 'node:zlib';

assert.equal(process.platform, 'linux');
assert.equal(process.arch, 'x64');
const root = resolve(process.argv[2]);
const output = resolve(process.argv[3]);
mkdirSync(output, { recursive: true });
const binary = join(root, 'zig-out/bin/cottontail');
const symbols = join(output, 'cottontail.unstripped');
const probe = join(root, 'tests/js/fixtures/compression-probe.mjs');
const content = JSON.stringify({ version: '1.2.3', artifact: 'update.app.tar.zst', resources: 'compressed response\n'.repeat(128) });
const frames = Object.fromEntries(Object.entries({ gzip: gzipSync, deflate: deflateSync, br: brotliCompressSync, zstd: zstdCompressSync })
  .map(([name, compress]) => [name, compress(Buffer.from(content))]));
const records = [];
function environment(cache, extras = {}) {
  const env = { ...process.env, COTTONTAIL_TMP_DIR: cache, ...extras };
  for (const key of ['COTTONTAIL_RUNTIME_MODULES_DIR', 'DYLD_LIBRARY_PATH', 'DYLD_FALLBACK_LIBRARY_PATH']) delete env[key];
  mkdirSync(cache, { recursive: true });
  return env;
}
async function execute(name, command, args, env, timeoutMs = 90_000) {
  const logfile = join(output, `${name}.log`);
  const stream = createWriteStream(logfile);
  const started = Date.now();
  const child = spawn(command, args, { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(stream, { end: false });
  child.stderr.pipe(stream, { end: false });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') console.error(error); }
  }, timeoutMs);
  let result;
  try {
    const [code, signal] = await once(child, 'close');
    result = { name, code, signal, timedOut, milliseconds: Date.now() - started };
  } finally {
    clearTimeout(timer);
    await new Promise(done => stream.end(done));
  }
  records.push(result);
  console.log(JSON.stringify(result));
  writeFileSync(join(output, 'results.json'), JSON.stringify(records, null, 2));
  return result;
}
const fresh = name => join(output, 'cache', name);
// This is the unchanged release gate, preserved before any debugger/probe runs.
await execute('first-existing-compression-gate', process.execPath, ['--test', 'scripts/compression-portability.test.js'], environment(fresh('first-existing')));

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
async function trace(name, cache, extras = {}) {
  const requests = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const encoding = url.pathname.slice(1);
    const frame = url.searchParams.has('invalid') ? Buffer.from([1, 2, 3, 4]) : frames[encoding];
    requests.push({ number: requests.length + 1, path: request.url, encoding, advertised: request.headers['accept-encoding'], at: Date.now() });
    writeFileSync(join(output, `${name}-requests.json`), JSON.stringify(requests, null, 2));
    if (!frame) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-encoding': encoding, 'content-type': 'application/json' });
    response.write(frame.subarray(0, 1));
    setImmediate(() => response.end(frame.subarray(1)));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const config = JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, content });
  const core = join(output, `${name}.core`);
  const gdb = join(output, `${name}.gdb`);
  writeFileSync(gdb, `set pagination off
set confirm off
set breakpoint pending on
set print thread-events off
file ${JSON.stringify(symbols)}
exec-file ${JSON.stringify(binary)}
set args ${[probe, config].map(quote).join(' ')}
handle SIGSEGV nostop noprint pass
handle SIGABRT nostop noprint pass
handle SIGUSR1 nostop noprint pass
handle SIGUSR2 nostop noprint pass
handle SIG34 nostop noprint pass
catch syscall rt_sigaction
commands
silent
if $rdi == 11 && $rsi != 0
printf "SIGSEGV handler transition\\n"
p *(void **)$rsi
bt 8
end
continue
end
break ct_crash_signal_handler
commands
silent
printf "FATAL COTTONTAIL HANDLER ENTRY\\n"
info args
info registers
thread apply all bt full
info proc mappings
generate-core-file ${core}
quit 86
end
run
quit 0
`);
  try {
    const result = await execute(name, 'gdb', ['-q', '-nx', '-batch', '-x', gdb], environment(cache, extras));
    result.requests = requests.length;
    result.core = existsSync(core);
    result.inferiorExitedNormally = /\[Inferior .* exited normally\]/.test(readFileSync(join(output, `${name}.log`), 'utf8'));
    writeFileSync(join(output, 'results.json'), JSON.stringify(records, null, 2));
    console.log(JSON.stringify({ ...result, lastRequest: requests.at(-1) }));
  } finally {
    server.closeAllConnections();
    await new Promise(done => server.close(done));
  }
}
await trace('gdb-default-cold', fresh('gdb-default'));
await trace('gdb-default-warm', fresh('gdb-default'));
await trace('gdb-dfg-disabled-cold', fresh('gdb-dfg-disabled'), { JSC_useDFGJIT: 'false' });
await trace('gdb-polling-traps-cold', fresh('gdb-polling-traps'), { JSC_usePollingTraps: 'true' });
await execute('fresh-worker-delayed-termination', process.execPath, ['--test', 'scripts/worker-delayed-termination.test.js'], environment(fresh('worker-delayed')));
// Diagnostics never reinterpret the failed release gate as resolved by a retry.
console.log('Diagnostic collection complete; canary9 original release failure remains authoritative.');
for (const record of records.filter(record => record.name.startsWith('gdb-'))) {
  assert(record.core || (record.inferiorExitedNormally && record.requests === 24),
    `Incomplete native GDB trace: ${JSON.stringify(record)}`);
}
