import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { createSocket } from "node:dgram";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const mode = process.argv.find((arg) => arg.endsWith("-child"));
if (mode) {
  const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
  server.unref();
  if (mode === "--ref-child") {
    server.ref();
    // The listener alone must keep the runtime alive until this unref'd timer.
    setTimeout(() => {
      console.log("referenced HTTP listener kept process alive");
      server.stop(true);
    }, 80).unref();
  } else {
    console.log("unreferenced HTTP listener ready");
  }
} else {
  let onAbortStarted, onAborted, onSlowStarted;
  const abortStarted = new Promise((resolve) => { onAbortStarted = resolve; });
  const aborted = new Promise((resolve) => { onAborted = resolve; });
  const slowStarted = new Promise((resolve) => { onSlowStarted = resolve; });
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/buffer") return new Response(await request.text());
      if (path === "/stream") {
        const reader = request.body.getReader();
        let text = "";
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          text += decoder.decode(value, { stream: true });
        }
        return new Response(text + decoder.decode());
      }
      if (path === "/response") {
        return new Response(new ReadableStream({
          async start(controller) {
            const encode = (text) => new TextEncoder().encode(text);
            controller.enqueue(encode("first "));
            await delay(35);
            controller.enqueue(encode("second"));
            controller.close();
          },
        }));
      }
      if (path === "/abort") {
        onAbortStarted();
        await new Promise((resolve) => request.signal.addEventListener("abort", resolve, { once: true }));
        onAborted();
        return new Response("aborted");
      }
      if (path === "/slow") {
        onSlowStarted();
        await delay(50);
        return new Response("drained");
      }
      return new Response("awake");
    },
  });
  const nativePoll = typeof cottontail === "undefined" ? null : cottontail.httpServerPoll;
  let polls = 0;
  if (nativePoll) cottontail.httpServerPoll = (...args) => { polls++; return nativePoll(...args); };
  const watchdog = setTimeout(() => { throw new Error("HTTP idle lifecycle fixture timed out"); }, 15_000);
  const udp = createSocket("udp4");
  const request = (path, chunks = null) => new Promise((resolve, reject) => {
    const client = httpRequest({
      hostname: "127.0.0.1", port: server.port, path,
      method: chunks ? "POST" : "GET", agent: false,
    }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolve(text));
      response.on("error", reject);
    });
    client.on("error", reject);
    if (chunks) {
      (async () => {
        for (const chunk of chunks) {
          client.write(chunk);
          await delay(25);
        }
        client.end();
      })().catch(reject);
    } else client.end();
  });
  try {
    await delay(100);
    assert.equal(polls, 0, "Idle native HTTP listeners must not poll for requests");
    assert.equal(await request("/"), "awake", "A request after idle must wake the listener");
    if (nativePoll) assert.ok(polls > 0, "The counter must observe real native HTTP requests");
    await new Promise((resolve, reject) => { udp.once("error", reject); udp.bind(0, "127.0.0.1", resolve); });
    const packet = new Promise((resolve) => udp.once("message", (data) => resolve(data.toString())));
    udp.send("shared dispatcher", udp.address().port, "127.0.0.1");
    assert.equal(await packet, "shared dispatcher");
    assert.equal(await request("/buffer", ["hello ", "world"]), "hello world");
    assert.equal(await request("/stream", ["delayed ", "stream"]), "delayed stream");
    assert.equal(await request("/response"), "first second");
    const abortClient = httpRequest({ hostname: "127.0.0.1", port: server.port, path: "/abort", agent: false });
    abortClient.on("error", () => {});
    abortClient.end();
    await abortStarted;
    abortClient.destroy();
    await aborted;
    await delay(40);
    const drainedPolls = polls;
    await delay(100);
    assert.equal(polls, drainedPolls, "Drained HTTP listeners must return to idle without polling");
    assert.equal(await request("/"), "awake", "The listener must wake again after returning to idle");
    const slow = request("/slow");
    await slowStarted;
    const stopped = server.stop(false);
    assert.equal(await slow, "drained");
    await stopped;
    assert.equal(server.pendingRequests, 0, "Graceful stop must settle when native clients finish");
  } finally {
    udp.close();
    await server.stop(true);
    if (nativePoll) cottontail.httpServerPoll = nativePoll;
    clearTimeout(watchdog);
  }
  for (const childMode of ["--unref-child", "--ref-child"]) {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), childMode], {
      encoding: "utf8", timeout: 10_000,
    });
    assert.equal(child.error, undefined, child.error?.message);
    assert.equal(child.status, 0, child.stderr);
    assert.ok(child.stdout.includes(childMode === "--ref-child"
      ? "referenced HTTP listener kept process alive" : "unreferenced HTTP listener ready"), child.stdout);
  }
  console.log("bun serve idle lifecycle passed");
}
