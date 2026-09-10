import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import events from "node:events";
import { finished } from "node:stream/promises";

const { once } = events;

async function withChild(name, run, source = "process.stdin.pipe(process.stdout)", expectedError = undefined) {
  const file = expectedError ? `${process.execPath}-missing-stdin-test`
    : process.platform === "win32" ? process.execPath : "/bin/sh";
  const args = process.platform === "win32" ? ["-e", source] : ["-c", source ? "cat" : "exit 0"];
  const child = spawn(file, args, {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  let childError;
  child.on("error", (error) => { childError = error; });
  const closed = new Promise((resolve) => child.once("close", (...args) => resolve(args)));
  let timer;
  try {
    await Promise.race([
      run(child, closed, () => stdout),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${name} timed out: ${stderr}`)), 15_000);
      }),
    ]);
    assert.equal(stderr, "", `${name}: unexpected child stderr`);
    assert.equal(childError?.code, expectedError);
    console.log(`ok ${name}`);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed.catch(() => {});
  }
}

await withChild("end is synchronous state change but asynchronous finish", async (child, closed) => {
  const stdin = child.stdin;
  const events = [];
  stdin.on("finish", () => {
    events.push("finish");
    assert.equal(stdin.writableFinished, true);
  });
  stdin.on("close", () => events.push("close"));
  assert.equal(stdin.end(), stdin);
  assert.equal(stdin.writable, false);
  assert.equal(stdin.writableEnded, true);
  assert.equal(stdin.writableFinished, false);
  assert.deepEqual(events, []);

  // Miniflare/Workerd writes its config, then subscribes to finish this way.
  // A synchronous finish event is lost and leaves Wrangler dev waiting forever.
  await once(stdin, "finish");
  assert.deepEqual(await closed, [0, null]);
  assert.deepEqual(events, ["finish", "close"]);
});

await withChild("write and repeated end callbacks precede one finish", async (child, closed, output) => {
  const stdin = child.stdin;
  const events = [];
  stdin.on("finish", () => events.push("finish"));
  stdin.on("close", () => events.push("close"));
  const complete = finished(stdin);
  stdin.write("41", "hex", (error) => {
    assert.equal(error == null, true);
    events.push("write");
  });
  stdin.write(new Uint8Array([0, 66]), (error) => {
    assert.equal(error == null, true);
    events.push("write2");
  });
  stdin.end("43", "hex", (error) => {
    assert.equal(error == null, true);
    events.push("end");
  });
  stdin.end((error) => {
    assert.equal(error == null, true);
    events.push("end2");
  });
  assert.deepEqual(events, []);
  await complete;
  assert.deepEqual(await closed, [0, null]);
  assert.equal(output(), "A\0BC");
  assert.deepEqual(events, ["write", "write2", "end", "end2", "finish", "close"]);
  stdin.end();
  stdin.destroy();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(events, ["write", "write2", "end", "end2", "finish", "close"]);
});

await withChild("destroy cancels pending finish and closes once", async (child, closed) => {
  const stdin = child.stdin;
  const events = [];
  const failure = new Error("intentional stdin destruction");
  stdin.on("finish", () => events.push("finish"));
  stdin.on("error", (error) => {
    assert.equal(error, failure);
    events.push("error");
  });
  stdin.on("close", () => events.push("close"));
  stdin.end();
  assert.equal(stdin.destroy(failure), stdin);
  stdin.destroy(failure);
  assert.equal(stdin.destroyed, true);
  assert.equal(stdin.writableFinished, false);
  assert.deepEqual(events, []);
  await closed;
  assert.deepEqual(events, ["error", "close"]);
  assert.equal(stdin.writableFinished, false);
});

await withChild("child exit destroys stdin without claiming it finished", async (child, closed) => {
  const stdin = child.stdin;
  const events = [];
  stdin.on("finish", () => events.push("finish"));
  stdin.on("close", () => events.push("close"));
  await closed;
  // Stream close may be queued separately from child close.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(events, ["close"]);
  assert.equal(stdin.destroyed, true);
  assert.equal(stdin.writable, false);
  assert.equal(stdin.writableEnded, false);
  assert.equal(stdin.writableFinished, false);
  stdin.destroy();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(events, ["close"]);
}, "");

await withChild("write after end reports an error asynchronously", async (child, closed, output) => {
  const stdin = child.stdin;
  const events = [];
  stdin.on("finish", () => events.push("finish"));
  stdin.on("error", (error) => events.push(error.code));
  stdin.on("close", () => events.push("close"));
  stdin.end("accepted");
  assert.equal(stdin.write("rejected", (error) => {
    events.push(`callback:${error.code}`);
  }), false);
  assert.deepEqual(events, []);
  await closed;
  assert.equal(output(), "accepted");
  assert.deepEqual(events, ["callback:ERR_STREAM_WRITE_AFTER_END", "ERR_STREAM_WRITE_AFTER_END", "close"]);
});

await withChild("failed spawn destroys stdin without finish", async (child, closed) => {
  const stdin = child.stdin;
  const events = [];
  stdin.on("finish", () => events.push("finish"));
  stdin.on("close", () => events.push("close"));
  await closed;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(events, ["close"]);
  assert.equal(stdin.destroyed, true);
  assert.equal(stdin.writableFinished, false);
}, "", "ENOENT");

console.log("node child_process stdin lifecycle passed");
