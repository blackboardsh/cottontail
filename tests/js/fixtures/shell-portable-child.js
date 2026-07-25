import { readFileSync } from "node:fs";

const mode = process.argv[2];

process.stdout.on("error", error => {
  if (error?.code === "EPIPE") process.exit(0);
  throw error;
});

if (mode === "delay") {
  setTimeout(() => process.stdout.write("complete"), 50);
} else if (mode === "passthrough") {
  process.stdout.write(readFileSync(0));
} else if (mode === "producer") {
  process.stdout.write(Buffer.alloc(8 * 1024 * 1024, 0x73));
} else {
  process.stderr.write(`unknown shell fixture mode: ${mode}\n`);
  process.exitCode = 1;
}
