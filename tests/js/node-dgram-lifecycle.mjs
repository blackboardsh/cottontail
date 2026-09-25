import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import { createServer, createConnection } from "node:net";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const bind = (socket, address = "127.0.0.1") => new Promise((resolve, reject) => {
  socket.once("error", reject);
  socket.bind(0, address, () => { socket.off("error", reject); resolve(); });
});
const mode = process.argv.find((arg) => arg.endsWith("-child"));
if (mode) {
  const socket = createSocket("udp4");
  if (mode !== "--unref-after-bind-child") socket.unref();
  await bind(socket);
  if (mode === "--ref-child") {
    socket.ref();
    // Only the socket keeps this process alive long enough to run the timer.
    setTimeout(() => {
      console.log("referenced UDP socket kept process alive");
      socket.close();
    }, 80).unref();
  } else {
    socket.unref();
    console.log("unreferenced UDP socket bound");
  }
} else {
  for (const [type, address, family] of [["udp4", "127.0.0.1", "IPv4"], ["udp6", "::1", "IPv6"]]) {
    const a = createSocket(type), b = createSocket(type);
    const errors = [];
    a.on("error", (error) => errors.push(error));
    b.on("error", (error) => errors.push(error));
    await Promise.all([bind(a, address), bind(b, address)]);
    a.unref().ref();
    const timer = setTimeout(() => { throw new Error("UDP lifecycle fixture timed out"); }, 10000);
    const server = createServer((socket) => socket.end("TCP dispatcher remains live"));
    let tcp;
    let receiveCalls = 0;
    const nativeReceive = typeof cottontail === "undefined" ? null : cottontail.udpSocketReceive;
    if (nativeReceive) {
      cottontail.udpSocketReceive = (...args) => { receiveCalls++; return nativeReceive(...args); };
    }
    try {
      await delay(80);
      assert.equal(receiveCalls, 0, "An idle UDP socket must not repeatedly enter the native receive path");
      // TCP and UDP must share the native event dispatcher without replacing
      // each other's listeners, regardless of which socket starts first.
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const tcpResult = new Promise((resolve, reject) => {
        tcp = createConnection(server.address().port, "127.0.0.1");
        let received = "";
        tcp.on("data", (data) => { received += data.toString(); });
        tcp.on("end", () => resolve(received));
        tcp.on("error", reject);
      });
      const payloads = ["", ...Array.from({ length: 16 }, (_, index) => `${index}: 日本語 🌊`)];
      const received = [];
      const complete = new Promise((resolve) => b.on("message", (data, info) => {
        assert.equal(info.port, a.address().port);
        assert.equal(info.address, address);
        assert.equal(info.family, family);
        assert.equal(info.size, data.byteLength);
        received.push(data.toString());
        if (received.length === payloads.length) resolve();
      }));
      for (const payload of payloads) a.send(payload, b.address().port, address);
      await complete;
      assert.deepEqual(received, payloads, "Empty packets are messages, not EOF; bursts preserve datagram boundaries");
      assert.equal(await tcpResult, "TCP dispatcher remains live");
      b.removeAllListeners("message");
      const drainedCalls = receiveCalls;
      if (nativeReceive) assert.ok(drainedCalls >= payloads.length, "The counter must observe actual packet receives");
      await delay(80);
      assert.equal(receiveCalls, drainedCalls, "Drained UDP sockets must return to idle without receive polling");

      // A later packet requires the one-shot native readiness watch to rearm.
      const nextPacket = new Promise((resolve) => b.once("message", (data) => resolve(data.toString())));
      a.send("after idle", b.address().port, address);
      assert.equal(await nextPacket, "after idle");

      // Numeric peers bypass native name resolution, while names and scoped
      // IPv6 addresses must still use the OS resolver. Exercise actual packets
      // so the sockaddr family, port byte order, and IPv6 scope stay intact.
      for (const target of type === "udp4" ? ["localhost"] : ["0:0:0:0:0:0:0:1", "::1%0"]) {
        const marker = `resolved peer ${target}`;
        const packet = new Promise((resolve) => b.once("message", (data, info) => {
          resolve({ text: data.toString(), address: info.address, port: info.port });
        }));
        await new Promise((resolve, reject) => {
          a.send(marker, b.address().port, target, (error) => error ? reject(error) : resolve());
        });
        assert.deepEqual(await packet, { text: marker, address, port: a.address().port });
      }

      const watchId = b._receiveWatchId;
      const closed = new Promise((resolve) => b.once("close", resolve));
      let callbacks = 0;
      b.on("message", () => { callbacks++; b.close(); });
      const port = b.address().port;
      a.send("close in message callback", port, address);
      a.send("queued before close", port, address);
      await closed;
      await delay(20);
      assert.equal(callbacks, 1);
      if (nativeReceive) {
        assert.equal(b._receiveWatchId, 0, "Closing stops the native receive watch");
        assert.equal(b._receiveTimer, null, "Closing clears deferred receive callbacks");
        assert.equal(globalThis.__cottontailFdWatchListeners.has(watchId), false, "Closing removes the dispatcher listener");
      }
      assert.deepEqual(errors, [], "Closing within a message handler must not read from the closed descriptor");
    } finally {
      if (nativeReceive) cottontail.udpSocketReceive = nativeReceive;
      clearTimeout(timer);
      tcp?.destroy();
      if (!a.closed) a.close();
      // Node does not expose .closed; b was closed by the successful message case.
      if (b._bindState !== "closed") { try { b.close(); } catch {} }
      await new Promise((resolve) => server.close(resolve));
    }
  }
  if (typeof cottontail !== "undefined") {
    for (const [family, wildcard] of [[4, "0.0.0.0"], [6, "::"]]) {
      const { fd } = cottontail.udpSocketCreate(family);
      try {
        if (family === 4) {
          assert.throws(() => cottontail.udpSocketBind(fd, 0, "::1", family),
            undefined, "An IPv6 address must not bypass IPv4 resolver validation");
        }
        const bound = cottontail.udpSocketBind(fd, 0, null, family);
        assert.equal(bound.address, wildcard, "Missing bind addresses retain the OS wildcard behavior");
        assert.equal(bound.family, `IPv${family}`);
        assert.ok(bound.port > 0);
      } finally {
        cottontail.udpSocketClose(fd);
      }
    }
    const socket = createSocket("udp4");
    const fd = socket.fd;
    const nativeStart = cottontail.fdWatchStart;
    const failure = new Error("fixture receive watch startup failure");
    const closed = new Promise((resolve) => socket.once("close", resolve));
    try {
      cottontail.fdWatchStart = () => { throw failure; };
      const failed = new Promise((resolve) => socket.once("error", resolve));
      socket.bind(0, "127.0.0.1");
      assert.equal(await failed, failure);
      await closed;
      assert.equal(socket.closed, true, "Receive watch startup failure closes the already bound socket");
      assert.equal(socket._bindState, "closed");
      assert.equal(socket.fd, null);
      assert.throws(() => cottontail.udpSocketAddress(fd), undefined, "The native descriptor must also be released");
    } finally {
      cottontail.fdWatchStart = nativeStart;
      if (!socket.closed) socket.close();
    }
  }
  for (const mode of ["--unref-before-bind-child", "--unref-after-bind-child", "--ref-child"]) {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), mode], {
      encoding: "utf8", timeout: 10000,
    });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, mode === "--ref-child"
      ? /referenced UDP socket kept process alive/
      : /unreferenced UDP socket bound/);
  }
  console.log("node dgram lifecycle passed");
}
