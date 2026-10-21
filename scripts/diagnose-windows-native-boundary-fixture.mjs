// Diagnostic entrypoint: each unchanged native boundary fixture gets its own
// process, preserving the production driver's Job ownership and deadlines.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { nativeBoundaryPlan, runNativeBoundaryTest } from './test-native-boundary-release.js';

const plan = nativeBoundaryPlan(process.cwd());
const fixture = plan.tests.find(test => test.name === process.argv[2]);
assert.ok(fixture, `Unknown native boundary fixture: ${process.argv[2]}`);
await runNativeBoundaryTest(plan, fixture, {
  spawnProcess(command, args, options) {
    console.log('OWNED CHILD ' + JSON.stringify({ argv: [command, ...args], cwd: options.cwd }));
    return spawn(command, args, options);
  },
});
console.log(`DIAGNOSTIC BOUNDARY PASSED ${fixture.name}`);
