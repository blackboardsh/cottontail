import { describe, expect, test } from "bun:test";
import { tempDirWithFiles } from "harness";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { itBundled } from "./expectBundled";

const etagPattern = /^[A-Za-z0-9_-]{11}$/;

function normalizeGeneratedETags(manifest: any) {
  return {
    ...manifest,
    files: manifest.files.map((file: any) => {
      expect(file.headers.etag).toMatch(etagPattern);
      return file.loader === "file"
        ? file
        : { ...file, headers: { ...file.headers, etag: "<generated-etag>" } };
    }),
  };
}

describe.concurrent("bundler", () => {
  // Test HTML import manifest with enhanced metadata
  itBundled("html-import/manifest-with-metadata", {
    outdir: "out/",
    files: {
      "/server.js": `
import html from "./client.html";

if (!html.files.find(a => a.path === html.index)) {
  throw new Error("Bad file");
}

console.log(JSON.stringify(html, null, 2));

`,
      "/client.html": `
<!DOCTYPE html>
<html>
  <head>
    <link rel="stylesheet" href="./styles.css">
    <script src="./client.js"></script>
  </head>
  <body>
    <h1>Client HTML</h1>
  </body>
</html>`,
      "/styles.css": `
body {
  background-color: #f0f0f0;
  margin: 0;
  padding: 20px;
}
h1 {
  color: #333;
}`,
      "/client.js": `
import favicon from './favicon.png';
console.log("Client script loaded");
window.addEventListener('DOMContentLoaded', () => {
  console.log('DOM ready');
});
console.log(favicon);
`,
      "/favicon.png": Buffer.from([
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a, // PNG header
        0x00,
        0x00,
        0x00,
        0x0d,
        0x49,
        0x48,
        0x44,
        0x52, // IHDR chunk
        0x00,
        0x00,
        0x00,
        0x10,
        0x00,
        0x00,
        0x00,
        0x10, // 16x16
        0x08,
        0x02,
        0x00,
        0x00,
        0x00,
        0x90,
        0x91,
        0x68, // 8-bit RGB
        0x36,
        0x00,
        0x00,
        0x00,
        0x00,
        0x49,
        0x45,
        0x4e, // IEND chunk
        0x44,
        0xae,
        0x42,
        0x60,
        0x82,
      ]),
    },
    entryPoints: ["/server.js"],
    target: "bun",

    run: {
      validate({ stdout }) {
        const manifest = normalizeGeneratedETags(JSON.parse(stdout));
        expect(JSON.stringify(manifest, null, 2) + "\n").toMatchInlineSnapshot(`
          "{
            "index": "./client.html",
            "files": [
              {
                "input": "client.html",
                "path": "./client-b5m4ng86.js",
                "loader": "js",
                "isEntry": true,
                "headers": {
                  "etag": "<generated-etag>",
                  "content-type": "text/javascript;charset=utf-8"
                }
              },
              {
                "input": "client.html",
                "path": "./client.html",
                "loader": "html",
                "isEntry": true,
                "headers": {
                  "etag": "<generated-etag>",
                  "content-type": "text/html;charset=utf-8"
                }
              },
              {
                "input": "client.html",
                "path": "./client-0z58sk45.css",
                "loader": "css",
                "isEntry": true,
                "headers": {
                  "etag": "<generated-etag>",
                  "content-type": "text/css;charset=utf-8"
                }
              },
              {
                "input": "favicon.png",
                "path": "./favicon-wjepk3hq.png",
                "loader": "file",
                "isEntry": false,
                "headers": {
                  "etag": "fFLOVvPDEZc",
                  "content-type": "image/png"
                }
              }
            ]
          }
          "
        `);
      },
    },
  });

  // Test manifest with multiple HTML imports
  itBundled("html-import/multiple-manifests", {
    outdir: "out/",
    backend: "cli",
    files: {
      "/server.js": `
import homeHtml from "./home.html";
import aboutHtml from "./about.html";
console.log("Home manifest:", homeHtml);
console.log("About manifest:", aboutHtml);
`,
      "/home.html": `
<!DOCTYPE html>
<html>
  <head>
    <link rel="stylesheet" href="./home.css">
    <script src="./home.js"></script>
  </head>
  <body>
    <h1>Home Page</h1>
  </body>
</html>`,
      "/about.html": `
<!DOCTYPE html>
<html>
  <head>
    <link rel="stylesheet" href="./about.css">
    <script src="./about.js"></script>
  </head>
  <body>
    <h1>About Page</h1>
  </body>
</html>`,
      "/home.css": "body { background: #fff; }",
      "/home.js": "console.log('Home page');",
      "/about.css": "body { background: #f0f0f0; }",
      "/about.js": "console.log('About page');",
    },
    entryPoints: ["/server.js"],
    target: "bun",

    onAfterBundle(api) {
      const serverCode = api.readFile("out/server.js");

      // The manifests are embedded as escaped JSON strings in __jsonParse calls
      const manifestMatches = [...serverCode.matchAll(/__jsonParse\("(.+?)"\)/gs)];
      expect(manifestMatches.length).toBe(2);
      let manifests = [];
      for (const match of manifestMatches) {
        // The captured group contains the escaped JSON string
        const escapedJson = match[1];
        // Parse the escaped JSON string
        const manifest = JSON.parse(JSON.parse('"' + escapedJson + '"'));
        manifests.push(manifest);
        expect(manifest.index).toBeDefined();
        expect(manifest.files).toBeDefined();
        expect(Array.isArray(manifest.files)).toBe(true);

        // Each manifest should have HTML, JS, and CSS
        const loaders = manifest.files.map((f: any) => f.loader);
        expect(loaders).toContain("html");
        expect(loaders).toContain("js");
        expect(loaders).toContain("css");

        // All files should have enhanced metadata
        for (const file of manifest.files) {
          expect(file).toHaveProperty("headers");
          expect(file).toHaveProperty("isEntry");
          expect(file.headers).toHaveProperty("etag");
          expect(file.headers).toHaveProperty("content-type");
        }
      }

      expect(manifests.map(manifest => normalizeGeneratedETags(manifest))).toMatchInlineSnapshot(`
        [
          {
            "files": [
              {
                "headers": {
                  "content-type": "text/javascript;charset=utf-8",
                  "etag": "<generated-etag>",
                },
                "input": "home.html",
                "isEntry": true,
                "loader": "js",
                "path": "./home-5f8tg1jd.js",
              },
              {
                "headers": {
                  "content-type": "text/html;charset=utf-8",
                  "etag": "<generated-etag>",
                },
                "input": "home.html",
                "isEntry": true,
                "loader": "html",
                "path": "./home.html",
              },
              {
                "headers": {
                  "content-type": "text/css;charset=utf-8",
                  "etag": "<generated-etag>",
                },
                "input": "home.html",
                "isEntry": true,
                "loader": "css",
                "path": "./home-5pdcqqze.css",
              },
            ],
            "index": "./home.html",
          },
          {
            "files": [
              {
                "headers": {
                  "content-type": "text/javascript;charset=utf-8",
                  "etag": "<generated-etag>",
                },
                "input": "about.html",
                "isEntry": true,
                "loader": "js",
                "path": "./about-e59abjgr.js",
              },
              {
                "headers": {
                  "content-type": "text/html;charset=utf-8",
                  "etag": "<generated-etag>",
                },
                "input": "about.html",
                "isEntry": true,
                "loader": "html",
                "path": "./about.html",
              },
              {
                "headers": {
                  "content-type": "text/css;charset=utf-8",
                  "etag": "<generated-etag>",
                },
                "input": "about.html",
                "isEntry": true,
                "loader": "css",
                "path": "./about-7apjgk42.css",
              },
            ],
            "index": "./about.html",
          },
        ]
      `);
    },
  });

  test("html-import/etag-changes-with-referenced-chunks", async () => {
    const dir = tempDirWithFiles("html-etag", {
      "server.ts": `import manifest from "./index.html"; console.log(JSON.stringify(manifest));`,
      "index.html": `<!doctype html><script type="module" src="./app.ts"></script>`,
      "app.ts": `console.log(1);`,
    });

    async function buildAndReadManifest() {
      const outdir = join(dir, "out");
      const result = await Bun.build({ entrypoints: [join(dir, "server.ts")], outdir, target: "bun" });
      expect(result.success).toBe(true);
      const server = readFileSync(join(outdir, "server.js"), "utf8");
      const match = server.match(/__jsonParse\("(.+?)"\)/s)!;
      return JSON.parse(JSON.parse('"' + match[1] + '"')) as {
        files: Array<{ loader: string; path: string; headers: { etag: string } }>;
      };
    }

    const before = await buildAndReadManifest();
    const unchanged = await buildAndReadManifest();
    const file = (manifest: typeof before, loader: string) => manifest.files.find(item => item.loader === loader)!;

    for (const loader of ["js", "html"]) {
      expect(file(before, loader).path).toBe(file(unchanged, loader).path);
      expect(file(before, loader).headers.etag).toBe(file(unchanged, loader).headers.etag);
      expect(file(before, loader).headers.etag).toMatch(etagPattern);
    }

    writeFileSync(join(dir, "app.ts"), `console.log(2);`);
    const after = await buildAndReadManifest();

    expect(file(before, "js").path).not.toBe(file(after, "js").path);
    expect(file(before, "html").path).toBe(file(after, "html").path);
    expect(file(before, "html").headers.etag).not.toBe(file(after, "html").headers.etag);
  });

  // Test that import with {type: 'file'} still works as a file import
  itBundled("html-import/with-type-file-attribute", {
    outdir: "out/",
    backend: "cli",
    files: {
      "/entry.js": `
import htmlUrl from "./page.html" with { type: 'file' };
import htmlManifest from "./index.html";

// Test that htmlUrl is a string (file path)
if (typeof htmlUrl !== 'string') {
  throw new Error("Expected htmlUrl to be a string, got " + typeof htmlUrl);
}

// Test that htmlManifest is an object with expected properties
if (typeof htmlManifest !== 'object' || !htmlManifest.index || !Array.isArray(htmlManifest.files)) {
  throw new Error("Expected htmlManifest to be an object with index and files array");
}

console.log("✓ File import returned URL:", htmlUrl);
console.log("✓ HTML import returned manifest with", htmlManifest.files.length, "files");
console.log("✓ Both import types work correctly");
`,
      "/page.html": `
<!DOCTYPE html>
<html>
  <head>
    <title>Page imported as file</title>
  </head>
  <body>
    <h1>This HTML is imported with type: 'file'</h1>
  </body>
</html>`,
      "/index.html": `
<!DOCTYPE html>
<html>
  <head>
    <link rel="stylesheet" href="./styles.css">
  </head>
  <body>
    <h1>Test Page</h1>
  </body>
</html>`,
      "/styles.css": `body { background: #fff; }`,
    },
    entryPoints: ["/entry.js"],
    target: "bun",

    run: {
      validate({ stdout }) {
        expect(stdout).toContain("✓ File import returned URL:");
        expect(stdout).toContain("✓ HTML import returned manifest with");
        expect(stdout).toContain("✓ Both import types work correctly");
      },
    },

    onAfterBundle(api) {
      // Check that the generated code correctly handles both import types
      const entryCode = api.readFile("out/entry.js");

      // Should have a file import for page.html
      expect(entryCode).toContain('var page_default = "./page-');
      expect(entryCode).toContain('.html";');

      // Should have a manifest import for index.html
      expect(entryCode).toContain('__jsonParse("');
      expect(entryCode).toContain('\\\"index\\\":\\\"./index.html\\\"');
      expect(entryCode).toContain('\\\"files\\\":[');
    },
  });
});
