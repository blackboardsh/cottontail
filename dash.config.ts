// @dash cli=0.2.1 cottontail=0.2.0-canary.1
export default {
  scripts: {
    "push:canary": "node scripts/tag-release.js canary",
    "push:production": "node scripts/tag-release.js production",
  },
};
