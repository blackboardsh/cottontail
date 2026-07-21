import readline from "node:readline/promises";

process.stdin.on("pause", () => {});
process.stdin.on("resume", () => {});

const interfaceInstance = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});
interfaceInstance.close();
