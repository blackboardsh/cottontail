import { expect, test } from "bun:test";
import { frameworkRouterInternals } from "bun:internal-for-testing";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const { FrameworkRouter, parseRoutePattern, orderResolverEntries } = frameworkRouterInternals;

test("Bake route styles preserve Bun's parser contract", () => {
  expect(parseRoutePattern("nextjs-app-routes", "/api/[id]/route.ts")).toEqual({
    kind: "page",
    pattern: "/api/:id",
  });
  expect(parseRoutePattern("nextjs-app-ui", "/(marketing)/page.tsx")).toEqual({
    kind: "page",
    pattern: "/(marketing)",
  });
  expect(() => parseRoutePattern("nextjs-pages", "/docs/[...slug]/other.tsx")).toThrow(
    "Catch-all parameter must be at the end of a route",
  );
});

test("FrameworkRouter matches static, parameter, and optional catch-all routes", () => {
  const root = mkdtempSync(path.join(tmpdir(), "cottontail-bake-router-"));
  try {
    mkdirSync(path.join(root, "[user]"), { recursive: true });
    mkdirSync(path.join(root, "docs"), { recursive: true });
    mkdirSync(path.join(root, "node_modules", "ignored"), { recursive: true });
    writeFileSync(path.join(root, "about.tsx"), "export default 1");
    writeFileSync(path.join(root, "[user]", "posts.tsx"), "export default 1");
    writeFileSync(path.join(root, "docs", "[[...slug]].tsx"), "export default 1");
    writeFileSync(path.join(root, "node_modules", "ignored", "page.tsx"), "export default 1");

    const router = new FrameworkRouter({ root, style: "nextjs-pages" });

    const staticMatch = router.match("/about");
    expect(staticMatch?.params).toBeNull();
    expect(staticMatch?.route.page).toBe(path.join(root, "about.tsx"));

    const parameterMatch = router.match("/alice/posts");
    expect(parameterMatch?.params).toEqual({ user: "alice" });
    expect(parameterMatch?.route.page).toBe(path.join(root, "[user]", "posts.tsx"));

    const optionalMatch = router.match("/docs");
    expect(optionalMatch?.params).toBeNull();
    expect(optionalMatch?.route.page).toBe(path.join(root, "docs", "[[...slug]].tsx"));

    const catchAllMatch = router.match("/docs/guides/runtime");
    expect(catchAllMatch?.params).toEqual({ slug: ["guides", "runtime"] });
    expect(catchAllMatch?.route.page).toBe(path.join(root, "docs", "[[...slug]].tsx"));
    expect(router.match("/node_modules/ignored/page")).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("FrameworkRouter preserves Bun's filesystem route-tree order", () => {
  const directoryEntries = [
    { name: "hello.tsx" },
    { name: "meow" },
    { name: "[world].tsx" },
  ];
  for (const entries of [directoryEntries, directoryEntries.toReversed(), [directoryEntries[1], directoryEntries[2], directoryEntries[0]]]) {
    expect(orderResolverEntries(entries).map(entry => entry.name)).toEqual([
      "[world].tsx",
      "meow",
      "hello.tsx",
    ]);
  }
  expect(orderResolverEntries([{ name: "Route.tsx", marker: 1 }, { name: "route.tsx", marker: 2 }])).toEqual([
    { name: "route.tsx", marker: 2 },
  ]);
  expect(orderResolverEntries(Array.from({ length: 10 }, (_, index) => ({ name: `route-${index}` }))).map(entry => entry.name)).toEqual([
    "route-4",
    "route-8",
    "route-9",
    "route-6",
    "route-7",
    "route-0",
    "route-1",
    "route-3",
    "route-5",
    "route-2",
  ]);

  const root = mkdtempSync(path.join(tmpdir(), "cottontail-bake-router-order-"));
  try {
    writeFileSync(path.join(root, "hello.tsx"), "export default 1");
    mkdirSync(path.join(root, "meow", "bark", "[param]"), { recursive: true });
    writeFileSync(path.join(root, "meow", "_layout.tsx"), "export default 1");
    writeFileSync(path.join(root, "meow", "bark", "[param]", "hello.tsx"), "export default 1");
    writeFileSync(path.join(root, "[world].tsx"), "export default 1");

    const router = new FrameworkRouter({ root, style: "nextjs-pages" });
    expect(router.toJSON().children.map(child => child.part)).toEqual(["/:world", "/meow", "/hello"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
