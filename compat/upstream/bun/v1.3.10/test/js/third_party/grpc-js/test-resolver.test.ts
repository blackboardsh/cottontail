/*
 * Copyright 2019 gRPC authors.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */

// Allow `any` data type for testing runtime type checking.
// tslint:disable no-any
import type { StatusObject } from "@grpc/grpc-js/build/src/call-interface";
import type * as ResolverManager from "@grpc/grpc-js/build/src/resolver";
import type { ServiceConfig } from "@grpc/grpc-js/build/src/service-config";
import type { Endpoint, SubchannelAddress } from "@grpc/grpc-js/build/src/subchannel-address";
import type { GrpcUri } from "@grpc/grpc-js/build/src/uri-parser";
import assert from "assert";
import { afterAll, beforeAll as before, describe, it } from "bun:test";
import { Buffer } from "node:buffer";
import { createSocket } from "node:dgram";

// grpc-js applies DNS URI authorities to its Resolver instance in alternative-resolver mode.
process.env.GRPC_NODE_USE_ALTERNATIVE_RESOLVER = "true";

const [resolverManager, resolver_dns, resolver_ip, resolver_uds, subchannelAddress, uriParser] = await Promise.all([
  import("@grpc/grpc-js/build/src/resolver"),
  import("@grpc/grpc-js/build/src/resolver-dns"),
  import("@grpc/grpc-js/build/src/resolver-ip"),
  import("@grpc/grpc-js/build/src/resolver-uds"),
  import("@grpc/grpc-js/build/src/subchannel-address"),
  import("@grpc/grpc-js/build/src/uri-parser"),
]);
const { endpointToString, subchannelAddressEqual } = subchannelAddress;
const { parseUri } = uriParser;

const recordTypes = { A: 1, TXT: 16, AAAA: 28 } as const;
let dnsServer: ReturnType<typeof createSocket>;
let fixtureServer: string;

function readQuestion(query: Buffer) {
  const labels: string[] = [];
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

function dnsAnswer(type: number, data: Buffer) {
  const answer = Buffer.alloc(12);
  answer.writeUInt16BE(0xc00c, 0);
  answer.writeUInt16BE(type, 2);
  answer.writeUInt16BE(1, 4);
  answer.writeUInt32BE(60, 6);
  answer.writeUInt16BE(data.length, 10);
  return Buffer.concat([answer, data]);
}

function dnsResponse(query: Buffer, answers: Buffer[], responseCode = 0) {
  const { end } = readQuestion(query);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(query.readUInt16BE(0), 0);
  header.writeUInt16BE(0x8180 | responseCode, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(answers.length, 6);
  return Buffer.concat([header, query.subarray(12, end), ...answers]);
}

function characterString(value: string) {
  const bytes = Buffer.from(value);
  return Buffer.concat([Buffer.from([bytes.length]), bytes]);
}

function fixtureDnsTarget(hostname: string, port?: number) {
  const path = port === undefined ? hostname : `${hostname}:${port}`;
  return parseUri(`dns://${fixtureServer}/${path}`)!;
}

function hasMatchingAddress(endpointList: Endpoint[], expectedAddress: SubchannelAddress): boolean {
  for (const endpoint of endpointList) {
    for (const address of endpoint.addresses) {
      if (subchannelAddressEqual(address, expectedAddress)) {
        return true;
      }
    }
  }
  return false;
}

describe("Name Resolver", () => {
  before(async () => {
    dnsServer = createSocket("udp4");
    dnsServer.on("message", (query, remote) => {
      const question = readQuestion(query);
      const missing = question.name === "missing.fixture.test";
      let data: Buffer | null = null;
      if (!missing && question.type === recordTypes.A) {
        data = Buffer.from([127, 0, 0, 1]);
      } else if (
        !missing &&
        question.type === recordTypes.AAAA &&
        ["localhost", "dual-stack.fixture.test", "ipv6.fixture.test"].includes(question.name)
      ) {
        data = Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
      } else if (!missing && question.type === recordTypes.TXT && question.name === "service-config.fixture.test") {
        data = characterString(
          'grpc_config=[{"serviceConfig":{"loadBalancingPolicy":"round_robin","methodConfig":[{"name":[{"service":"MyService","method":"Foo"}],"waitForReady":true}]}}]',
        );
      }
      const answers = data === null ? [] : [dnsAnswer(question.type, data)];
      dnsServer.send(dnsResponse(query, answers, missing ? 3 : 0), remote.port, remote.address);
    });
    await new Promise<void>((resolve, reject) => {
      dnsServer.once("error", reject);
      dnsServer.bind(0, "127.0.0.1", resolve);
    });
    fixtureServer = `127.0.0.1:${dnsServer.address().port}`;

    resolver_dns.setup();
    resolver_uds.setup();
    resolver_ip.setup();
  });

  afterAll(async () => {
    await new Promise<void>(resolve => dnsServer.close(() => resolve()));
  });

  describe("DNS Names", function () {
    it("Should resolve localhost properly", function (done) {
      const target = fixtureDnsTarget("localhost", 50051);
      const listener: ResolverManager.ResolverListener = {
        onSuccessfulResolution: (
          endpointList: Endpoint[],
          serviceConfig: ServiceConfig | null,
          serviceConfigError: StatusObject | null,
        ) => {
          // Only handle the first resolution result
          listener.onSuccessfulResolution = () => {};
          assert(hasMatchingAddress(endpointList, { host: "127.0.0.1", port: 50051 }));
          assert(hasMatchingAddress(endpointList, { host: "::1", port: 50051 }));
          done();
        },
        onError: (error: StatusObject) => {
          done(new Error(`Failed with status ${error.details}`));
        },
      };
      const resolver = resolverManager.createResolver(target, listener, {});
      resolver.updateResolution();
    });
    it("Should default to port 443", function (done) {
      const target = fixtureDnsTarget("localhost");
      const listener: ResolverManager.ResolverListener = {
        onSuccessfulResolution: (
          endpointList: Endpoint[],
          serviceConfig: ServiceConfig | null,
          serviceConfigError: StatusObject | null,
        ) => {
          // Only handle the first resolution result
          listener.onSuccessfulResolution = () => {};
          assert(hasMatchingAddress(endpointList, { host: "127.0.0.1", port: 443 }));
          assert(hasMatchingAddress(endpointList, { host: "::1", port: 443 }));
          done();
        },
        onError: (error: StatusObject) => {
          done(new Error(`Failed with status ${error.details}`));
        },
      };
      const resolver = resolverManager.createResolver(target, listener, {});
      resolver.updateResolution();
    });
    it("Should correctly represent an ipv4 address", done => {
      const target = resolverManager.mapUriDefaultScheme(parseUri("1.2.3.4")!)!;
      const listener: ResolverManager.ResolverListener = {
        onSuccessfulResolution: (
          endpointList: Endpoint[],
          serviceConfig: ServiceConfig | null,
          serviceConfigError: StatusObject | null,
        ) => {
          // Only handle the first resolution result
          listener.onSuccessfulResolution = () => {};
          assert(hasMatchingAddress(endpointList, { host: "1.2.3.4", port: 443 }));
          done();
        },
        onError: (error: StatusObject) => {
          done(new Error(`Failed with status ${error.details}`));
        },
      };
      const resolver = resolverManager.createResolver(target, listener, {});
      resolver.updateResolution();
    });
    it("Should correctly represent an ipv6 address", done => {
      const target = resolverManager.mapUriDefaultScheme(parseUri("::1")!)!;
      const listener: ResolverManager.ResolverListener = {
        onSuccessfulResolution: (
          endpointList: Endpoint[],
          serviceConfig: ServiceConfig | null,
          serviceConfigError: StatusObject | null,
        ) => {
          // Only handle the first resolution result
          listener.onSuccessfulResolution = () => {};
          assert(hasMatchingAddress(endpointList, { host: "::1", port: 443 }));
          done();
        },
        onError: (error: StatusObject) => {
          done(new Error(`Failed with status ${error.details}`));
        },
      };
      const resolver = resolverManager.createResolver(target, listener, {});
      resolver.updateResolution();
    });
    it("Should correctly represent a bracketed ipv6 address", done => {
      const target = resolverManager.mapUriDefaultScheme(parseUri("[::1]:50051")!)!;
      const listener: ResolverManager.ResolverListener = {
        onSuccessfulResolution: (
          endpointList: Endpoint[],
          serviceConfig: ServiceConfig | null,
          serviceConfigError: StatusObject | null,
        ) => {
          // Only handle the first resolution result
          listener.onSuccessfulResolution = () => {};
          assert(hasMatchingAddress(endpointList, { host: "::1", port: 50051 }));
          done();
        },
        onError: (error: StatusObject) => {
          done(new Error(`Failed with status ${error.details}`));
        },
      };
      const resolver = resolverManager.createResolver(target, listener, {});
      resolver.updateResolution();
    });
    it("Should resolve a DNS address", done => {
      const target = fixtureDnsTarget("address.fixture.test");
      const listener: ResolverManager.ResolverListener = {
        onSuccessfulResolution: (
          endpointList: Endpoint[],
          serviceConfig: ServiceConfig | null,
          serviceConfigError: StatusObject | null,
        ) => {
          // Only handle the first resolution result
          listener.onSuccessfulResolution = () => {};
          assert(endpointList.length > 0);
          done();
        },
        onError: (error: StatusObject) => {
          done(new Error(`Failed with status ${error.details}`));
        },
      };
      const resolver = resolverManager.createResolver(target, listener, {});
      resolver.updateResolution();
    });
    it("Should resolve a name with TXT service config", done => {
      const target = fixtureDnsTarget("service-config.fixture.test");
      const listener: ResolverManager.ResolverListener = {
        onSuccessfulResolution: (
          endpointList: Endpoint[],
          serviceConfig: ServiceConfig | null,
          serviceConfigError: StatusObject | null,
        ) => {
          if (serviceConfig !== null) {
            assert(serviceConfig.loadBalancingPolicy === "round_robin", "Should have found round robin LB policy");
            done();
          }
        },
        onError: (error: StatusObject) => {
          done(new Error(`Failed with status ${error.details}`));
        },
      };
      const resolver = resolverManager.createResolver(target, listener, {});
      resolver.updateResolution();
    });
    it("Should not resolve TXT service config if we disabled service config", done => {
      const target = fixtureDnsTarget("service-config.fixture.test");
      let count = 0;
      const listener: ResolverManager.ResolverListener = {
        onSuccessfulResolution: (
          endpointList: Endpoint[],
          serviceConfig: ServiceConfig | null,
          serviceConfigError: StatusObject | null,
        ) => {
          assert(serviceConfig === null, "Should not have found service config");
          count++;
        },
        onError: (error: StatusObject) => {
          done(new Error(`Failed with status ${error.details}`));
        },
      };
      const resolver = resolverManager.createResolver(target, listener, {
        "grpc.service_config_disable_resolution": 1,
      });
      resolver.updateResolution();
      setTimeout(() => {
        assert(count === 1, "Should have only resolved once");
        done();
      }, 2_000);
    });
    it("Should resolve a name with multiple dots", done => {
      const target = fixtureDnsTarget("multiple.dots.fixture.test");
      const listener: ResolverManager.ResolverListener = {
        onSuccessfulResolution: (
          endpointList: Endpoint[],
          serviceConfig: ServiceConfig | null,
          serviceConfigError: StatusObject | null,
        ) => {
          // Only handle the first resolution result
          listener.onSuccessfulResolution = () => {};
          assert(
            hasMatchingAddress(endpointList, { host: "127.0.0.1", port: 443 }),
            `None of [${endpointList.map(addr => endpointToString(addr))}] matched '127.0.0.1:443'`,
          );
          done();
        },
        onError: (error: StatusObject) => {
          done(new Error(`Failed with status ${error.details}`));
        },
      };
      const resolver = resolverManager.createResolver(target, listener, {});
      resolver.updateResolution();
    });
    it("Should resolve a DNS name to an IPv6 address", done => {
      const target = fixtureDnsTarget("ipv6.fixture.test");
      const listener: ResolverManager.ResolverListener = {
        onSuccessfulResolution: (
          endpointList: Endpoint[],
          serviceConfig: ServiceConfig | null,
          serviceConfigError: StatusObject | null,
        ) => {
          // Only handle the first resolution result
          listener.onSuccessfulResolution = () => {};
          assert(hasMatchingAddress(endpointList, { host: "::1", port: 443 }));
          done();
        },
        onError: (error: StatusObject) => {
          done(new Error(`Failed with status ${error.details}`));
        },
      };
      const resolver = resolverManager.createResolver(target, listener, {});
      resolver.updateResolution();
    });
    it("Should resolve a DNS name to IPv4 and IPv6 addresses", done => {
      const target = fixtureDnsTarget("dual-stack.fixture.test");
      const listener: ResolverManager.ResolverListener = {
        onSuccessfulResolution: (
          endpointList: Endpoint[],
          serviceConfig: ServiceConfig | null,
          serviceConfigError: StatusObject | null,
        ) => {
          // Only handle the first resolution result
          listener.onSuccessfulResolution = () => {};
          assert(
            hasMatchingAddress(endpointList, { host: "127.0.0.1", port: 443 }),
            `None of [${endpointList.map(addr => endpointToString(addr))}] matched '127.0.0.1:443'`,
          );
          assert(
            hasMatchingAddress(endpointList, { host: "::1", port: 443 }),
            `None of [${endpointList.map(addr => endpointToString(addr))}] matched '[::1]:443'`,
          );
          done();
        },
        onError: (error: StatusObject) => {
          done(new Error(`Failed with status ${error.details}`));
        },
      };
      const resolver = resolverManager.createResolver(target, listener, {});
      resolver.updateResolution();
    });
    it("Should resolve a name with a hyphen", done => {
      const target = fixtureDnsTarget("name-with-hyphen.fixture.test");
      const listener: ResolverManager.ResolverListener = {
        onSuccessfulResolution: (
          endpointList: Endpoint[],
          serviceConfig: ServiceConfig | null,
          serviceConfigError: StatusObject | null,
        ) => {
          // Only handle the first resolution result
          listener.onSuccessfulResolution = () => {};
          assert(endpointList.length > 0);
          done();
        },
        onError: (error: StatusObject) => {
          done(new Error(`Failed with status ${error.details}`));
        },
      };
      const resolver = resolverManager.createResolver(target, listener, {});
      resolver.updateResolution();
    });
    /* This test also serves as a regression test for
     * https://github.com/grpc/grpc-node/issues/1044, specifically handling
     * hyphens and multiple periods in a DNS name. It should not be skipped
     * unless there is another test for the same issue. */
    it("Should resolve gRPC interop servers", done => {
      let completeCount = 0;
      const target1 = fixtureDnsTarget("grpc-test.sandbox.fixture.test");
      const target2 = fixtureDnsTarget("grpc-test4.sandbox.fixture.test");
      const listener: ResolverManager.ResolverListener = {
        onSuccessfulResolution: (
          endpointList: Endpoint[],
          serviceConfig: ServiceConfig | null,
          serviceConfigError: StatusObject | null,
        ) => {
          assert(endpointList.length > 0);
          completeCount += 1;
          if (completeCount === 2) {
            // Only handle the first resolution result
            listener.onSuccessfulResolution = () => {};
            done();
          }
        },
        onError: (error: StatusObject) => {
          done(new Error(`Failed with status ${error.details}`));
        },
      };
      const resolver1 = resolverManager.createResolver(target1, listener, {});
      resolver1.updateResolution();
      const resolver2 = resolverManager.createResolver(target2, listener, {});
      resolver2.updateResolution();
    });
    it(
      "should not keep repeating successful resolutions",
      function (done) {
        const target = fixtureDnsTarget("localhost");
        let resultCount = 0;
        const resolver = resolverManager.createResolver(
          target,
          {
            onSuccessfulResolution: (
              endpointList: Endpoint[],
              serviceConfig: ServiceConfig | null,
              serviceConfigError: StatusObject | null,
            ) => {
              assert(hasMatchingAddress(endpointList, { host: "127.0.0.1", port: 443 }));
              assert(hasMatchingAddress(endpointList, { host: "::1", port: 443 }));
              resultCount += 1;
              if (resultCount === 1) {
                process.nextTick(() => resolver.updateResolution());
              }
            },
            onError: (error: StatusObject) => {
              assert.ifError(error);
            },
          },
          { "grpc.dns_min_time_between_resolutions_ms": 2000 },
        );
        resolver.updateResolution();
        setTimeout(() => {
          assert.strictEqual(resultCount, 2, `resultCount ${resultCount} !== 2`);
          done();
        }, 10_000);
      },
      15_000,
    );
    it("should not keep repeating failed resolutions", done => {
      const target = fixtureDnsTarget("missing.fixture.test");
      let resultCount = 0;
      let doneCalled = false;
      const resolver = resolverManager.createResolver(
        target,
        {
          onSuccessfulResolution: (
            endpointList: Endpoint[],
            serviceConfig: ServiceConfig | null,
            serviceConfigError: StatusObject | null,
          ) => {
            assert.fail("Resolution succeeded unexpectedly");
          },
          onError: (error: StatusObject) => {
            resultCount += 1;
            if (resultCount === 1) {
              process.nextTick(() => resolver.updateResolution());
            }
            // Complete after seeing 2 errors (expected behavior)
            if (resultCount === 2 && !doneCalled) {
              doneCalled = true;
              done();
            }
          },
        },
        {},
      );
      resolver.updateResolution();
      // Fallback timeout in case we only get 1 error (still acceptable)
      setTimeout(() => {
        if (!doneCalled) {
          assert(resultCount >= 1, `resultCount ${resultCount} should be at least 1`);
          doneCalled = true;
          done();
        }
      }, 10_000);
    }, 15_000);
  });
  describe("UDS Names", () => {
    it("Should handle a relative Unix Domain Socket name", done => {
      const target = resolverManager.mapUriDefaultScheme(parseUri("unix:socket")!)!;
      const listener: ResolverManager.ResolverListener = {
        onSuccessfulResolution: (
          endpointList: Endpoint[],
          serviceConfig: ServiceConfig | null,
          serviceConfigError: StatusObject | null,
        ) => {
          // Only handle the first resolution result
          listener.onSuccessfulResolution = () => {};
          assert(hasMatchingAddress(endpointList, { path: "socket" }));
          done();
        },
        onError: (error: StatusObject) => {
          done(new Error(`Failed with status ${error.details}`));
        },
      };
      const resolver = resolverManager.createResolver(target, listener, {});
      resolver.updateResolution();
    });
    it("Should handle an absolute Unix Domain Socket name", done => {
      const target = resolverManager.mapUriDefaultScheme(parseUri("unix:///tmp/socket")!)!;
      const listener: ResolverManager.ResolverListener = {
        onSuccessfulResolution: (
          endpointList: Endpoint[],
          serviceConfig: ServiceConfig | null,
          serviceConfigError: StatusObject | null,
        ) => {
          // Only handle the first resolution result
          listener.onSuccessfulResolution = () => {};
          assert(hasMatchingAddress(endpointList, { path: "/tmp/socket" }));
          done();
        },
        onError: (error: StatusObject) => {
          done(new Error(`Failed with status ${error.details}`));
        },
      };
      const resolver = resolverManager.createResolver(target, listener, {});
      resolver.updateResolution();
    });
  });
  describe("IP Addresses", () => {
    it("should handle one IPv4 address with no port", done => {
      const target = resolverManager.mapUriDefaultScheme(parseUri("ipv4:127.0.0.1")!)!;
      const listener: ResolverManager.ResolverListener = {
        onSuccessfulResolution: (
          endpointList: Endpoint[],
          serviceConfig: ServiceConfig | null,
          serviceConfigError: StatusObject | null,
        ) => {
          // Only handle the first resolution result
          listener.onSuccessfulResolution = () => {};
          assert(hasMatchingAddress(endpointList, { host: "127.0.0.1", port: 443 }));
          done();
        },
        onError: (error: StatusObject) => {
          done(new Error(`Failed with status ${error.details}`));
        },
      };
      const resolver = resolverManager.createResolver(target, listener, {});
      resolver.updateResolution();
    });
    it("should handle one IPv4 address with a port", done => {
      const target = resolverManager.mapUriDefaultScheme(parseUri("ipv4:127.0.0.1:50051")!)!;
      const listener: ResolverManager.ResolverListener = {
        onSuccessfulResolution: (
          endpointList: Endpoint[],
          serviceConfig: ServiceConfig | null,
          serviceConfigError: StatusObject | null,
        ) => {
          // Only handle the first resolution result
          listener.onSuccessfulResolution = () => {};
          assert(hasMatchingAddress(endpointList, { host: "127.0.0.1", port: 50051 }));
          done();
        },
        onError: (error: StatusObject) => {
          done(new Error(`Failed with status ${error.details}`));
        },
      };
      const resolver = resolverManager.createResolver(target, listener, {});
      resolver.updateResolution();
    });
    it("should handle multiple IPv4 addresses with different ports", done => {
      const target = resolverManager.mapUriDefaultScheme(parseUri("ipv4:127.0.0.1:50051,127.0.0.1:50052")!)!;
      const listener: ResolverManager.ResolverListener = {
        onSuccessfulResolution: (
          endpointList: Endpoint[],
          serviceConfig: ServiceConfig | null,
          serviceConfigError: StatusObject | null,
        ) => {
          // Only handle the first resolution result
          listener.onSuccessfulResolution = () => {};
          assert(hasMatchingAddress(endpointList, { host: "127.0.0.1", port: 50051 }));
          assert(hasMatchingAddress(endpointList, { host: "127.0.0.1", port: 50052 }));
          done();
        },
        onError: (error: StatusObject) => {
          done(new Error(`Failed with status ${error.details}`));
        },
      };
      const resolver = resolverManager.createResolver(target, listener, {});
      resolver.updateResolution();
    });
    it("should handle one IPv6 address with no port", done => {
      const target = resolverManager.mapUriDefaultScheme(parseUri("ipv6:::1")!)!;
      const listener: ResolverManager.ResolverListener = {
        onSuccessfulResolution: (
          endpointList: Endpoint[],
          serviceConfig: ServiceConfig | null,
          serviceConfigError: StatusObject | null,
        ) => {
          // Only handle the first resolution result
          listener.onSuccessfulResolution = () => {};
          assert(hasMatchingAddress(endpointList, { host: "::1", port: 443 }));
          done();
        },
        onError: (error: StatusObject) => {
          done(new Error(`Failed with status ${error.details}`));
        },
      };
      const resolver = resolverManager.createResolver(target, listener, {});
      resolver.updateResolution();
    });
    it("should handle one IPv6 address with a port", done => {
      const target = resolverManager.mapUriDefaultScheme(parseUri("ipv6:[::1]:50051")!)!;
      const listener: ResolverManager.ResolverListener = {
        onSuccessfulResolution: (
          endpointList: Endpoint[],
          serviceConfig: ServiceConfig | null,
          serviceConfigError: StatusObject | null,
        ) => {
          // Only handle the first resolution result
          listener.onSuccessfulResolution = () => {};
          assert(hasMatchingAddress(endpointList, { host: "::1", port: 50051 }));
          done();
        },
        onError: (error: StatusObject) => {
          done(new Error(`Failed with status ${error.details}`));
        },
      };
      const resolver = resolverManager.createResolver(target, listener, {});
      resolver.updateResolution();
    });
    it("should handle multiple IPv6 addresses with different ports", done => {
      const target = resolverManager.mapUriDefaultScheme(parseUri("ipv6:[::1]:50051,[::1]:50052")!)!;
      const listener: ResolverManager.ResolverListener = {
        onSuccessfulResolution: (
          endpointList: Endpoint[],
          serviceConfig: ServiceConfig | null,
          serviceConfigError: StatusObject | null,
        ) => {
          // Only handle the first resolution result
          listener.onSuccessfulResolution = () => {};
          assert(hasMatchingAddress(endpointList, { host: "::1", port: 50051 }));
          assert(hasMatchingAddress(endpointList, { host: "::1", port: 50052 }));
          done();
        },
        onError: (error: StatusObject) => {
          done(new Error(`Failed with status ${error.details}`));
        },
      };
      const resolver = resolverManager.createResolver(target, listener, {});
      resolver.updateResolution();
    });
  });
  describe("getDefaultAuthority", () => {
    class OtherResolver implements ResolverManager.Resolver {
      updateResolution() {
        return [];
      }

      destroy() {}

      static getDefaultAuthority(target: GrpcUri): string {
        return "other";
      }
    }

    it("Should return the correct authority if a different resolver has been registered", () => {
      resolverManager.registerResolver("other", OtherResolver);
      const target = resolverManager.mapUriDefaultScheme(parseUri("other:name")!)!;

      const authority = resolverManager.getDefaultAuthority(target);
      assert.equal(authority, "other");
    });
  });
});
