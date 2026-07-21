import { Worker } from "node:worker_threads";

const mode = process.argv[2];
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
