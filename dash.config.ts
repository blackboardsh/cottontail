// @dash cli=0.1.0 cottontail=0.1.1-canary.2
export default {
  scripts: {
    "push:canary": "node scripts/tag-release.js canary",
    "push:production": "node scripts/tag-release.js production",
  },
};
