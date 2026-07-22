import { writeFileSync } from "../node/fs.js";

export function junitReporterOptions(testOptions) {
  if (!testOptions.reporters.junit) return null;
  if (!testOptions.reporterOutfile) {
    throw new Error("--reporter=junit requires --reporter-outfile [file] to specify where to save the XML report");
  }
  return { outfile: String(testOptions.reporterOutfile) };
}

function normalizePath(value) {
  let path = String(value ?? "").replaceAll("\\", "/");
  if (path.startsWith("file://")) {
    try { path = decodeURIComponent(new URL(path).pathname); } catch {}
  }
  return path;
}

export function captureTestRegistrationLine(filePath) {
  const target = normalizePath(filePath);
  if (!target) return 0;
  for (const line of String(new Error().stack ?? "").split("\n")) {
    const match = /(?:\(|@|\bat\s+)([^()@]+):(\d+):(\d+)\)?$/.exec(line.trim());
    if (!match) continue;
    const candidate = normalizePath(match[1]);
    if (candidate === target || candidate.endsWith(`/${target}`) || target.endsWith(`/${candidate}`)) {
      // The C-API stack source location is one line past Bun's call-frame line.
      return Math.max(0, (Number(match[2]) || 0) - 1);
    }
  }
  return 0;
}

function escapeXml(value) {
  return String(value).replace(/[&<>"'\u0000-\u001f]/g, (character) => {
    switch (character) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&apos;";
      default: return `&#${character.charCodeAt(0)};`;
    }
  });
}

function relativeFileName(filePath) {
  let file = normalizePath(filePath);
  const cwd = normalizePath(globalThis.process?.cwd?.() ?? ".").replace(/\/+$/, "");
  if (file.startsWith(`${cwd}/`)) file = file.slice(cwd.length + 1);
  return file.replace(/^\.\//, "");
}

function registrationSuites(record) {
  const suites = [];
  for (let suite = record.suite; suite?.parent; suite = suite.parent) suites.push(suite);
  return suites.reverse();
}

function createNode(kind, value) {
  return { kind, value, children: [], suiteNodes: new Map() };
}

function buildReportTree(records, rootSuite) {
  if (rootSuite?.children) {
    const files = new Map();
    const appendChild = (parent, child) => {
      if (child?.kind === "suite") {
        const suiteNode = createNode("suite", child);
        for (const nested of child.children ?? []) appendChild(suiteNode, nested);
        if (metricsForNode(suiteNode).tests > 0) parent.children.push(suiteNode);
        return;
      }
      if (!child || child.status == null) return;
      parent.children.push(createNode("test", child));
    };
    for (const child of rootSuite.children) {
      const fileName = relativeFileName(child.filePath);
      if (!fileName) continue;
      let file = files.get(fileName);
      if (!file) {
        file = createNode("file", fileName);
        files.set(fileName, file);
      }
      appendChild(file, child);
    }
    return [...files.values()];
  }

  const files = new Map();
  for (const record of records) {
    const fileName = relativeFileName(record.filePath);
    let file = files.get(fileName);
    if (!file) {
      file = createNode("file", fileName);
      files.set(fileName, file);
    }
    let parent = file;
    for (const suite of registrationSuites(record)) {
      let child = parent.suiteNodes.get(suite);
      if (!child) {
        child = createNode("suite", suite);
        parent.suiteNodes.set(suite, child);
        parent.children.push(child);
      }
      parent = child;
    }
    parent.children.push(createNode("test", record));
  }
  return [...files.values()];
}

function assertionCountForAttempt(record, index) {
  const counts = record.attemptAssertionCounts ?? [];
  if (index < counts.length) return Number(counts[index]) || 0;
  return Number(counts[counts.length - 1]) || 0;
}

function casesForRecord(record) {
  if (record.status === "filtered") return [{ status: "skip", assertions: 0, durationMs: 0 }];
  if (record.status === "skip") return [{ status: "skip", assertions: 0, durationMs: 0 }];
  if (record.status === "todo") return [{ status: "todo", assertions: 0, durationMs: 0 }];

  const errors = record.attemptErrors ?? [];
  const durations = record.attemptDurationsMs ?? [];
  const cases = [];
  if (record.status === "pass") {
    for (let index = 0; index < errors.length; index += 1) {
      cases.push({ status: "fail", error: errors[index], assertions: assertionCountForAttempt(record, index), durationMs: durations[index] ?? 0 });
    }
    const finalIndex = errors.length;
    cases.push({ status: "pass", assertions: assertionCountForAttempt(record, finalIndex), durationMs: durations[finalIndex] ?? record.durationMs ?? 0 });
    return cases;
  }

  const finalIndex = Math.max(0, errors.length - 1);
  for (let index = 0; index < finalIndex; index += 1) {
    cases.push({ status: "fail", error: errors[index], assertions: assertionCountForAttempt(record, index), durationMs: durations[index] ?? 0 });
  }
  cases.push({
    status: "fail",
    error: record.error ?? errors[finalIndex],
    assertions: assertionCountForAttempt(record, finalIndex),
    durationMs: durations[finalIndex] ?? record.durationMs ?? 0,
  });
  return cases;
}

function emptyMetrics() {
  return { tests: 0, assertions: 0, failures: 0, skipped: 0, durationMs: 0 };
}

function addMetrics(target, source) {
  target.tests += source.tests;
  target.assertions += source.assertions;
  target.failures += source.failures;
  target.skipped += source.skipped;
  target.durationMs += source.durationMs;
  return target;
}

function metricsForNode(node) {
  if (node.kind === "test") {
    const metrics = emptyMetrics();
    for (const item of casesForRecord(node.value)) {
      metrics.tests += 1;
      metrics.assertions += item.assertions;
      metrics.durationMs += Number(item.durationMs) || 0;
      if (item.status === "fail") metrics.failures += 1;
      if (item.status === "skip" || item.status === "todo") metrics.skipped += 1;
    }
    return metrics;
  }
  const metrics = emptyMetrics();
  for (const child of node.children) addMetrics(metrics, metricsForNode(child));
  return metrics;
}

function metricsAttributes(metrics, includeHostname = true) {
  const seconds = Math.max(0, metrics.durationMs) / 1000;
  return `tests="${metrics.tests}" assertions="${metrics.assertions}" failures="${metrics.failures}" ` +
    `skipped="${metrics.skipped}" time="${seconds}"${includeHostname ? ' hostname=""' : ""}`;
}

function ciProperties() {
  const env = globalThis.process?.env ?? {};
  let ci = "";
  if (env.GITHUB_RUN_ID && env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY) {
    ci = `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
  } else if (env.CI_JOB_URL) {
    ci = String(env.CI_JOB_URL);
  }
  const commit = String(env.GITHUB_SHA ?? env.CI_COMMIT_SHA ?? env.GIT_SHA ?? "");
  if (!ci && !commit) return [];
  const lines = ["    <properties>"];
  if (ci) lines.push(`      <property name="ci" value="${escapeXml(ci)}" />`);
  if (commit) lines.push(`      <property name="commit" value="${escapeXml(commit)}" />`);
  lines.push("    </properties>");
  return lines;
}

function classNameForRecord(record) {
  const names = registrationSuites(record).map((suite) => suite.name).reverse();
  return names.join(" &gt; ");
}

function renderTest(node, depth, fileName, lines) {
  const record = node.value;
  const indent = "  ".repeat(depth);
  const className = classNameForRecord(record);
  const line = Number(record.registrationLine) || 0;
  for (const item of casesForRecord(record)) {
    const seconds = Math.max(0, Number(item.durationMs) || 0) / 1000;
    let open = `${indent}<testcase name="${escapeXml(record.name)}" classname="${escapeXml(className)}" ` +
      `time="${seconds}" file="${escapeXml(fileName)}"`;
    if (line > 0) open += ` line="${line}"`;
    open += ` assertions="${item.assertions}"`;
    if (item.status === "pass") {
      lines.push(`${open} />`);
    } else if (item.status === "skip") {
      lines.push(`${open}>`, `${indent}  <skipped />`, `${indent}</testcase>`);
    } else if (item.status === "todo") {
      lines.push(`${open}>`, `${indent}  <skipped message="TODO" />`, `${indent}</testcase>`);
    } else {
      const type = item.error?.code === "ERR_TEST_TIMEOUT" ? "TimeoutError" : "AssertionError";
      lines.push(`${open}>`, `${indent}  <failure type="${type}" />`, `${indent}</testcase>`);
    }
  }
}

function renderSuite(node, depth, fileName, lines) {
  const metrics = metricsForNode(node);
  const indent = "  ".repeat(depth);
  const isFile = node.kind === "file";
  const name = isFile ? node.value : node.value.name;
  const line = isFile ? 0 : Number(node.value.registrationLine) || 0;
  let open = `${indent}<testsuite name="${escapeXml(name)}" file="${escapeXml(fileName)}"`;
  if (line > 0) open += ` line="${line}"`;
  open += ` ${metricsAttributes(metrics)}>`;
  lines.push(open);
  if (isFile) lines.push(...ciProperties());
  for (const child of node.children) {
    if (child.kind === "test") renderTest(child, depth + 1, fileName, lines);
    else renderSuite(child, depth + 1, fileName, lines);
  }
  lines.push(`${indent}</testsuite>`);
}

export function writeJunitReport(records, rootSuite, options) {
  if (!options) return;
  const files = buildReportTree(records, rootSuite);
  const total = emptyMetrics();
  for (const file of files) addMetrics(total, metricsForNode(file));
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="bun test" ${metricsAttributes(total, false)}>`,
  ];
  for (const file of files) renderSuite(file, 1, file.value, lines);
  lines.push("</testsuites>", "");
  writeFileSync(options.outfile, lines.join("\n"));
}
