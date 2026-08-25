// @hutch cli=0.5.1 cottontail=0.6.0-canary.5
export default {
  scripts: {
    "push:canary": "node scripts/tag-release.js canary",
    "push:production": "node scripts/tag-release.js production",
  },
};
