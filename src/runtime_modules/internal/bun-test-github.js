// Port of Bun's GitHub Actions test reporting boundary. Keep workflow-command
// escaping here so the test runner's ordinary terminal reporter stays clean.

function truthyBoolean(value) {
  if (value == null) return false;
  const normalized = String(value).trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false";
}

function isAIAgent(env) {
  if (env.AGENT != null) return String(env.AGENT) === "1";
  if (truthyBoolean(env.CLAUDECODE)) return true;
  return env.REPL_ID != null;
}

export function githubActionsEnabled() {
  const env = globalThis.process?.env ?? {};
  return truthyBoolean(env.GITHUB_ACTIONS) && !isAIAgent(env);
}

function stripAnsi(value) {
  return String(value ?? "").replace(/[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, "");
}

function escapeData(value) {
  return stripAnsi(value)
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}

function escapeProperty(value) {
  return escapeData(value)
    .replaceAll(":", "%3A")
    .replaceAll(",", "%2C");
}

function relativeDiagnosticPath(value) {
  let path = String(value ?? "").replaceAll("\\", "/");
  const env = globalThis.process?.env ?? {};
  const root = String(env.GITHUB_WORKSPACE ?? globalThis.process?.cwd?.() ?? "")
    .replaceAll("\\", "/")
    .replace(/[\/]+$/, "");
  if (root && (path === root || path.startsWith(`${root}/`))) {
    path = path.slice(root.length).replace(/^\/+/, "");
  }
  return path;
}

function errorName(error) {
  const name = String(error?.name ?? "");
  return !name || name === "Error" ? "error" : name;
}

export function githubErrorAnnotation(error, frames, formattedMessage) {
  if (!githubActionsEnabled()) return null;
  const message = stripAnsi(formattedMessage ?? error?.message ?? error ?? "");
  const [headline = "", ...bodyLines] = message.split(/\r?\n/);
  const frame = frames?.[0];
  const properties = [];
  if (frame?.filePath && Number.isFinite(frame.line) && Number.isFinite(frame.column)) {
    properties.push(`file=${escapeProperty(relativeDiagnosticPath(frame.filePath))}`);
    properties.push(`line=${Math.max(1, Math.trunc(frame.line))}`);
    properties.push(`col=${Math.max(1, Math.trunc(frame.column))}`);
  }
  const title = `${errorName(error)}${headline ? `: ${headline}` : ""}`;
  properties.push(`title=${escapeData(title)}`);

  const stackLines = [];
  for (const item of frames ?? []) {
    const name = item.functionName && item.functionName !== "@" ? item.functionName : "<anonymous>";
    stackLines.push(`      at ${name} (${relativeDiagnosticPath(item.filePath)}:${item.line}:${item.column})`);
  }
  return `::error ${properties.join(",")}::${escapeData([...bodyLines, ...stackLines].join("\n"))}`;
}

export function githubTimeoutAnnotation(testName, duration) {
  if (!githubActionsEnabled()) return null;
  return `::error title=${escapeData(`error: Test \"${testName}\" timed out after ${duration}ms`)}::`;
}

export function appendGithubGroup(lines, label, body) {
  if (!githubActionsEnabled()) {
    lines.push(label, ...body);
    return;
  }
  lines.push(`::group::${label}`, ...body, "", "::endgroup::");
}
