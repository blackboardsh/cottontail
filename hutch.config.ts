// @hutch cli=0.28.0-canary.2 cottontail=0.7.2-canary.4
export default {
  scripts: {
    "push:canary": "node scripts/tag-release.js canary",
    "push:production": "node scripts/tag-release.js production",
  },
};
