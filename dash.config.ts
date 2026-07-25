// @dash cli=0.1.0-beta.1 cottontail=0.1.1-canary.1
export default {
  scripts: {
    "push:canary": "node scripts/tag-release.js canary",
    "push:stable": "node scripts/tag-release.js stable",
  },
};
