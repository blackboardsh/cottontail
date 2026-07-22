import { expect, test } from "bun:test";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { once } from "node:events";
import { cert, key } from "./fixtures/tls-cert.js";

async function listen(server: http.Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as net.AddressInfo).port;
}

async function close(server: http.Server) {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error?: Error) => error ? reject(error) : resolve());
  });
}

async function responseText(response: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of response) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString();
}

test("Node and Bun HTTP constructors expose source-compatible defaults and validation", () => {
  expect(http.globalAgent.keepAlive).toBe(true);
  expect(http.globalAgent.scheduling).toBe("lifo");
  expect(http.globalAgent.options.timeout).toBe(5000);
  expect(http.Agent.defaultMaxSockets).toBe(Infinity);
  expect(https.globalAgent.keepAlive).toBe(true);
  expect(https.globalAgent.defaultPort).toBe(443);
  expect(https.globalAgent.protocol).toBe("https:");
  expect((http.Server as any)()).toBeInstanceOf(http.Server);
  expect((https.Server as any)()).toBeInstanceOf(https.Server);

  const outgoing = new http.OutgoingMessage();
  outgoing.setHeader("X-Original-Case", "one");
  outgoing.appendHeader("x-original-case", "two");
  expect(outgoing.getHeaderNames()).toEqual(["x-original-case"]);
  expect(outgoing.getRawHeaderNames()).toEqual(["X-Original-Case"]);
  expect(outgoing.getHeaders()["x-original-case"]).toEqual(["one", "two"]);
  outgoing.write("abc");
  expect(outgoing.writableLength).toBe(3);
  expect(outgoing.outputSize).toBe(3);

  expect(() => new http.Agent({ scheduling: "random" as any })).toThrow();
  expect(() => http.request({ protocol: "https:" })).toThrow();
  expect(() => http.request({ method: "bad method" })).toThrow();
  expect(() => http.request({ path: "/bad\npath" })).toThrow();
  expect(() => http.createServer({ requestTimeout: 10, headersTimeout: 20 })).toThrow();
  try {
    http.validateHeaderValue("x-non-latin1", "\u05dc\u05d0");
    throw new Error("expected validateHeaderValue to reject non-Latin-1 text");
  } catch (error: any) {
    expect(error.code).toBe("ERR_INVALID_CHAR");
  }

  const tlsAgent = new https.Agent();
  expect(tlsAgent.getName({ host: "example.test", port: 443, servername: "one.test" }))
    .not.toBe(tlsAgent.getName({ host: "example.test", port: 443, servername: "two.test" }));

  const dynamicSecureAgent = {
    addRequest() {},
    isSecureEndpoint(options: { protocol?: string }) { return options.protocol === "https:"; },
  };
  const dynamicRequest = https.request({ hostname: "example.test", agent: dynamicSecureAgent as any });
  expect(dynamicRequest.protocol).toBe("https:");
  dynamicRequest.destroy();
  expect(() => https.request({ hostname: "example.test", agent: new http.Agent() })).toThrow();

  const optionUrl = new URL("http://example.test/resource");
  (optionUrl as any).headers = { "X-From-URL": "yes" };
  (optionUrl as any).agent = { addRequest() {} };
  const urlRequest = http.request(optionUrl);
  expect(urlRequest.getHeader("x-from-url")).toBe("yes");
  urlRequest.destroy();
});

test("HTTP and HTTPS listen callbacks retain Bun binding metadata", async () => {
  const bind = (server: http.Server) => new Promise<{ host: string; port: number }>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port: 0, host: "127.0.0.1" }, (error: Error | null, host: string, port: number) => {
      if (error) reject(error);
      else resolve({ host, port });
    });
  });

  const server = http.createServer((_request, response) => response.end("ok"));
  try {
    const binding = await bind(server);
    expect(binding.host).toBe("127.0.0.1");
    expect(binding.port).toBe((server.address() as net.AddressInfo).port);
  } finally {
    await close(server);
  }

  const secureServer = https.createServer({ cert, key }, (_request, response) => response.end("ok"));
  try {
    const binding = await bind(secureServer as unknown as http.Server);
    expect(binding.host).toBe("127.0.0.1");
    expect(binding.port).toBe((secureServer.address() as net.AddressInfo).port);
  } finally {
    await close(secureServer as unknown as http.Server);
  }
});

test("HTTP parser errors use parser-facing Node codes", async () => {
  const server = http.createServer();
  const port = await listen(server);
  try {
    const parserError = new Promise<string>((resolve) => {
      server.once("clientError", (error: NodeJS.ErrnoException) => {
        resolve(String(error.code));
      });
    });
    const socket = net.connect(port, "127.0.0.1");
    await once(socket, "connect");
    let wire = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { wire += chunk; });
    const ended = once(socket, "end");
    socket.write("GET / HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding : chunked\r\n\r\n");
    expect(await parserError).toBe("HPE_INVALID_HEADER_TOKEN");
    await ended;
    expect(wire).toContain("400 Bad Request");
    socket.destroy();
  } finally {
    await close(server);
  }
});

test("malformed chunk framing retains the parser fallback response", async () => {
  const server = http.createServer();
  const port = await listen(server);
  try {
    const parserError = new Promise<string>((resolve) => {
      server.once("clientError", (error: NodeJS.ErrnoException) => {
        resolve(String(error.code));
      });
    });
    const socket = net.connect(port, "127.0.0.1");
    await once(socket, "connect");
    let wire = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { wire += chunk; });
    const ended = once(socket, "end");
    socket.write("POST / HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\n\r\ninvalid\r\n");
    expect(await parserError).toBe("HPE_INVALID_CHUNK_SIZE");
    await ended;
    expect(wire).toContain("400 Bad Request");
    socket.destroy();
  } finally {
    await close(server);
  }
});

test("HTTP response parsing preserves an empty wire status message", async () => {
  const server = net.createServer((socket) => {
    socket.once("data", () => socket.end("HTTP/1.1 200\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const request = http.get({ host: "127.0.0.1", port: (server.address() as net.AddressInfo).port }, resolve);
      request.on("error", reject);
    });
    expect(response.statusMessage).toBe("");
    await responseText(response);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("HTTP server responses replace an empty status message with the standard reason phrase", async () => {
  const server = http.createServer((_request, response) => {
    response.statusMessage = "";
    response.end();
  });
  const port = await listen(server);
  try {
    const socket = net.connect(port, "127.0.0.1");
    await once(socket, "connect");
    socket.setEncoding("utf8");
    let wire = "";
    socket.on("data", (chunk) => { wire += chunk; });
    const ended = once(socket, "end");
    socket.write("GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
    await ended;
    expect(wire.split("\r\n", 1)[0]).toBe("HTTP/1.1 200 OK");
  } finally {
    await close(server);
  }
});

test("live request and response parsers preserve duplicate header semantics", async () => {
  let resolveRequestHeaders!: (value: {
    cookie: string;
    contentType: string;
    multi: string;
    distinct: string[];
  }) => void;
  const requestHeaders = new Promise<{
    cookie: string;
    contentType: string;
    multi: string;
    distinct: string[];
  }>((resolve) => { resolveRequestHeaders = resolve; });
  const server = http.createServer((request, response) => {
    resolveRequestHeaders({
      cookie: String(request.headers.cookie),
      contentType: String(request.headers["content-type"]),
      multi: String(request.headers["x-multi"]),
      distinct: request.headersDistinct["content-type"],
    });
    response.end("ok");
  });
  const port = await listen(server);
  try {
    const socket = net.connect(port, "127.0.0.1");
    await once(socket, "connect");
    const closed = once(socket, "close");
    socket.write(
      "GET /duplicates HTTP/1.1\r\n" +
      "Host: localhost\r\n" +
      "Cookie: a=1\r\n" +
      "Cookie: b=2\r\n" +
      "Content-Type: first\r\n" +
      "Content-Type: second\r\n" +
      "X-Multi: one\r\n" +
      "X-Multi: two\r\n" +
      "Connection: close\r\n\r\n",
    );
    const observed = await requestHeaders;
    expect(observed.cookie).toBe("a=1; b=2");
    expect(observed.contentType).toBe("first");
    expect(observed.multi).toBe("one, two");
    expect(observed.distinct).toEqual(["first", "second"]);
    await closed;
  } finally {
    await close(server);
  }

  const rawServer = net.createServer((socket) => {
    socket.once("data", () => socket.end(
      "HTTP/1.1 200 OK\r\n" +
      "Set-Cookie: a=1\r\n" +
      "Set-Cookie: b=2\r\n" +
      "Cookie: c=3\r\n" +
      "Cookie: d=4\r\n" +
      "Content-Type: first\r\n" +
      "Content-Type: second\r\n" +
      "X-Multi: one\r\n" +
      "X-Multi: two\r\n" +
      "Content-Length: 0\r\n" +
      "Connection: close\r\n\r\n",
    ));
  });
  const rawPort = await listen(rawServer as unknown as http.Server);
  try {
    const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const request = http.get({ host: "127.0.0.1", port: rawPort }, resolve);
      request.on("error", reject);
    });
    expect(response.headers["set-cookie"]).toEqual(["a=1", "b=2"]);
    expect(response.headers.cookie).toBe("c=3; d=4");
    expect(response.headers["content-type"]).toBe("first");
    expect(response.headers["x-multi"]).toBe("one, two");
    expect(response.headersDistinct["content-type"]).toEqual(["first", "second"]);
    await responseText(response);
  } finally {
    await close(rawServer as unknown as http.Server);
  }
});

test("ClientRequest reports binding parser framing failures", async () => {
  const server = net.createServer((socket) => {
    socket.once("data", () => socket.end(
      "HTTP/1.1 200 OK\r\n" +
      "Transfer-Encoding: chunked\r\n" +
      "Content-Length: 1\r\n\r\n" +
      "0\r\n\r\n",
    ));
  });
  const port = await listen(server as unknown as http.Server);
  try {
    let emittedResponse = false;
    const error = await new Promise<NodeJS.ErrnoException & { rawPacket?: Buffer }>((resolve, reject) => {
      const request = http.get({ host: "127.0.0.1", port }, () => { emittedResponse = true; });
      request.once("error", resolve);
      request.once("close", () => {
        if (!request.destroyed) reject(new Error("request closed without a parser error"));
      });
    });
    expect(error.code).toBe("HPE_INVALID_CONTENT_LENGTH");
    expect(error.message).toContain("Content-Length can't be present with Transfer-Encoding");
    expect(Buffer.isBuffer(error.rawPacket)).toBe(true);
    expect(emittedResponse).toBe(false);
  } finally {
    await close(server as unknown as http.Server);
  }
});

test("server parser retains pipelined bytes through request backpressure", async () => {
  const paths: string[] = [];
  let firstTrailer = "";
  const server = http.createServer({ highWaterMark: 32 }, (request, response) => {
    paths.push(String(request.url));
    if (request.url === "/one") {
      setTimeout(() => request.resume(), 20);
      request.once("end", () => {
        firstTrailer = String(request.trailers["x-final"]);
        response.end("one");
      });
      return;
    }
    response.end("two");
  });
  const port = await listen(server);
  try {
    const body = Buffer.alloc(4096, 0x78);
    const socket = net.connect(port, "127.0.0.1");
    await once(socket, "connect");
    let wire = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { wire += chunk; });
    const closed = Promise.race([once(socket, "end"), once(socket, "close")]);
    socket.write(Buffer.concat([
      Buffer.from(
        "POST /one HTTP/1.1\r\n" +
        "Host: localhost\r\n" +
        "Transfer-Encoding: chunked\r\n" +
        "Trailer: X-Final\r\n\r\n" +
        `${body.byteLength.toString(16)}\r\n`,
      ),
      body,
      Buffer.from(
        "\r\n0\r\nX-Final: retained\r\n\r\n" +
        "GET /two HTTP/1.1\r\n" +
        "Host: localhost\r\n" +
        "Connection: close\r\n\r\n",
      ),
    ]));
    await closed;
    expect(paths).toEqual(["/one", "/two"]);
    expect(firstTrailer).toBe("retained");
    expect(wire.match(/HTTP\/1\.1 200/g)?.length).toBe(2);
    expect(wire).toContain("one");
    expect(wire).toContain("two");
  } finally {
    await close(server);
  }
});

test("ClientRequest and IncomingMessage stream both directions before end", async () => {
  let sawFirstRequestChunk!: () => void;
  const firstRequestChunk = new Promise<void>((resolve) => { sawFirstRequestChunk = resolve; });
  const server = http.createServer((request, response) => {
    let requestBody = "";
    let first = true;
    request.on("data", (chunk) => {
      requestBody += chunk.toString();
      if (first) {
        first = false;
        response.write("response-before-request-end:");
        sawFirstRequestChunk();
      }
    });
    request.once("end", () => response.end(requestBody));
  });
  const port = await listen(server);

  try {
    let responseResolve!: (response: http.IncomingMessage) => void;
    const responsePromise = new Promise<http.IncomingMessage>((resolve) => { responseResolve = resolve; });
    let firstResponseResolve!: (chunk: string) => void;
    const firstResponse = new Promise<string>((resolve) => { firstResponseResolve = resolve; });
    let completeResponseResolve!: (body: string) => void;
    const completeResponse = new Promise<string>((resolve) => { completeResponseResolve = resolve; });
    const request = http.request({ host: "127.0.0.1", port, method: "POST" }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => {
        chunks.push(Buffer.from(chunk));
        if (chunks.length === 1) firstResponseResolve(String(chunk));
      });
      response.on("end", () => completeResponseResolve(Buffer.concat(chunks).toString()));
      responseResolve(response);
    });
    request.write("one");
    await firstRequestChunk;
    await responsePromise;
    expect(await firstResponse).toContain("response-before-request-end:");
    request.end("two");
    expect(await completeResponse).toContain("onetwo");
  } finally {
    await close(server);
  }
});

test("informational responses, distinct headers, and trailers retain wire semantics", async () => {
  const server = http.createServer((_request, response) => {
    response.writeEarlyHints({ link: ["</one>; rel=preload", "</two>; rel=preload"], "x-hint": "yes" });
    response.writeProcessing();
    response.setHeader("Set-Cookie", ["a=1", "b=2"]);
    response.setHeader("Trailer", "X-Final");
    response.write("body");
    response.addTrailers({ "X-Final": "done" });
    response.end();
  });
  const port = await listen(server);
  try {
    const information: number[] = [];
    const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const request = http.get({ host: "127.0.0.1", port }, resolve);
      request.on("information", (info) => information.push(info.statusCode));
      request.on("error", reject);
    });
    expect(await responseText(response)).toBe("body");
    expect(information).toEqual([103, 102]);
    expect(response.headersDistinct["set-cookie"]).toEqual(["a=1", "b=2"]);
    expect(response.trailersDistinct["x-final"]).toEqual(["done"]);
  } finally {
    await close(server);
  }
});

test("server expectation handling and response body invariants match Node", async () => {
  let requestEvents = 0;
  const server = http.createServer({ rejectNonStandardBodyWrites: true }, (request, response) => {
    requestEvents += 1;
    if (request.method === "HEAD") {
      expect(() => response.write("forbidden")).toThrow();
      response.end();
      return;
    }
    response.end("ok");
  });
  const port = await listen(server);
  try {
    const expectation = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const request = http.request({
        host: "127.0.0.1",
        port,
        headers: { Expect: "something-else" },
      }, resolve);
      request.on("error", reject);
      request.end();
    });
    expect(expectation.statusCode).toBe(417);
    await responseText(expectation);
    expect(requestEvents).toBe(0);

    const head = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const request = http.request({ host: "127.0.0.1", port, method: "HEAD" }, resolve);
      request.on("error", reject);
      request.end();
    });
    expect(await responseText(head)).toBe("");
    expect(requestEvents).toBe(1);

    const strict = new http.ServerResponse(new http.IncomingMessage({ method: "GET", deferBody: true } as any));
    strict.strictContentLength = true;
    strict.setHeader("Content-Length", "3");
    expect(() => strict.end("no")).toThrow();
  } finally {
    await close(server);
  }
});

test("custom message classes and maxRequestsPerSocket apply to the parser pipeline", async () => {
  class CustomIncoming extends http.IncomingMessage { customIncoming = true; }
  class CustomResponse extends http.ServerResponse { customResponse = true; }
  let customPair = false;
  let dropped = 0;
  const server = http.createServer({ IncomingMessage: CustomIncoming, ServerResponse: CustomResponse }, (request, response) => {
    customPair = (request as CustomIncoming).customIncoming && (response as CustomResponse).customResponse;
    response.end("first");
  });
  server.maxRequestsPerSocket = 1;
  server.on("dropRequest", () => { dropped += 1; });
  const port = await listen(server);
  try {
    const socket = net.connect(port, "127.0.0.1");
    await once(socket, "connect");
    let wire = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { wire += chunk; });
    const closed = Promise.race([once(socket, "end"), once(socket, "close")]);
    socket.write(
      "GET /one HTTP/1.1\r\nHost: localhost\r\n\r\n" +
      "GET /two HTTP/1.1\r\nHost: localhost\r\n\r\n",
    );
    await closed;
    expect(customPair).toBe(true);
    expect(dropped).toBe(1);
    expect(wire).toContain("200 OK");
    expect(wire).toContain("503 Service Unavailable");
  } finally {
    await close(server);
  }
});

test("HTTPS shares streaming, pooling, upgrade, and trailer behavior", async () => {
  const server = https.createServer({ cert, key }, (request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk.toString(); });
    request.on("end", () => response.end(`secure:${body}`));
  });
  const port = await listen(server as unknown as http.Server);
  const agent = new https.Agent({ keepAlive: true, maxSockets: 1, rejectUnauthorized: false });
  try {
    const perform = (body: string) => new Promise<{ request: http.ClientRequest; body: string }>((resolve, reject) => {
      const request = https.request({
        host: "127.0.0.1",
        port,
        method: "POST",
        agent,
      }, async (response) => {
        try { resolve({ request: request as unknown as http.ClientRequest, body: await responseText(response) }); }
        catch (error) { reject(error); }
      });
      request.on("error", reject);
      request.end(body);
    });
    const first = await perform("one");
    const second = await perform("two");
    expect(first.body).toBe("secure:one");
    expect(second.body).toBe("secure:two");
    expect(first.request.reusedSocket).toBe(false);
    expect(second.request.reusedSocket).toBe(true);
  } finally {
    agent.destroy();
    await close(server as unknown as http.Server);
  }

  const trailerServer = tls.createServer({ cert, key }, (socket) => {
    socket.once("data", () => socket.end(
      "HTTP/1.1 200 OK\r\n" +
      "Transfer-Encoding: chunked\r\n" +
      "Trailer: X-Secure-Final\r\n\r\n" +
      "2\r\nok\r\n0\r\nX-Secure-Final: yes\r\n\r\n",
    ));
  });
  const trailerPort = await listen(trailerServer as unknown as http.Server);
  try {
    const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const request = https.get({ host: "127.0.0.1", port: trailerPort, rejectUnauthorized: false }, resolve);
      request.on("error", reject);
    });
    expect(await responseText(response)).toBe("ok");
    expect(response.trailersDistinct["x-secure-final"]).toEqual(["yes"]);
  } finally {
    await close(trailerServer as unknown as http.Server);
  }
});
