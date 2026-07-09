import readline from "node:readline";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

rl.on("line", (line) => {
  process.stdout.write(`line:${line}\n`);
});

rl.on("close", () => {
  process.stdout.write("closed");
});
