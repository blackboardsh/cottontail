import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { nativeBoundaryPlan, runNativeBoundaryTest } from './test-native-boundary-release.js';

const plan = nativeBoundaryPlan(process.cwd());
await runNativeBoundaryTest(plan, {
  name: 'node-child-process-stdin-lifecycle.mjs',
  args: [resolve('tests/js/node-child-process-stdin-lifecycle.mjs')],
  timeoutMs: 90_000,
}, {
  spawnProcess(command, args, options) {
    console.log('OWNED CHILD ' + JSON.stringify({ argv: [command, ...args], cwd: options.cwd }));
    return spawn(command, args, options);
  },
});
console.log('DIAGNOSTIC OWNED STDIN PASSED');
