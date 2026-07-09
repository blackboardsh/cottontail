import { fork } from "node:child_process";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const childPath = `${import.meta.dirname}/fixtures/fork-child.js`;
const child = fork(childPath);
const messages: any[] = [];

const exit = new Promise<number | null>((resolve) => {
  child.on("message", (message) => {
    messages.push(message);
    if (message?.ready) child.send({ value: "ok" });
  });
  child.on("close", (code) => resolve(code));
});

const code = await exit;
assert(code === 0, `fork child exited with ${code}`);
assert(messages.some((message) => message?.ready === true), "fork child did not send ready message");
assert(messages.some((message) => message?.echo === "ok"), "fork child did not echo parent message");

console.log("node child_process fork passed");
