if (process.env.JSC_useDFGJIT !== undefined) {
  throw new Error("the Linux ARM64 JSC tier default leaked into process.env");
}

const nodeKinds = ["element", "text", "expression", "block"];

function buildTree(seed) {
  const children = [];
  for (let index = 0; index < 96; index++) {
    const kind = nodeKinds[(seed + index) & 3];
    if (kind === "element") {
      children.push({ kind, name: `item-${index & 7}`, attributes: { id: seed + index }, children: [] });
    } else if (kind === "text") {
      children.push({ kind, value: ` text ${seed * 17 + index} ` });
    } else if (kind === "expression") {
      children.push({ kind, operator: index & 1 ? "+" : "*", left: seed, right: index + 1 });
    } else {
      children.push({ kind, condition: (seed + index) % 3, children: [{ kind: "text", value: "branch" }] });
    }
  }
  return { kind: "root", children };
}

function lower(node, output) {
  switch (node.kind) {
    case "root":
    case "block":
      for (const child of node.children) lower(child, output);
      break;
    case "element":
      output.push("<", node.name, ' id="', String(node.attributes.id), '">');
      for (const child of node.children) lower(child, output);
      output.push("</", node.name, ">");
      break;
    case "text":
      output.push(node.value.trim().replaceAll("&", "&amp;"));
      break;
    case "expression":
      output.push(String(node.operator === "+" ? node.left + node.right : node.left * node.right));
      break;
    default:
      throw new Error(`unknown node kind: ${node.kind}`);
  }
}

function compile(seed) {
  const output = [];
  lower(buildTree(seed), output);
  return output.join("");
}

let checksum = 2166136261;
let rounds = 0;
const deadline = performance.now() + 2_000;
do {
  for (let batch = 0; batch < 64; batch++) {
    const generated = compile(rounds++);
    for (let index = 0; index < generated.length; index += 17) {
      checksum = Math.imul(checksum ^ generated.charCodeAt(index), 16777619);
    }
  }
  Bun.gc(true);
} while (performance.now() < deadline);

if (rounds < 64 || !Number.isInteger(checksum)) {
  throw new Error(`tiering stress did not complete: rounds=${rounds}, checksum=${checksum}`);
}
console.log(`jsc tiering stress passed: rounds=${rounds}, checksum=${checksum >>> 0}`);
