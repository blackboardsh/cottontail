// A process blocked in Bun.spawnSync forwards termination signals to its
// child so the child can shut down first. It must not *keep* the signal: a
// runner that loops over spawnSync (every upstream test file that shells out)
// would otherwise be permanently immune to SIGTERM, outlive its supervisor's
// timeout, and leave the child it was waiting on orphaned at full CPU.

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const spawnLoop = `for (;;) { Bun.spawnSync({ cmd: [process.execPath, "-e", "await Bun.sleep(400)"] }); }`;

const runner = Bun.spawn({
  cmd: [process.execPath, "-e", spawnLoop],
  stdin: "ignore",
  stdout: "ignore",
  stderr: "ignore",
});

// Let the runner reach its first blocking spawnSync before signalling it.
await Bun.sleep(3000);
assert(runner.exitCode === null && runner.signalCode === null, "runner exited before it was signalled");

runner.kill("SIGTERM");

const outcome = await Promise.race([
  runner.exited.then(() => "exited" as const),
  Bun.sleep(20000).then(() => "hung" as const),
]);

assert(outcome === "exited", "spawnSync swallowed SIGTERM: the runner outlived a termination signal");
assert(
  runner.signalCode === "SIGTERM" || runner.exitCode === 128 + 15,
  `runner did not terminate with SIGTERM: signal=${runner.signalCode} exit=${runner.exitCode}`,
);

console.log("spawn-sync signal containment ok");
