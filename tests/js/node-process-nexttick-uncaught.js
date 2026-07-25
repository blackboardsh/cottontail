const expected = ["first", "second"];
let seen = 0;
let monitored = 0;

const deadline = setTimeout(() => {
  process.stderr.write(`timed out after ${seen} uncaughtException event(s)\n`);
  process.exit(2);
}, 15_000);

process.on("uncaughtExceptionMonitor", (error, origin) => {
  if (!(error instanceof Error) ||
      error.message !== expected[monitored] ||
      origin !== "uncaughtException") {
    process.stderr.write(
      `unexpected uncaughtExceptionMonitor: ${error?.message ?? error} (${origin})\n`,
    );
    process.exit(4);
  }
  monitored++;
});

process.on("unhandledRejection", error => {
  process.stderr.write(`unexpected unhandledRejection: ${error?.message ?? error}\n`);
  process.exit(5);
});

process.on("uncaughtException", (error, origin) => {
  if (!(error instanceof Error) || error.message !== expected[seen] || origin !== "uncaughtException") {
    process.stderr.write(
      `unexpected uncaughtException: ${error?.message ?? error} (${origin})\n`,
    );
    process.exit(3);
  }

  seen++;
  if (seen === expected.length) {
    if (monitored !== expected.length) {
      process.stderr.write(`expected ${expected.length} monitor events, received ${monitored}\n`);
      process.exit(6);
    }
    clearTimeout(deadline);
    process.stdout.write("node process nextTick uncaughtException passed\n");
  }
});

process.nextTick(() => { throw new Error("first"); });
process.nextTick(() => { throw new Error("second"); });
