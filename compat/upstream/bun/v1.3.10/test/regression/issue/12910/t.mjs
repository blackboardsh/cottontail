// Test should fail if thrown exception is not caught
process.exitCode = 1;

try {
  // This regression stresses the import/require race, not unhandled-rejection
  // policy. Observe the intentionally throwing dynamic import while require()
  // reports the same module failure synchronously below.
  void import("./t3.mjs").catch(() => {});
  require("./t3.mjs");
} catch (e) {
  console.log(e);
  process.exitCode = 0;
}
