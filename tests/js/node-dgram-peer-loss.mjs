import assert from "node:assert/strict";
import { createSocket } from "node:dgram";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const bind = (socket, address, port = 0) => new Promise((resolve, reject) => {
  socket.once("error", reject);
  socket.bind(port, address, () => { socket.removeListener("error", reject); resolve(); });
});
const close = (socket) => new Promise((resolve) => socket.close(resolve));
const send = (socket, bytes, port, address) => new Promise((resolve, reject) => {
  socket.send(bytes, port, address, (error) => error ? reject(error) : resolve());
});

async function connectedPeerRecovery(client, family, address, peerPort) {
  const localPort = client.address().port;
  const replacement = createSocket(family);
  const nativeReceive = typeof cottontail === "undefined" ? null : cottontail.udpSocketReceive;
  let receiveCalls = 0;
  try {
    await new Promise((resolve) => client.connect(peerPort, address, resolve));
    if (nativeReceive) {
      cottontail.udpSocketReceive = (...args) => { receiveCalls++; return nativeReceive(...args); };
    }
    await new Promise((resolve, reject) => client.send("connected departed peer", (error) => error ? reject(error) : resolve()));
    // Unix can report ECONNREFUSED; Windows consumes the ICMP notification.
    // Either path must consume the pending error and return the socket to idle.
    await delay(150);
    assert.ok(receiveCalls < 10, `${family}: an ICMP error must not cause repeated receive readiness`);
    if (nativeReceive) cottontail.udpSocketReceive = nativeReceive;

    await bind(replacement, address, peerPort);
    const packet = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${family} connected peer recovery timed out`)), 5000);
      client.once("message", (message, info) => {
        clearTimeout(timer);
        resolve({ text: message.toString(), port: info.port });
      });
    });
    await send(replacement, "connected socket still receives", localPort, address);
    assert.deepEqual(await packet, { text: "connected socket still receives", port: peerPort });
  } finally {
    if (nativeReceive) cottontail.udpSocketReceive = nativeReceive;
    await close(replacement);
  }
}

for (const [family, address] of [["udp4", "127.0.0.1"], ["udp6", "::1"]]) {
  // Reserve then close only a fixture-owned peer, not an assumed unused port.
  const departed = createSocket(family);
  await bind(departed, address);
  const port = departed.address().port;
  await close(departed);
  const client = createSocket(family);
  const live = createSocket(family);
  const errors = [];
  client.on("error", (error) => errors.push(String(error)));
  live.on("error", (error) => errors.push(String(error)));
  try {
    await bind(client, address);
    await bind(live, address);
    for (let attempt = 0; attempt < 3; attempt++) {
      await send(client, "departed peer", port, address);
      await delay(150); // Allow Winsock's asynchronous ICMP notification.
    }
    const marker = "still receiving — 日本語 🌊";
    const received = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${family} live peer timed out`)), 5000);
      client.once("message", (message, info) => {
        clearTimeout(timer);
        resolve({ text: message.toString(), port: info.port });
      });
    });
    await send(live, marker, client.address().port, address);
    assert.deepEqual(await received, { text: marker, port: live.address().port });
    assert.deepEqual(errors, [], `${family}: a lost remote peer must not break a local UDP socket`);
    await connectedPeerRecovery(client, family, address, port);
  } finally {
    await Promise.all([close(client), close(live)]);
  }
}
if (typeof cottontail !== "undefined") {
  assert.throws(() => cottontail.udpSocketReceive(-1), undefined, "Invalid socket errors are not suppressed");
}
console.log("node dgram peer loss passed");
