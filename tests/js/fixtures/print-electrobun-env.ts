console.log(
  JSON.stringify({
    dist: process.env.COTTONTAIL_ELECTROBUN_DIST || "",
    name: process.env.COTTONTAIL_ELECTROBUN_NAME || "",
  }),
);
