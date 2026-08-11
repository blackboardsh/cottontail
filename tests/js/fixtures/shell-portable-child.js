import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";

const mode = process.argv[2];

process.stdout.on("error", error => {
  if (error?.code === "EPIPE") process.exit(0);
  throw error;
});

if (mode === "delay") {
  setTimeout(() => process.stdout.write("complete"), 50);
} else if (mode === "passthrough") {
  process.stdout.write(readFileSync(0));
} else if (mode === "uppercase") {
  process.stdout.write(readFileSync(0).toString().toUpperCase());
} else if (mode === "producer") {
  process.stdout.write(Buffer.alloc(8 * 1024 * 1024, 0x73));
} else if (mode === "self-signal") {
  process.kill(process.pid, "SIGTERM");
} else if (mode === "stdio-handshake") {
  process.stdout.write("ready\n");
  process.stdout.write(readFileSync(0));
} else if (mode === "stdio-dual-handshake") {
  process.stdout.write("stdout-ready\n");
  process.stderr.write("stderr-ready\n");
  const input = readFileSync(0);
  process.stdout.write(Buffer.concat([Buffer.from("stdout:"), input]));
  process.stderr.write("stderr-done\n");
} else if (mode === "cross-fd-order") {
  process.stderr.write("err");
  setTimeout(() => process.stdout.write("out"), 50);
} else if (mode === "signal-tree") {
  const leaf = spawn(process.execPath, [process.argv[1], "signal-leaf"], {
    stdio: "ignore",
  });
  process.stdout.write(`${leaf.pid}\n`);
  setInterval(() => {}, 60_000);
} else if (mode === "signal-leaf") {
  setInterval(() => {}, 60_000);
} else if (mode === "tty") {
  process.stdout.write(JSON.stringify([
    process.stdin.isTTY === true,
    process.stdout.isTTY === true,
    process.stderr.isTTY === true,
  ]));
} else if (mode === "argv-json") {
  process.stdout.write(JSON.stringify(process.argv.slice(3)));
} else {
  process.stderr.write(`unknown shell fixture mode: ${mode}\n`);
  process.exitCode = 1;
}
