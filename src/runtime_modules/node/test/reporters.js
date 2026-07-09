async function *normalizeEvents(source) {
  if (source && typeof source[Symbol.asyncIterator] === "function") {
    for await (const event of source) yield event;
  } else if (source && typeof source[Symbol.iterator] === "function") {
    for (const event of source) yield event;
  }
}

function nameOf(event) {
  return event?.data?.name ?? event?.name ?? event?.test?.name ?? "";
}

async function *tapReporter(source) {
  yield "TAP version 13\n";
  let index = 0;
  for await (const event of normalizeEvents(source)) {
    if (!String(event?.type ?? "").includes("test:")) continue;
    if (event.type === "test:pass") yield `ok ${++index} ${nameOf(event)}\n`;
    else if (event.type === "test:fail") yield `not ok ${++index} ${nameOf(event)}\n`;
  }
  yield `1..${index}\n`;
}

async function *dotReporter(source) {
  for await (const event of normalizeEvents(source)) {
    if (event?.type === "test:pass") yield ".";
    else if (event?.type === "test:fail") yield "X";
  }
  yield "\n";
}

async function *junitReporter(source) {
  const cases = [];
  for await (const event of normalizeEvents(source)) {
    if (event?.type === "test:pass" || event?.type === "test:fail") cases.push(event);
  }
  yield `<?xml version="1.0" encoding="utf-8"?>\n<testsuite tests="${cases.length}">\n`;
  for (const item of cases) {
    const name = escapeXml(nameOf(item));
    if (item.type === "test:fail") yield `  <testcase name="${name}"><failure /></testcase>\n`;
    else yield `  <testcase name="${name}" />\n`;
  }
  yield "</testsuite>\n";
}

function escapeXml(value) {
  return String(value).replace(/[<>&'"]/g, (char) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    "'": "&apos;",
    "\"": "&quot;",
  })[char]);
}

export function tap(source) {
  return tapReporter(source);
}

export function dot(source) {
  return dotReporter(source);
}

export function junit(source) {
  return junitReporter(source);
}

export function spec(source) {
  return tapReporter(source);
}

export function lcov(source) {
  async function *emptyLcov() {
    for await (const _event of normalizeEvents(source)) {}
    yield "";
  }
  return emptyLcov();
}

export default { dot, junit, lcov, spec, tap };
