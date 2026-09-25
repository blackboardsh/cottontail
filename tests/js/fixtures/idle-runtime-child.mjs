import { Worker, isMainThread, parentPort } from "node:worker_threads";

function measureIdle() {
  // Exclude bootstrap work, then count loop turns rather than CPU time so this
  // regression remains useful on both slow CI runners and fast developer hosts.
  setTimeout(() => {
    const before = cottontail.runtimeDiagnostics().eventLoop.numPolls;
    const started = Date.now();
    setTimeout(() => {
      const polls = cottontail.runtimeDiagnostics().eventLoop.numPolls - before;
      const elapsed = Date.now() - started;
      const result = { polls, elapsed };
      if (parentPort) parentPort.postMessage(result);
      else console.log(JSON.stringify(result));
    }, 600);
  }, 100);
}

if (!isMainThread) {
  // Keep a messaging handle alive after bootstrap, like Dash's background
  // workers. A listening worker must be able to sleep while it has no work.
  parentPort.on("message", (message) => {
    if (message === "measure") measureIdle();
  });
  parentPort.postMessage("ready");
} else if (process.argv[2] === "worker") {
  const worker = new Worker(new URL(import.meta.url));
  worker.on("message", async (message) => {
    if (message === "ready") worker.postMessage("measure");
    else {
      console.log(JSON.stringify(message));
      await worker.terminate();
    }
  });
} else if (process.argv[2] === "timers") {
  // Use callbacks in an ordinary post-evaluation loop. An async test runner's
  // top-level-await pump could otherwise hide a timer deadline regression.
  setTimeout(() => {
    const started = Date.now();
    let remaining = 6;
    const tick = () => {
      if (--remaining > 0) setTimeout(tick, 3);
      else console.log(JSON.stringify({ elapsed: Date.now() - started }));
    };
    setTimeout(tick, 3);
  }, 100);
} else {
  measureIdle();
}
