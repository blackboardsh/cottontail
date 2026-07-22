import path from "../node/path.js";
import { createSourceMapConsumer } from "../vendor/sourcemap.js";

const maxReportBytes = 1024 * 1024;
const decoder = new TextDecoder();
const encoder = new TextEncoder();

class ErrorReportReader {
  constructor(buffer) {
    this.bytes = new Uint8Array(buffer);
    this.view = new DataView(buffer);
    this.offset = 0;
  }

  take(size) {
    if (!Number.isSafeInteger(size) || size < 0 || this.offset + size > this.bytes.byteLength) {
      throw new RangeError("Invalid Bun error report payload");
    }
    const offset = this.offset;
    this.offset += size;
    return offset;
  }

  u32() {
    return this.view.getUint32(this.take(4), true);
  }

  i32() {
    return this.view.getInt32(this.take(4), true);
  }

  string32() {
    const size = this.u32();
    const offset = this.take(size);
    return decoder.decode(this.bytes.subarray(offset, offset + size));
  }
}

async function sourceMapConsumer(record) {
  if (!record) return null;
  if (!record.consumerPromise) {
    record.consumerPromise = (async () => {
      let text;
      if (typeof record.body === "string") text = record.body;
      else if (typeof record.body?.text === "function") text = await record.body.text();
      else if (record.body instanceof Uint8Array) text = decoder.decode(record.body);
      else return null;
      return createSourceMapConsumer(text, {
        bundlePath: record.bundlePath,
        mapPath: record.mapPath,
        sourceRoot: record.sourceRoot,
      });
    })().catch(() => null);
  }
  return record.consumerPromise;
}

function displaySource(projectRoot, source) {
  let value = String(source ?? "");
  if (value.startsWith("file://")) {
    try {
      value = decodeURIComponent(new URL(value).pathname);
    } catch {}
  }
  if (path.isAbsolute(value)) value = path.relative(projectRoot, value);
  return value.split(path.sep).join("/");
}

async function remapFrame(frame, browserUrl, runtime) {
  if (frame.line < 1 || !frame.file || typeof runtime?.sourceMapForPath !== "function") return frame;

  let browser;
  let frameUrl;
  try {
    browser = new URL(browserUrl);
    frameUrl = new URL(frame.file, browser);
  } catch {
    return frame;
  }
  if (frameUrl.origin !== browser.origin) return frame;

  const consumer = await sourceMapConsumer(runtime.sourceMapForPath(frameUrl.pathname));
  const mapped = consumer?.originalPositionFor(frame.line, Math.max(1, frame.col));
  if (!mapped) return frame;

  const file = displaySource(runtime.projectRoot, mapped.source);
  return {
    ...frame,
    col: mapped.column,
    file,
    fn: frame.fn === file ? "" : frame.fn,
    line: mapped.line,
    mapped: true,
    sourceLines: mapped.lines,
  };
}

function codePreview(frame) {
  if (!frame?.mapped || !Array.isArray(frame.sourceLines) || frame.line < 1) return null;
  const target = frame.line - 1;
  if (target >= frame.sourceLines.length) return null;

  let firstLine = Math.max(0, target - 2);
  const lines = frame.sourceLines.slice(firstLine, firstLine + 5);
  let lineOfInterest = target - firstLine;
  while (lines.length > 0 && lines[0].length === 0) {
    lines.shift();
    firstLine += 1;
    lineOfInterest -= 1;
  }
  while (lines.length > 0 && lines[lines.length - 1].length === 0) lines.pop();
  if (lines.length === 0 || lineOfInterest < 0 || lineOfInterest >= lines.length) return null;
  return {
    firstLine: firstLine + 1,
    highlightedColumn: Math.max(1, frame.col),
    lineOfInterest,
    lines,
  };
}

function encodeReport(frames, preview) {
  const encodedFrames = frames.map(frame => ({
    ...frame,
    encodedFile: encoder.encode(String(frame.file ?? "")),
    encodedFunction: encoder.encode(String(frame.fn ?? "")),
  }));
  const encodedPreview = preview?.lines.map(line => encoder.encode(line)) ?? [];
  let size = 5;
  for (const frame of encodedFrames) size += 16 + frame.encodedFunction.length + frame.encodedFile.length;
  if (preview) {
    size += 12;
    for (const line of encodedPreview) size += 4 + line.length;
  }

  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  view.setUint32(offset, encodedFrames.length, true);
  offset += 4;
  for (const frame of encodedFrames) {
    view.setInt32(offset, frame.line, true);
    view.setInt32(offset + 4, frame.col, true);
    offset += 8;
    view.setUint32(offset, frame.encodedFunction.length, true);
    offset += 4;
    bytes.set(frame.encodedFunction, offset);
    offset += frame.encodedFunction.length;
    view.setUint32(offset, frame.encodedFile.length, true);
    offset += 4;
    bytes.set(frame.encodedFile, offset);
    offset += frame.encodedFile.length;
  }
  bytes[offset++] = encodedPreview.length;
  if (preview) {
    view.setUint32(offset, preview.lineOfInterest, true);
    view.setUint32(offset + 4, preview.firstLine, true);
    view.setUint32(offset + 8, preview.highlightedColumn, true);
    offset += 12;
    for (const line of encodedPreview) {
      view.setUint32(offset, line.length, true);
      offset += 4;
      bytes.set(line, offset);
      offset += line.length;
    }
  }
  return bytes;
}

function printReport(name, message, frames) {
  const stack = frames.map(frame => {
    const location = frame.line > 0
      ? `${frame.file}:${frame.line}:${Math.max(0, frame.col)}`
      : frame.file;
    return frame.fn ? `    at ${frame.fn} (${location})` : `    at ${location}`;
  });
  console.error(`${name || "Error"}: ${message}${stack.length > 0 ? `\n${stack.join("\n")}` : ""}`);
}

export async function handleBakeErrorReport(request, runtime) {
  try {
    const declaredLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxReportBytes) {
      return new Response("Payload Too Large", { status: 413 });
    }
    const body = await request.arrayBuffer();
    if (body.byteLength > maxReportBytes) return new Response("Payload Too Large", { status: 413 });

    const reader = new ErrorReportReader(body);
    const name = reader.string32();
    const message = reader.string32();
    const browserUrl = reader.string32();
    const frameCount = Math.min(reader.u32(), 255);
    const frames = [];
    for (let index = 0; index < frameCount; index += 1) {
      frames.push({
        line: reader.i32(),
        col: reader.i32(),
        fn: reader.string32(),
        file: reader.string32(),
        mapped: false,
        sourceLines: null,
      });
    }

    const remappedFrames = [];
    for (const frame of frames) remappedFrames.push(await remapFrame(frame, browserUrl, runtime));
    printReport(name, message, remappedFrames);
    const preview = codePreview(remappedFrames.find(frame => frame.mapped));
    return new Response(encodeReport(remappedFrames, preview), {
      headers: {
        "cache-control": "no-cache",
        "content-type": "application/octet-stream",
      },
    });
  } catch {
    return new Response("Invalid Bun error report", { status: 400 });
  }
}
