import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  startWindowsJobChild,
  terminateWindowsJobChild,
} from './windows-job-child.js';

const cottontailRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const runnerPath = join(cottontailRoot, 'scripts', 'run-upstream-tests.js');
const jobLauncher = process.env.COTTONTAIL_TEST_WINDOWS_JOB_LAUNCHER ??
  process.env.COTTONTAIL_UPSTREAM_JOB_LAUNCHER ??
  join(cottontailRoot, 'zig-out', 'bin', 'cottontail-bun-compat-job.exe');
const actualLauncherUnavailable = process.platform !== 'win32' || !existsSync(jobLauncher);
const actualLauncherOnly = {
  skip: actualLauncherUnavailable
    ? `native Windows Job Object launcher unavailable at ${jobLauncher}`
    : false,
};

function startActualTarget(args, spawnOptions = {}) {
  return startWindowsJobChild(process.execPath, args, {
    jobLauncher,
    spawnOptions,
    spawnProcess: spawn,
  });
}

function capture(child) {
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', chunk => { stdout += chunk; });
  child.stderr?.on('data', chunk => { stderr += chunk; });
  return {
    read() { return { stdout, stderr }; },
  };
}

function waitForClose(child, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => {
      finish(new Error(`child ${child.pid ?? 'without-pid'} did not close within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once('error', error => finish(error));
    child.once('close', (code, signal) => finish(null, { code, signal }));
  });
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessDeath(pid, label) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!processIsAlive(pid)) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(`${label} ${pid} survived Windows Job Object teardown`);
}

function forceKill(pid) {
  if (!processIsAlive(pid)) return;
  try { process.kill(pid, 'SIGKILL'); } catch {}
}

function detachedGrandchildSource({ stayAlive = false } = {}) {
  return `
    const { spawn } = require('node:child_process');
    const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    console.log('GRANDCHILD:' + grandchild.pid);
    grandchild.unref();
    ${stayAlive ? 'setInterval(() => {}, 1000);' : ''}
  `;
}

function pidFromOutput(output, label) {
  const match = output.match(new RegExp(`${label}:(\\d+)`));
  assert.ok(match, `missing ${label} PID in output: ${output}`);
  return Number(match[1]);
}

test('upstream runner routes every asynchronous Windows child through the native launcher', () => {
  const source = readFileSync(runnerPath, 'utf8').replace(/\r\n/g, '\n');
  assert.match(source, /--job-launcher <path>/);
  assert.match(source, /COTTONTAIL_UPSTREAM_JOB_LAUNCHER/);
  assert.match(source, /pinExecutable\(windowsJobLauncherPath, 'Windows Job Object launcher'\)/);
  assert.match(source, /spawnSync\(windowsJobLauncherPath, \['probe'\]/);
  assert.match(source, /result\.status !== 0/);
  assert.match(source, /return startWindowsJobChild\(command, args/);
  assert.match(source, /terminationProven = await terminateWindowsJobChild\(child/);
  assert.match(source, /Promise\.allSettled\(\s*children\.map\(\(child\) => terminateTrackedChild\(child\)\)/);
  assert.match(source, /attemptOutput\?\.write\('stdout', data\);[\s\S]*?catch \(error\) \{\s*void settle/);
  assert.match(source, /await preflightBinary\(\)/);
  assert.match(source, /await preflightCommandAdapter\(\)/);
  assert.match(source, /await prepareNodeHarnessInventory\(targetSnapshotRoot\(name, targets\[name\]\)\)/);
  assert.match(source, /await prepareBunTestDependencies\(entries, snapshotRoot\)/);
  assert.match(source, /await discoverBundlerTestIds\(entry, snapshotRoot, target\)/);
  assert.equal([...source.matchAll(/\bspawn\s*\(/g)].length, 1);
  assert.doesNotMatch(source, /taskkill/i);
});

test('launcher adapter reuses the opaque Job name for bounded termination proof', async () => {
  const calls = [];
  const child = new EventEmitter();
  child.pid = 1234;
  const started = startWindowsJobChild('runtime.exe', ['one', 'two'], {
    jobLauncher: 'launcher.exe',
    parentPid: 5678,
    spawnOptions: { cwd: 'fixture' },
    spawnProcess(command, args, options) {
      calls.push({ command, args, options });
      return child;
    },
  });
  assert.equal(started, child);
  assert.equal(calls[0].command, 'launcher.exe');
  assert.equal(calls[0].args[0], 'run');
  assert.match(calls[0].args[1], /^Local\\CottontailBunCompat-[0-9a-f-]+$/i);
  assert.deepEqual(calls[0].args.slice(2), ['5678', 'runtime.exe', 'one', 'two']);
  assert.deepEqual(calls[0].options, { cwd: 'fixture' });

  const terminator = new EventEmitter();
  terminator.kill = () => {};
  const proof = terminateWindowsJobChild(child, {
    timeoutMs: 2000,
    watchdogMs: 2500,
    spawnProcess(command, args, options) {
      calls.push({ command, args, options });
      queueMicrotask(() => terminator.emit('close', 0));
      return terminator;
    },
  });
  assert.equal(await proof, true);
  assert.equal(calls[1].command, 'launcher.exe');
  assert.deepEqual(calls[1].args, ['terminate', calls[0].args[1], '2000']);
  assert.deepEqual(calls[1].options, { stdio: 'ignore', windowsHide: true });
});

test('bounded terminator retries the Job-creation startup race with the same name', async () => {
  const calls = [];
  const child = new EventEmitter();
  child.pid = 1234;
  startWindowsJobChild('runtime.exe', [], {
    jobLauncher: 'launcher.exe',
    parentPid: 5678,
    spawnOptions: {},
    spawnProcess(command, args, options) {
      calls.push({ command, args, options });
      return child;
    },
  });

  const proof = terminateWindowsJobChild(child, {
    timeoutMs: 200,
    watchdogMs: 500,
    spawnProcess(command, args, options) {
      calls.push({ command, args, options });
      const terminator = new EventEmitter();
      terminator.kill = () => {};
      const status = calls.length === 2 ? 1 : 0;
      queueMicrotask(() => terminator.emit('close', status));
      return terminator;
    },
  });
  assert.equal(await proof, true);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2].args, calls[1].args);
});

test('actual launcher probe and run preserve argv, environment, cwd, stdio, and exit code', actualLauncherOnly, async t => {
  const probe = spawnSync(jobLauncher, ['probe'], { timeout: 5000, windowsHide: true });
  assert.ifError(probe.error);
  assert.equal(probe.status, 0);

  const cwd = mkdtempSync(join(os.tmpdir(), 'cottontail-job-contract-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const expectedArgs = ['', 'space value', 'quote"value', 'trailing\\', 'rabbit-\u{1f407}'];
  const source = `
    process.stdin.setEncoding('utf8');
    let stdin = '';
    process.stdin.on('data', chunk => { stdin += chunk; });
    process.stdin.on('end', () => {
      console.log(JSON.stringify({
        argv: process.argv.slice(1),
        cwd: process.cwd(),
        marker: process.env.COTTONTAIL_JOB_MARKER,
        stdin,
      }));
      console.error('STDERR-SENTINEL');
      process.exit(23);
    });
  `;
  const child = startActualTarget(['-e', source, ...expectedArgs], {
    cwd,
    env: { ...process.env, COTTONTAIL_JOB_MARKER: 'environment value' },
  });
  const output = capture(child);
  const closed = waitForClose(child);
  child.stdin.end('STDIN-SENTINEL');
  const result = await closed;
  const captured = output.read();

  assert.equal(result.code, 23);
  assert.match(captured.stderr, /STDERR-SENTINEL/);
  const record = JSON.parse(captured.stdout.trim());
  assert.deepEqual(record.argv, expectedArgs);
  assert.equal(record.cwd.toLowerCase(), cwd.toLowerCase());
  assert.equal(record.marker, 'environment value');
  assert.equal(record.stdin, 'STDIN-SENTINEL');
});

test('actual launcher kills a detached grandchild after normal target exit', actualLauncherOnly, async t => {
  const child = startActualTarget(['-e', detachedGrandchildSource()]);
  const output = capture(child);
  const result = await waitForClose(child);
  const grandchildPid = pidFromOutput(output.read().stdout, 'GRANDCHILD');
  t.after(() => forceKill(grandchildPid));

  assert.equal(result.code, 0);
  await waitForProcessDeath(grandchildPid, 'detached grandchild after normal exit');
});

test('actual bounded terminate command kills a detached grandchild after timeout', actualLauncherOnly, async t => {
  const child = startActualTarget(['-e', detachedGrandchildSource({ stayAlive: true })]);
  const output = capture(child);
  const closed = waitForClose(child);
  let grandchildPid;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    grandchildPid = output.read().stdout.match(/GRANDCHILD:(\d+)/)?.[1];
    if (grandchildPid != null) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  grandchildPid = Number(grandchildPid);
  assert.ok(Number.isInteger(grandchildPid), `missing grandchild PID: ${output.read().stderr}`);
  t.after(() => forceKill(grandchildPid));

  const proven = await terminateWindowsJobChild(child, {
    spawnProcess: spawn,
    timeoutMs: 2000,
    watchdogMs: 2500,
  });
  const result = await closed;
  assert.equal(proven, true);
  assert.notEqual(result.code, null);
  await waitForProcessDeath(grandchildPid, 'detached grandchild after bounded terminate');
});
