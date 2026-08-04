import { createRequire } from "node:module";

await Promise.resolve();

const require = createRequire(__filename);

export const lexicalPaths = {
  dirname: __dirname,
  filename: __filename,
  sibling: require("./sibling.cjs").marker,
};
