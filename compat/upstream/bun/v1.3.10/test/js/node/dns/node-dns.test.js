import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout, test } from "bun:test";
import { Buffer } from "node:buffer";
import { createSocket } from "node:dgram";
import * as dns from "node:dns";
import * as dns_promises from "node:dns/promises";
import * as util from "node:util";

const originalServers = dns.getServers();
let dnsServer;
let fixtureServer;

const recordTypes = {
  A: 1,
  NS: 2,
  CNAME: 5,
  SOA: 6,
  PTR: 12,
  MX: 15,
  TXT: 16,
  AAAA: 28,
  SRV: 33,
  NAPTR: 35,
  CAA: 257,
};

function encodeName(name) {
  return Buffer.concat([
    ...name.split(".").filter(Boolean).map(label => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])),
    Buffer.from([0]),
  ]);
}

function readQuestion(query) {
  const labels = [];
  let offset = 12;
  while (query[offset] !== 0) {
    const length = query[offset++];
    labels.push(query.subarray(offset, offset + length).toString());
    offset += length;
  }
  return {
    name: labels.join("."),
    type: query.readUInt16BE(offset + 1),
    end: offset + 5,
  };
}

function characterString(value) {
  const bytes = Buffer.from(value);
  return Buffer.concat([Buffer.from([bytes.length]), bytes]);
}

function recordData(type, questionName) {
  if (type === recordTypes.A) return Buffer.from([192, 0, 2, 42]);
  if (type === recordTypes.AAAA) {
    return Buffer.from([0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 42]);
  }
  if (type === recordTypes.NS) return encodeName("ns.fixture.test");
  if (type === recordTypes.CNAME) return encodeName("alias.fixture.test");
  if (type === recordTypes.PTR) {
    return encodeName(questionName.endsWith(".arpa") ? "dns.fixture.test" : "ptr-target.fixture.test");
  }
  if (type === recordTypes.MX) {
    const priority = Buffer.alloc(2);
    priority.writeUInt16BE(10);
    return Buffer.concat([priority, encodeName("mail.fixture.test")]);
  }
  if (type === recordTypes.TXT) return characterString("bun_test;test");
  if (type === recordTypes.SOA) {
    const numbers = Buffer.alloc(20);
    [123, 10000, 2400, 604800, 300].forEach((value, index) => numbers.writeUInt32BE(value, index * 4));
    return Buffer.concat([encodeName("ns.fixture.test"), encodeName("hostmaster.fixture.test"), numbers]);
  }
  if (type === recordTypes.SRV) {
    const values = Buffer.alloc(6);
    values.writeUInt16BE(10, 0);
    values.writeUInt16BE(50, 2);
    values.writeUInt16BE(80, 4);
    return Buffer.concat([values, encodeName("service.fixture.test")]);
  }
  if (type === recordTypes.NAPTR) {
    const values = Buffer.alloc(4);
    values.writeUInt16BE(1, 0);
    values.writeUInt16BE(12, 2);
    return Buffer.concat([
      values,
      characterString("S"),
      characterString("test"),
      characterString(""),
      encodeName("replacement.fixture.test"),
    ]);
  }
  if (type === recordTypes.CAA) {
    return Buffer.concat([Buffer.from([0, 5]), Buffer.from("issuebun.sh")]);
  }
  return null;
}

function dnsResponse(query, answers, responseCode = 0) {
  const { end } = readQuestion(query);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(query.readUInt16BE(0), 0);
  header.writeUInt16BE(0x8180 | responseCode, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(answers.length, 6);
  return Buffer.concat([header, query.subarray(12, end), ...answers]);
}

function dnsAnswer(type, data) {
  const answer = Buffer.alloc(12);
  answer.writeUInt16BE(0xc00c, 0);
  answer.writeUInt16BE(type, 2);
  answer.writeUInt16BE(1, 4);
  answer.writeUInt32BE(60, 6);
  answer.writeUInt16BE(data.length, 10);
  return Buffer.concat([answer, data]);
}

beforeAll(async () => {
  setDefaultTimeout(1000 * 60 * 5);

  dnsServer = createSocket("udp4");
  dnsServer.on("message", (query, remote) => {
    const question = readQuestion(query);
    const missing = question.name.includes("invalid") || question.name.endsWith(".invalid");
    const data = missing ? null : recordData(question.type, question.name);
    const answers = data === null ? [] : [dnsAnswer(question.type, data)];
    dnsServer.send(dnsResponse(query, answers, missing ? 3 : 0), remote.port, remote.address);
  });
  await new Promise((resolve, reject) => {
    dnsServer.once("error", reject);
    dnsServer.bind(0, "127.0.0.1", resolve);
  });
  fixtureServer = `127.0.0.1:${dnsServer.address().port}`;
  dns.setServers([fixtureServer]);
});

afterAll(async () => {
  dns.setServers(originalServers);
  if (dnsServer !== undefined) {
    await new Promise(resolve => dnsServer.close(resolve));
  }
});

// TODO:
test("it exists", () => {
  expect(dns).toBeDefined();
  expect(dns.lookup).toBeDefined();
  expect(dns.lookupService).toBeDefined();
  expect(dns.resolve).toBeDefined();
  expect(dns.resolve4).toBeDefined();
  expect(dns.resolve6).toBeDefined();
  expect(dns.resolveSrv).toBeDefined();
  expect(dns.resolveTxt).toBeDefined();
  expect(dns.resolveSoa).toBeDefined();
  expect(dns.resolveNaptr).toBeDefined();
  expect(dns.resolveMx).toBeDefined();
  expect(dns.resolveCaa).toBeDefined();
  expect(dns.resolveNs).toBeDefined();
  expect(dns.resolvePtr).toBeDefined();
  expect(dns.resolveCname).toBeDefined();

  expect(dns.promises).toBeDefined();
  expect(dns.promises.lookup).toBeDefined();
  expect(dns.promises.lookupService).toBeDefined();
  expect(dns.promises.resolve).toBeDefined();
  expect(dns.promises.resolve4).toBeDefined();
  expect(dns.promises.resolve6).toBeDefined();
  expect(dns.promises.resolveSrv).toBeDefined();
  expect(dns.promises.resolveTxt).toBeDefined();
  expect(dns.promises.resolveSoa).toBeDefined();
  expect(dns.promises.resolveNaptr).toBeDefined();
  expect(dns.promises.resolveMx).toBeDefined();
  expect(dns.promises.resolveCaa).toBeDefined();
  expect(dns.promises.resolveNs).toBeDefined();
  expect(dns.promises.resolvePtr).toBeDefined();
  expect(dns.promises.resolveCname).toBeDefined();

  expect(dns_promises).toBeDefined();
  expect(dns_promises.lookup).toBeDefined();
  expect(dns_promises.lookupService).toBeDefined();
  expect(dns_promises.resolve).toBeDefined();
  expect(dns_promises.resolve4).toBeDefined();
  expect(dns_promises.resolve6).toBeDefined();
  expect(dns_promises.resolveSrv).toBeDefined();
  expect(dns_promises.resolveTxt).toBeDefined();
  expect(dns_promises.resolveSoa).toBeDefined();
  expect(dns_promises.resolveNaptr).toBeDefined();
  expect(dns_promises.resolveMx).toBeDefined();
  expect(dns_promises.resolveCaa).toBeDefined();
  expect(dns_promises.resolveNs).toBeDefined();
  expect(dns_promises.resolvePtr).toBeDefined();
  expect(dns_promises.resolveCname).toBeDefined();
});

test("dns.resolveSrv (_test._tcp.fixture.test)", () => {
  const { promise, resolve, reject } = Promise.withResolvers();
  dns.resolveSrv("_test._tcp.fixture.test", (err, results) => {
    try {
      expect(err).toBeNull();
      expect(results instanceof Array).toBe(true);
      expect(results[0].name).toBe("service.fixture.test");
      expect(results[0].priority).toBe(10);
      expect(results[0].weight).toBe(50);
      expect(results[0].port).toBe(80);
      resolve();
    } catch (error) {
      reject(err || error);
    }
  });
  return promise;
});

test("dns.resolveSrv (_test._tcp.invalid.fixture.test)", () => {
  const { promise, resolve, reject } = Promise.withResolvers();
  dns.resolveSrv("_test._tcp.invalid.fixture.test", (err, results) => {
    try {
      expect(err).toBeTruthy();
      expect(results).toBeUndefined(true);
      resolve();
    } catch (error) {
      reject(err || error);
    }
  });
  return promise;
});

test("dns.resolveTxt (txt.fixture.test)", () => {
  const { promise, resolve, reject } = Promise.withResolvers();
  dns.resolveTxt("txt.fixture.test", (err, results) => {
    try {
      expect(err).toBeNull();
      expect(results instanceof Array).toBe(true);
      expect(results[0][0]).toBe("bun_test;test");
      resolve();
    } catch (error) {
      reject(err || error);
    }
  });
  return promise;
});

test("dns.resolveSoa (fixture.test)", () => {
  const { promise, resolve, reject } = Promise.withResolvers();
  dns.resolveSoa("fixture.test", (err, result) => {
    try {
      expect(err).toBeNull();
      expect(result.serial).toBe(123);
      expect(result.refresh).toBe(10000);
      expect(result.retry).toBe(2400);
      expect(result.expire).toBe(604800);
      expect(result.minttl).toBe(300);
      expect(result.nsname).toBe("ns.fixture.test");
      expect(result.hostmaster).toBe("hostmaster.fixture.test");
      resolve();
    } catch (error) {
      reject(err || error);
    }
  });
  return promise;
});

test("dns.resolveSoa (empty string)", () => {
  const { promise, resolve, reject } = Promise.withResolvers();
  dns.resolveSoa("", (err, result) => {
    try {
      expect(err).toBeNull();
      // one of root server
      expect(result).not.toBeUndefined();
      resolve();
    } catch (error) {
      reject(err || error);
    }
  });
  return promise;
});

test("dns.resolveNaptr (naptr.fixture.test)", () => {
  const { promise, resolve, reject } = Promise.withResolvers();
  dns.resolveNaptr("naptr.fixture.test", (err, results) => {
    try {
      expect(err).toBeNull();
      expect(results instanceof Array).toBe(true);
      expect(results[0].flags).toBe("S");
      expect(results[0].service).toBe("test");
      expect(results[0].regexp).toBe("");
      expect(results[0].replacement).toBe("replacement.fixture.test");
      expect(results[0].order).toBe(1);
      expect(results[0].preference).toBe(12);
      resolve();
    } catch (error) {
      reject(err || error);
    }
  });
  return promise;
});

test("dns.resolveCaa (caa.fixture.test)", () => {
  const { promise, resolve, reject } = Promise.withResolvers();
  dns.resolveCaa("caa.fixture.test", (err, results) => {
    try {
      expect(err).toBeNull();
      expect(results instanceof Array).toBe(true);
      expect(results[0].critical).toBe(0);
      expect(results[0].issue).toBe("bun.sh");
      resolve();
    } catch (error) {
      reject(err || error);
    }
  });
  return promise;
});

test("dns.resolveMx (fixture.test)", () => {
  const { promise, resolve, reject } = Promise.withResolvers();
  dns.resolveMx("fixture.test", (err, results) => {
    try {
      expect(err).toBeNull();
      expect(results instanceof Array).toBe(true);
      const priority = results[0].priority;
      expect(priority >= 0 && priority < 65535).toBe(true);
      expect(results[0].exchange).toBe("mail.fixture.test");
      resolve();
    } catch (error) {
      reject(err || error);
    }
  });
  return promise;
});

test("dns.resolveNs (fixture.test) ", () => {
  const { promise, resolve, reject } = Promise.withResolvers();
  dns.resolveNs("fixture.test", (err, results) => {
    try {
      expect(err).toBeNull();
      expect(results instanceof Array).toBe(true);
      expect(results).toEqual(["ns.fixture.test"]);
      resolve();
    } catch (error) {
      reject(err || error);
    }
  });
  return promise;
});

test("dns.resolveNs (empty string) ", () => {
  const { promise, resolve, reject } = Promise.withResolvers();
  dns.resolveNs("", (err, results) => {
    try {
      expect(err).toBeNull();
      expect(results instanceof Array).toBe(true);
      expect(results).toEqual(["ns.fixture.test"]);
      resolve();
    } catch (error) {
      reject(err || error);
    }
  });
  return promise;
});

test("dns.resolvePtr (ptr.fixture.test)", () => {
  const { promise, resolve, reject } = Promise.withResolvers();
  dns.resolvePtr("ptr.fixture.test", (err, results) => {
    try {
      expect(err).toBeNull();
      expect(results instanceof Array).toBe(true);
      expect(results[0]).toBe("ptr-target.fixture.test");
      resolve();
    } catch (error) {
      reject(err || error);
    }
  });
  return promise;
});

test("dns.resolveCname (cname.fixture.test)", () => {
  const { promise, resolve, reject } = Promise.withResolvers();
  dns.resolveCname("cname.fixture.test", (err, results) => {
    try {
      expect(err).toBeNull();
      expect(results instanceof Array).toBe(true);
      expect(results[0]).toBe("alias.fixture.test");
      resolve();
    } catch (error) {
      reject(err || error);
    }
  });
  return promise;
});

test("dns.lookup (LOCALHOST)", () => {
  const { promise, resolve, reject } = Promise.withResolvers();
  dns.lookup("LOCALHOST", (err, address, family) => {
    try {
      expect(err).toBeNull();
      expect(typeof address).toBe("string");
      resolve();
    } catch (error) {
      reject(err || error);
    }
  });
  return promise;
});

test("dns.lookup bad (does-not-exist.invalid)", () => {
  const { promise, resolve, reject } = Promise.withResolvers();
  dns.lookup("does-not-exist.invalid", (err, address, family) => {
    try {
      expect(err).not.toBeNull();
      expect(err.syscall).toEqual("getaddrinfo");
      expect(err.code).toEqual("ENOTFOUND");
      expect(address).toBeUndefined();
      expect(family).toBeUndefined();
      resolve();
    } catch (error) {
      reject(err || error);
    }
  });
  return promise;
});

test("dns.lookup (LOCALHOST) with { all: true } #2675", () => {
  const { promise, resolve, reject } = Promise.withResolvers();
  dns.lookup("LOCALHOST", { all: true }, (err, address, family) => {
    try {
      expect(err).toBeNull();
      expect(Array.isArray(address)).toBe(true);
      resolve();
    } catch (error) {
      reject(err || error);
    }
  });
  return promise;
});

test("dns.lookup (localhost)", () => {
  const { promise, resolve, reject } = Promise.withResolvers();
  dns.lookup("localhost", (err, address, family) => {
    expect(err).toBeNull();
    if (family === 6) {
      expect(address).toBe("::1");
    } else {
      expect(address).toBe("127.0.0.1");
    }

    err ? reject(err) : resolve();
  });

  return promise;
});

test("dns.getServers", () => {
  expect(dns.getServers()).toEqual([fixtureServer]);
});

describe("dns.reverse", () => {
  const inputs = [
    ["192.0.2.42", "dns.fixture.test"],
    ["2001:db8::42", "dns.fixture.test"],
    ["2001:db8::43", "dns.fixture.test"],
    ["192.0.2.43", "dns.fixture.test"],
  ];
  it.each(inputs)("%s <- %s", (ip, expected) => {
    const { promise, resolve, reject } = Promise.withResolvers();
    dns.reverse(ip, (err, hostnames) => {
      try {
        expect(err).toBeNull();
        expect(hostnames).toContain(expected);
        resolve();
      } catch (error) {
        reject(err || error);
      }
    });
    return promise;
  });
});

test("dns.promises.reverse", async () => {
  {
    let hostnames = await dns.promises.reverse("192.0.2.42");
    expect(hostnames).toContain("dns.fixture.test");
  }
  {
    let hostnames = await dns.promises.reverse("192.0.2.43");
    expect(hostnames).toContain("dns.fixture.test");
  }
  {
    let hostnames = await dns.promises.reverse("2001:db8::42");
    expect(hostnames).toContain("dns.fixture.test");
  }
});

describe("test invalid arguments", () => {
  it.each([
    // TODO: dns.resolveAny is not implemented yet
    ["dns.resolveCname", dns.resolveCname],
    ["dns.resolveCaa", dns.resolveCaa],
    ["dns.resolveMx", dns.resolveMx],
    ["dns.resolveNaptr", dns.resolveNaptr],
    ["dns.resolveNs", dns.resolveNs],
    ["dns.resolvePtr", dns.resolvePtr],
    ["dns.resolveSoa", dns.resolveSoa],
    ["dns.resolveSrv", dns.resolveSrv],
    ["dns.resolveTxt", dns.resolveTxt],
  ])("%s", (_, fn, done) => {
    fn("a".repeat(2000), (err, results) => {
      try {
        expect(err).not.toBeNull();
        expect(results).toBeUndefined();
        // Assert we convert our error codes to Node.js error codes
        expect(err.code).not.toStartWith("DNS_");
        done();
      } catch (e) {
        done(e);
      }
    });
  });

  it("dns.lookupService", async () => {
    expect(() => {
      dns.lookupService("", 443, (err, hostname, service) => {});
    }).toThrow("Expected address to be a non-empty string for 'lookupService'.");
    expect(() => {
      dns.lookupService("fixture.test", 443, (err, hostname, service) => {});
    }).toThrow(`The "address" argument is invalid. Received type string ('fixture.test')`);
  });
});

describe("dns.lookupService", () => {
  it.each([
    ["127.0.0.1", 53, ["localhost", "domain"]],
    ["::1", 53, ["localhost", "domain"]],
    ["::1", 80, ["localhost", "http"]],
    ["127.0.0.1", 80, ["localhost", "http"]],
    ["127.0.0.1", 443, ["localhost", "https"]],
  ])("lookupService(%s, %d)", (address, port, expected) => {
    const { promise, resolve, reject } = Promise.withResolvers();
    dns.lookupService(address, port, (err, hostname, service) => {
      try {
        expect(err).toBeNull();
        expect(hostname).toStrictEqual(expected[0]);
        expect(service).toStrictEqual(expected[1]);
        resolve();
      } catch (err) {
        reject(err);
      }
    });

    return promise;
  });

  it("lookupService(255.255.255.255, 443)", () => {
    const { promise, resolve, reject } = Promise.withResolvers();
    dns.lookupService("255.255.255.255", 443, (err, hostname, service) => {
      if (process.platform == "darwin") {
        try {
          expect(err).toBeNull();
          expect(hostname).toStrictEqual("broadcasthost");
          expect(service).toStrictEqual("https");
          resolve();
        } catch (err) {
          reject(err);
        }
      } else {
        try {
          expect(err).not.toBeNull();
          expect(hostname).toBeUndefined();
          expect(service).toBeUndefined();
          resolve();
        } catch (err) {
          reject(err);
        }
      }
    });
  });

  it.each([
    ["127.0.0.1", 53, ["localhost", "domain"]],
    ["::1", 53, ["localhost", "domain"]],
    ["::1", 80, ["localhost", "http"]],
    ["127.0.0.1", 80, ["localhost", "http"]],
    ["127.0.0.1", 443, ["localhost", "https"]],
  ])("promises.lookupService(%s, %d)", async (address, port, expected) => {
    const { hostname, service } = await dns.promises.lookupService(address, port);
    expect(hostname).toStrictEqual(expected[0]);
    expect(service).toStrictEqual(expected[1]);
  });
});

// Deprecated reference: https://nodejs.org/api/deprecations.html#DEP0118
describe("lookup deprecated behavior", () => {
  it.each([undefined, false, null, NaN, ""])("dns.lookup", domain => {
    dns.lookup(domain, (error, address, family) => {
      expect(error).toBeNull();
      expect(address).toBeNull();
      expect(family).toBe(4);
    });
  });
});

describe("uses `dns.promises` implementations for `util.promisify` factory", () => {
  it.each([
    "lookup",
    "lookupService",
    "resolve",
    "reverse",
    "resolve4",
    "resolve6",
    "resolveAny",
    "resolveCname",
    "resolveCaa",
    "resolveMx",
    "resolveNs",
    "resolvePtr",
    "resolveSoa",
    "resolveSrv",
    "resolveTxt",
    "resolveNaptr",
  ])("%s", method => {
    expect(dns[method][util.promisify.custom]).toBe(dns_promises[method]);
    expect(dns.promises[method]).toBe(dns_promises[method]);
  });

  it("util.promisify(dns.lookup) acts like dns.promises.lookup", async () => {
    expect(await util.promisify(dns.lookup)("127.0.0.1")).toEqual(await dns.promises.lookup("127.0.0.1"));
  });
});
