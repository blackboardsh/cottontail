import net from "node:net";
import tls from "node:tls";

const kind = process.argv[2];
const shouldUnref = process.argv[3] === "unref";
const port = Number(process.env.COTTONTAIL_TRANSPORT_PORT);

const socket = kind === "tls"
  ? tls.connect({ host: "127.0.0.1", port, servername: "localhost", rejectUnauthorized: false })
  : net.connect({ host: "127.0.0.1", port });

socket.once(kind === "tls" ? "secureConnect" : "connect", () => {
  if (shouldUnref) socket.unref();
});
socket.on("error", (error) => {
  console.error(error);
  process.exitCode = 2;
});
