import { strictEqual, throws } from "node:assert/strict";
import { createSocket } from "node:dgram";

const socket = createSocket("udp4");

for (const method of ["setTTL", "setMulticastTTL", "setRecvBufferSize", "setSendBufferSize"] as const) {
  throws(
    () => socket[method](),
    (error: Error & { code?: string }) => error instanceof TypeError && error.code === "ERR_INVALID_ARG_TYPE",
  );
}

for (const method of ["setTTL", "setMulticastTTL"] as const) {
  throws(
    () => socket[method](Number.NaN),
    (error: Error & { code?: string }) => error.code === "EINVAL",
  );
}

const nativeHandle = cottontail.udpSocketCreate(4);
for (const method of [cottontail.udpSocketSetTTL, cottontail.udpSocketSetMulticastTTL]) {
  throws(() => method(nativeHandle.fd, Number.NaN, 4), /Invalid TTL/);
}
throws(() => cottontail.udpSocketSetBufferSize(nativeHandle.fd, false, Number.NaN), /Invalid buffer size/);
cottontail.udpSocketClose(nativeHandle.fd);

strictEqual(socket.close(), socket);
console.log("node dgram validation passed");
