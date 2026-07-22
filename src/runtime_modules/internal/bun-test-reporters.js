export async function finalizeTestReporters(reporters, onError) {
  let shouldFail = false;
  for (const reporter of reporters) {
    try {
      if (await reporter.finalize() === true) shouldFail = true;
    } catch (error) {
      onError(reporter.name, error);
    }
  }
  return shouldFail;
}
