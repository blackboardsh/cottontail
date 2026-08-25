// @hutch cli=0.5.1 cottontail=0.6.0-canary.8
export default {
  scripts: {
    "push:canary": "node scripts/tag-release.js canary",
    "push:production": "node scripts/tag-release.js production",
  },
};
