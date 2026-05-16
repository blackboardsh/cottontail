function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

assert(typeof cottontail === "object", "cottontail host object missing");
assert(typeof cottontail.nanotime === "function", "cottontail.nanotime missing");

console.log("running cottontail smoke test");
console.log("2 + 2 =", 2 + 2);
assert(2 + 2 === 4, "basic arithmetic failed");

const joined = ["cotton", "tail"].join("-");
console.log("joined =", joined);
assert(joined === "cotton-tail", "join failed");

const mapped = [1, 2, 3].map((value) => value * 3);
console.log("mapped =", mapped.join(","));
assert(mapped[2] === 9, "array map failed");

console.log("all js smoke tests passed");
