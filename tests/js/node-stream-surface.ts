import StreamDefault, {
  PassThrough,
  Readable,
  Transform,
  Writable,
  _isArrayBufferView,
  _isUint8Array,
  _uint8ArrayToBuffer,
  addAbortSignal,
  compose,
  duplexPair,
  finished,
  getDefaultHighWaterMark,
  isDestroyed,
  isDisturbed,
  isErrored,
  isReadable,
  isWritable,
  pipeline,
  promises as streamPromises,
  setDefaultHighWaterMark,
} from "node:stream";
import {
  arrayBuffer,
  blob,
  buffer,
  json,
  text,
} from "node:stream/consumers";
import {
  finished as finishedPromise,
  pipeline as pipelinePromise,
} from "node:stream/promises";
import {
  ByteLengthQueuingStrategy,
  CompressionStream,
  CountQueuingStrategy,
  DecompressionStream,
  ReadableByteStreamController,
  ReadableStream,
  ReadableStreamBYOBReader,
  ReadableStreamBYOBRequest,
  ReadableStreamDefaultController,
  ReadableStreamDefaultReader,
  TextDecoderStream,
  TextEncoderStream,
  TransformStream,
  TransformStreamDefaultController,
  WritableStream,
  WritableStreamDefaultController,
  WritableStreamDefaultWriter,
} from "node:stream/web";
import EventEmitter, {
  EventEmitterAsyncResource,
  addAbortListener,
  errorMonitor,
  getEventListeners,
  getMaxListeners,
  listenerCount,
  on,
  once,
  setMaxListeners,
} from "node:events";
import { createRequire } from "node:module";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const require = createRequire(import.meta.url);
const requiredStream = require("node:stream");
assert(requiredStream === StreamDefault, "require node:stream default mismatch");
assert(requiredStream.Readable === Readable, "require node:stream Readable mismatch");
assert(require("stream/consumers").text === text, "require stream/consumers mismatch");
assert(require("node:stream/promises").pipeline === pipelinePromise, "require stream/promises mismatch");
assert(require("stream/web").ReadableStream === ReadableStream, "require stream/web mismatch");

assert(await text(Readable.from(["hello", " ", "stream"])) === "hello stream", "stream consumers text mismatch");
assert((await json(Readable.from(['{"ok":true}']))).ok === true, "stream consumers json mismatch");
const bytes = new Uint8Array(await arrayBuffer(Readable.from([new Uint8Array([1, 2, 3])])));
assert(bytes[0] === 1 && bytes[2] === 3, "stream consumers arrayBuffer mismatch");
assert((await buffer(Readable.from(["buf"]))).toString() === "buf", "stream consumers buffer mismatch");
assert(await (await blob(Readable.from(["blob"]))).text() === "blob", "stream consumers blob mismatch");

let written = "";
const upper = new Transform({
  transform(chunk, _encoding, callback) {
    callback(null, String(chunk).toUpperCase());
  },
});
const sink = new Writable({
  write(chunk, _encoding, callback) {
    written += String(chunk);
    callback();
  },
});
await pipelinePromise(Readable.from(["a", "b"]), upper, sink);
assert(written === "AB", "stream/promises pipeline mismatch");
assert(streamPromises.pipeline === pipeline, "stream promises export mismatch");
assert(streamPromises.finished === finished, "stream finished export mismatch");

const pass = new PassThrough();
const passDone = finishedPromise(pass);
pass.end("done");
await passDone;

const composed = compose(Readable.from(["x"]), new PassThrough());
assert(composed instanceof PassThrough, "compose should return final stream");

const [left, right] = duplexPair();
const paired = once(right, "data");
left.write("pair");
assert((await paired)[0] === "pair", "duplexPair write mismatch");

const readable = Readable.from(["readable"]);
assert(isReadable(readable), "isReadable mismatch");
assert(isWritable(new Writable()), "isWritable mismatch");
const abortedStream = new PassThrough();
const fakeSignal = {
  aborted: false,
  addEventListener(_name, handler) { this.handler = handler; },
  removeEventListener() {},
};
addAbortSignal(fakeSignal as any, abortedStream);
(fakeSignal as any).handler();
assert(isDestroyed(abortedStream), "addAbortSignal destroy mismatch");

const errored = new PassThrough();
errored.on("error", () => {});
errored.destroy(new Error("boom"));
assert(isErrored(errored), "isErrored mismatch");
assert(isDisturbed(errored), "isDisturbed mismatch");

setDefaultHighWaterMark(false, 32768);
setDefaultHighWaterMark(true, 8);
assert(getDefaultHighWaterMark(false) === 32768, "byte highWaterMark mismatch");
assert(getDefaultHighWaterMark(true) === 8, "object highWaterMark mismatch");
assert(_isArrayBufferView(new Uint8Array(1)), "_isArrayBufferView mismatch");
assert(_isUint8Array(new Uint8Array(1)), "_isUint8Array mismatch");
assert(_uint8ArrayToBuffer(new Uint8Array([65])).toString() === "A", "_uint8ArrayToBuffer mismatch");

const emitter = new EventEmitter();
const onceEvent = once(emitter, "ready");
emitter.emit("ready", 1, 2);
assert((await onceEvent)[1] === 2, "events once mismatch");

let monitored = false;
emitter.on(errorMonitor, () => { monitored = true; });
emitter.on("error", () => {});
emitter.emit("error", new Error("observed"));
assert(monitored, "events errorMonitor mismatch");

const eventIterator = on(emitter, "item");
const nextEvent = eventIterator.next();
emitter.emit("item", "value");
assert((await nextEvent).value[0] === "value", "events on async iterator mismatch");
await eventIterator.return?.();

emitter.on("counted", () => {});
assert(listenerCount(emitter, "counted") === 1, "events listenerCount mismatch");
assert(getEventListeners(emitter, "counted").length === 1, "events getEventListeners mismatch");
setMaxListeners(25, emitter);
assert(getMaxListeners(emitter) === 25, "events max listeners mismatch");

let abortCalled = false;
const abortSignal = {
  aborted: false,
  addEventListener(_name, handler) { this.handler = handler; },
  removeEventListener() {},
};
const disposable = addAbortListener(abortSignal as any, () => { abortCalled = true; });
(abortSignal as any).handler();
assert(abortCalled, "events addAbortListener mismatch");
disposable[Symbol.dispose]();

const asyncEmitter = new EventEmitterAsyncResource({ name: "cottontail-test" });
let asyncEventSeen = false;
asyncEmitter.on("ok", () => { asyncEventSeen = true; });
asyncEmitter.emit("ok");
asyncEmitter.emitDestroy();
assert(asyncEventSeen, "EventEmitterAsyncResource emit mismatch");

const webReadable = new ReadableStream({
  start(controller) {
    controller.enqueue("web");
    controller.close();
  },
});
const webReader = webReadable.getReader();
assert(webReader instanceof ReadableStreamDefaultReader, "ReadableStream reader class mismatch");
assert((await webReader.read()).value === "web", "ReadableStream read mismatch");
assert((await webReader.read()).done === true, "ReadableStream done mismatch");
webReader.releaseLock();
assert(!webReadable.locked, "ReadableStream releaseLock mismatch");

const writes: string[] = [];
const webWritable = new WritableStream({
  write(chunk) { writes.push(String(chunk)); },
  close() { writes.push("closed"); },
});
const webWriter = webWritable.getWriter();
assert(webWriter instanceof WritableStreamDefaultWriter, "WritableStream writer class mismatch");
await webWriter.write("write");
await webWriter.close();
assert(writes.join(",") === "write,closed", "WritableStream write mismatch");

const webTransform = new TransformStream({
  transform(chunk, controller) {
    controller.enqueue(`${chunk}!`);
  },
});
const transformReader = webTransform.readable.getReader();
const transformWriter = webTransform.writable.getWriter();
await transformWriter.write("go");
await transformWriter.close();
assert((await transformReader.read()).value === "go!", "TransformStream transform mismatch");
assert((await transformReader.read()).done === true, "TransformStream close mismatch");

const encoderStream = new TextEncoderStream();
const encoderReader = encoderStream.readable.getReader();
const encoderWriter = encoderStream.writable.getWriter();
await encoderWriter.write("encode");
await encoderWriter.close();
const encoded = (await encoderReader.read()).value;
assert(encoded instanceof Uint8Array && encoded.length > 0, "TextEncoderStream mismatch");

const decoderStream = new TextDecoderStream();
const decoderReader = decoderStream.readable.getReader();
const decoderWriter = decoderStream.writable.getWriter();
await decoderWriter.write(encoded);
await decoderWriter.close();
assert((await decoderReader.read()).value === "encode", "TextDecoderStream mismatch");

assert(new CountQueuingStrategy({ highWaterMark: 4 }).size() === 1, "CountQueuingStrategy size mismatch");
assert(new ByteLengthQueuingStrategy({ highWaterMark: 4 }).size(new Uint8Array(3)) === 3, "ByteLengthQueuingStrategy size mismatch");
assert(new CompressionStream("gzip").format === "gzip", "CompressionStream format mismatch");
assert(new DecompressionStream("gzip").format === "gzip", "DecompressionStream format mismatch");
assert(typeof ReadableByteStreamController === "function", "ReadableByteStreamController missing");
assert(typeof ReadableStreamBYOBReader === "function", "ReadableStreamBYOBReader missing");
assert(typeof ReadableStreamBYOBRequest === "function", "ReadableStreamBYOBRequest missing");
assert(typeof ReadableStreamDefaultController === "function", "ReadableStreamDefaultController missing");
assert(typeof TransformStreamDefaultController === "function", "TransformStreamDefaultController missing");
assert(typeof WritableStreamDefaultController === "function", "WritableStreamDefaultController missing");

console.log("node stream surface passed");
