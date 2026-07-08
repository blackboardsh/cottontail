import { EventEmitter } from "./events.js";

export class Stream extends EventEmitter {
  pipe(destination) {
    this.on("data", (chunk) => destination.write?.(chunk));
    this.on("end", () => destination.end?.());
    return destination;
  }
}

export class Readable extends Stream {
  constructor(options = {}) {
    super();
    this.readable = true;
    this._read = typeof options.read === "function" ? options.read : () => {};
  }

  push(chunk) {
    if (chunk == null) {
      this.emit("end");
      return false;
    }
    this.emit("data", chunk);
    return true;
  }

  read() {
    return this._read();
  }

  static from(iterable) {
    const stream = new Readable();
    Promise.resolve().then(async () => {
      for await (const item of iterable) {
        stream.push(item);
      }
      stream.push(null);
    });
    return stream;
  }
}

export class Writable extends Stream {
  constructor(options = {}) {
    super();
    this.writable = true;
    this._write = typeof options.write === "function" ? options.write : null;
  }

  write(chunk, encoding, callback) {
    if (this._write) {
      this._write(chunk, encoding, callback ?? (() => {}));
    }
    this.emit("data", chunk);
    if (callback) callback();
    return true;
  }

  end(chunk) {
    if (chunk != null) this.write(chunk);
    this.emit("finish");
    this.emit("end");
  }
}

export class Duplex extends Readable {}

export class Transform extends Duplex {
  constructor(options = {}) {
    super(options);
    this._transform = typeof options.transform === "function" ? options.transform : null;
  }

  write(chunk, encoding, callback) {
    if (this._transform) {
      this._transform(chunk, encoding, (_error, value) => {
        if (value != null) this.push(value);
        if (callback) callback();
      });
      return true;
    }
    this.push(chunk);
    if (callback) callback();
    return true;
  }
}

export class PassThrough extends Transform {}

export default { Duplex, PassThrough, Readable, Stream, Transform, Writable };
