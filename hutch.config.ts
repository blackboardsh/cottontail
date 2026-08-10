// @hutch cli=0.2.1 cottontail=0.3.0-canary.4
export default {
  scripts: {
    "push:canary": "node scripts/tag-release.js canary",
    "push:production": "node scripts/tag-release.js production",
  },
};
