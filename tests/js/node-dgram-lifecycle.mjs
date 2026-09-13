import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import { createServer, createConnection } from "node:net";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const bind = (socket) => new Promise((resolve, reject) => {
  socket.once("error", reject);
  socket.bind(0, "127.0.0.1", () => { socket.off("error", reject); resolve(); });
});
if (process.argv.includes("--unref-child")) {
  const socket = createSocket("udp4");
  socket.unref();
  await bind(socket);
  console.log("unreferenced UDP socket bound");
} else {
  const a = createSocket("udp4"), b = createSocket("udp4");
  const errors = [];
  a.on("error", (error) => errors.push(error));
  b.on("error", (error) => errors.push(error));
  await Promise.all([bind(a), bind(b)]);
  a.unref().ref();
  const timer = setTimeout(() => { throw new Error("UDP lifecycle fixture timed out"); }, 10000);
  const server = createServer((socket) => socket.end("TCP dispatcher remains live"));
  let tcp;
  try {
    // TCP and UDP must remain live together, independently of how the
    // platform receives UDP packets (intervals, threads, or native readiness).
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const tcpResult = new Promise((resolve, reject) => {
      tcp = createConnection(server.address().port, "127.0.0.1");
      let received = "";
      tcp.on("data", (data) => { received += data.toString(); });
      tcp.on("end", () => resolve(received));
      tcp.on("error", reject);
    });
    const payloads = ["", ...Array.from({ length: 16 }, (_, index) => `${index}: \u65e5\u672c\u8a9e \ud83c\udf0a`)];
    const received = [];
    const complete = new Promise((resolve) => b.on("message", (data, info) => {
      assert.equal(info.port, a.address().port);
      assert.equal(info.address, "127.0.0.1");
      received.push(data.toString());
      if (received.length === payloads.length) resolve();
    }));
    for (const payload of payloads) a.send(payload, b.address().port, "127.0.0.1");
    await complete;
    assert.deepEqual(received, payloads, "Empty packets are messages, not EOF; bursts preserve datagram boundaries");
    assert.equal(await tcpResult, "TCP dispatcher remains live");
    b.removeAllListeners("message");
    const closed = new Promise((resolve) => b.once("close", resolve));
    let callbacks = 0;
    b.on("message", () => { callbacks++; b.close(); });
    a.send("close in message callback", b.address().port, "127.0.0.1");
    await closed;
    assert.equal(callbacks, 1);
    if (typeof cottontail !== "undefined") assert.equal(b._pollTimer, null, "Closing stops the receive interval");
    assert.deepEqual(errors, [], "Closing within a message handler must not read from the closed descriptor");
  } finally {
    clearTimeout(timer);
    tcp?.destroy();
    if (!a.closed) a.close();
    // Node does not expose .closed; b was closed by the successful message case.
    if (b._bindState !== "closed") { try { b.close(); } catch {} }
    await new Promise((resolve) => server.close(resolve));
  }
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--unref-child"], {
    encoding: "utf8", timeout: 10000,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /unreferenced UDP socket bound/);
  console.log("node dgram lifecycle passed");
}
