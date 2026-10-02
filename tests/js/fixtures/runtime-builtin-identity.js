// The test prepends either a static stream import or a dynamic fs-first load,
// then executes this same source in a real entrypoint and a full Web Worker.
async function inspectStreamIdentity() {
  const streamName = ["node", "stream"].join(":");
  const fsName = ["node", "fs"].join(":");
  const childName = ["node", "child_process"].join(":");
  const stages = [];
  async function snapshot(stage) {
    const required = require(streamName);
    const dynamic = await import(streamName);
    const plainRequired = require("stream");
    stages.push({ stage,
      classIdentity: ["Readable", "Writable", "Duplex", "Transform", "PassThrough"].every(name =>
        StaticStream[name] === required[name] && required[name] === dynamic[name]),
      functionIdentity: ["pipeline", "finished", "addAbortSignal"].every(name =>
        StaticStream[name] === required[name] && required[name] === dynamic[name]),
      defaultIdentity: StaticStream.default === required && dynamic.default === required,
      plainAliasIdentity: plainRequired === required,
    });
  }
  await snapshot("initial");
  const fs = require(fsName);
  const promisesName = ["node", "fs/promises"].join(":");
  const promises = require(promisesName);
  const dynamicFs = await import(fsName);
  const cycle = {
    fsPromisesIdentity: fs.promises === promises,
    fsNamespaceDefault: dynamicFs.default === (fs.default ?? fs),
    fsReadStreamBase: StaticStream.Readable.prototype.isPrototypeOf(fs.ReadStream.prototype),
    fsWriteStreamBase: StaticStream.Writable.prototype.isPrototypeOf(fs.WriteStream.prototype),
    readThroughCycle: await promises.readFile(fixtureFile, "utf8") === "stream-preload-cycle",
  };
  await snapshot("after-fs");
  const child = require(childName);
  const dynamicChild = await import(childName);
  const netName = ["node", "net"].join(":");
  const net = require(netName);
  const dependent = {
    childIdentity: child.spawn === dynamicChild.spawn && child.ChildProcess === dynamicChild.ChildProcess,
    childNamespaceDefault: dynamicChild.default === (child.default ?? child),
    netSocketBase: StaticStream.Duplex.prototype.isPrototypeOf(net.Socket.prototype),
  };
  await snapshot("after-child-process");
  const builtins = [];
  if (typeof StaticFs !== "undefined") {
    for (const [specifier, namespace, names] of [
      ["node:fs", StaticFs, ["readFileSync", "writeFileSync", "Stats"]],
      ["node:crypto", StaticCrypto, ["createHash", "randomBytes", "Hash", "KeyObject"]],
      ["node:child_process", StaticChildProcess, ["spawn", "execFile", "ChildProcess"]],
    ]) {
      const required = require(specifier);
      const dynamic = await import(specifier);
      builtins.push({ specifier,
        namedIdentity: names.every(name => namespace[name] === required[name] && required[name] === dynamic[name]),
        namespaceDefault: namespace.default === dynamic.default && dynamic.default === (required.default ?? required),
      });
    }
  }
  // The runtime loader deliberately keeps fs getter-only, while crypto must
  // remain reassignable for framework instrumentation. Reusing a bundled
  // namespace must preserve both behaviors as well as function identity.
  const crypto = require(["node", "crypto"].join(":"));
  const fsDescriptor = Object.getOwnPropertyDescriptor(fs, "readFile");
  const cryptoDescriptor = Object.getOwnPropertyDescriptor(crypto, "randomUUID");
  const originalReadFile = fs.readFile;
  const originalRandomUUID = crypto.randomUUID;
  const replacement = () => "builtin-identity-replacement";
  let mutability;
  try {
    const fsAssigned = Reflect.set(fs, "readFile", replacement);
    const cryptoAssigned = Reflect.set(crypto, "randomUUID", replacement);
    const dynamicCrypto = await import(["node", "crypto"].join(":"));
    mutability = {
      fsGetterOnly: typeof fsDescriptor.get === "function" && fsDescriptor.set === undefined,
      fsAssignmentRejected: !fsAssigned && fs.readFile === originalReadFile,
      cryptoAssignmentAccepted: cryptoAssigned && crypto.randomUUID === replacement,
      cryptoDynamicSeesAssignment: dynamicCrypto.randomUUID === replacement,
      cryptoAliasIdentity: require("crypto") === crypto,
    };
  } finally {
    Object.defineProperty(fs, "readFile", fsDescriptor);
    Object.defineProperty(crypto, "randomUUID", cryptoDescriptor);
  }
  mutability.restored = fs.readFile === originalReadFile && crypto.randomUUID === originalRandomUUID;
  return { isMainThread: Bun.isMainThread, stages, cycle, dependent, builtins, mutability };
}
