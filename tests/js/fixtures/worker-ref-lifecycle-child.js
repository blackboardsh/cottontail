import { BroadcastChannel, MessageChannel, Worker } from "node:worker_threads";

const mode = process.argv[2];
if (mode.startsWith("message-port-")) {
  const { port1, port2 } = new MessageChannel();
  port1.on("message", () => {});
  if (mode.endsWith("unref")) port1.unref();
  console.log(`${mode}:${port1.hasRef()}`);
  setTimeout(() => {
    console.log(`${mode}-finished`);
    port1.close();
    port2.close();
  }, mode.endsWith("unref") ? 400 : 120).unref();
} else if (mode.startsWith("broadcast-")) {
  const channel = new BroadcastChannel(`worker-ref-lifecycle-${mode}`);
  if (mode.endsWith("unref")) channel.unref();
  console.log(mode);
  setTimeout(() => {
    console.log(`${mode}-finished`);
    channel.close();
  }, mode.endsWith("unref") ? 400 : 120).unref();
} else {
  const delay = mode === "unref" ? 3000 : 120;
  const marker = `worker-${mode}-finished`;
  const worker = new Worker(
    `setTimeout(() => console.log(${JSON.stringify(marker)}), ${delay});`,
    { eval: true },
  );

  if (mode === "unref") {
    worker.unref();
  } else if (mode === "toggle") {
    worker.unref();
    worker.ref();
  }

  console.log(`${mode}:${worker.hasRef()}`);
}
