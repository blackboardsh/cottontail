import assert from "node:assert/strict";
import { createSocket } from "node:dgram";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const bind = (socket, address) => new Promise((resolve, reject) => {
  socket.once("error", reject);
  socket.bind(0, address, () => { socket.removeListener("error", reject); resolve(); });
});
const close = (socket) => new Promise((resolve) => socket.close(resolve));
const send = (socket, bytes, port, address) => new Promise((resolve, reject) => {
  socket.send(bytes, port, address, (error) => error ? reject(error) : resolve());
});

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
  } finally {
    await Promise.all([close(client), close(live)]);
  }
}
if (typeof cottontail !== "undefined") {
  assert.throws(() => cottontail.udpSocketReceive(-1), undefined, "Invalid socket errors are not suppressed");
}
console.log("node dgram peer loss passed");
