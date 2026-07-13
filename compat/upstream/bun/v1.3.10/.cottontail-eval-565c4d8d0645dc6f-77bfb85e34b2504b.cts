(async () => {
setTimeout(() => {}, 100)
})().catch((error) => {
  console.error(error?.stack ?? error);
  process.exitCode = 1;
});
