import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

test("standalone autoload flags control runtime config and resolver metadata", async () => {
  const runtime = globalThis as typeof globalThis & {
    __cottontailImportModule: (specifier: string, referrer: string) => Promise<Record<string, unknown>>;
    __cottontailLoadDotenv: () => void;
    __cottontailLoadStandaloneBunfig: () => Promise<void>;
    __cottontailLoadStandaloneExecPreloads: () => Promise<void>;
    __cottontailStandaloneBunfigLoaded?: boolean;
    __cottontailStandaloneExecPreloadsLoaded?: boolean;
    __cottontailStandaloneFlags?: Record<string, boolean>;
    __cottontailDotenvLoaded?: boolean;
    __standalonePreload?: string[];
  };
  const root = mkdtempSync(join(tmpdir(), "cottontail-standalone-autoload-"));
  const identity = basename(root).replaceAll("-", "_");
  const tsconfigSpecifier = `@ct_${identity}/helper`;
  const packageName = `ct-${identity}`;
  const referrer = join(root, "entry.js");
  const originalCwd = process.cwd();
  const originalExecArgv = process.execArgv;
  const originalFlags = runtime.__cottontailStandaloneFlags;
  const originalDotenvLoaded = runtime.__cottontailDotenvLoaded;
  const originalDefaultEnv = process.env.CT_STANDALONE_DEFAULT_ENV;
  const originalExplicitEnv = process.env.CT_STANDALONE_EXPLICIT_ENV;

  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        baseUrl: ".",
        paths: { [`@ct_${identity}/*`]: ["src/*"] },
      },
    }));
    writeFileSync(join(root, "src", "helper.ts"), "export default 'from-tsconfig';\n");

    const packageRoot = join(root, "node_modules", packageName);
    mkdirSync(join(packageRoot, "lib"), { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
      name: packageName,
      exports: { "./utils": "./lib/utilities.js" },
    }));
    writeFileSync(join(packageRoot, "lib", "utilities.js"), "export default 'from-package-exports';\n");

    runtime.__cottontailStandaloneFlags = {
      disableAutoloadTsconfig: true,
      disableAutoloadPackageJson: true,
      disableAutoloadBunfig: true,
    };
    let tsconfigRejected = false;
    let packageJsonRejected = false;
    try {
      await runtime.__cottontailImportModule(tsconfigSpecifier, referrer);
    } catch {
      tsconfigRejected = true;
    }
    try {
      await runtime.__cottontailImportModule(`${packageName}/utils`, referrer);
    } catch {
      packageJsonRejected = true;
    }
    expect(tsconfigRejected).toBe(true);
    expect(packageJsonRejected).toBe(true);

    runtime.__cottontailStandaloneFlags.disableAutoloadTsconfig = false;
    runtime.__cottontailStandaloneFlags.disableAutoloadPackageJson = false;
    expect((await runtime.__cottontailImportModule(tsconfigSpecifier, referrer)).default).toBe("from-tsconfig");
    expect((await runtime.__cottontailImportModule(`${packageName}/utils`, referrer)).default).toBe("from-package-exports");

    writeFileSync(join(root, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
    writeFileSync(join(root, "preload.ts"), "globalThis.__standalonePreload = [...(globalThis.__standalonePreload ?? []), 'default'];\n");
    writeFileSync(join(root, "custom.toml"), 'preload = ["./custom-preload.ts"]\n');
    writeFileSync(join(root, "custom-preload.ts"), "globalThis.__standalonePreload = [...(globalThis.__standalonePreload ?? []), 'explicit'];\n");
    process.chdir(root);
    process.execArgv = [];
    runtime.__standalonePreload = [];
    runtime.__cottontailStandaloneFlags.disableAutoloadBunfig = true;
    await runtime.__cottontailLoadStandaloneBunfig();
    expect(runtime.__standalonePreload).toEqual([]);

    runtime.__cottontailStandaloneFlags.disableAutoloadBunfig = false;
    await runtime.__cottontailLoadStandaloneBunfig();
    expect(runtime.__standalonePreload).toEqual(["default"]);

    delete runtime.__cottontailStandaloneBunfigLoaded;
    runtime.__cottontailStandaloneFlags.disableAutoloadBunfig = true;
    process.execArgv = ["--config", "custom.toml"];
    await runtime.__cottontailLoadStandaloneBunfig();
    expect(runtime.__standalonePreload).toEqual(["default", "explicit"]);

    writeFileSync(join(root, "exec-preload.ts"), "globalThis.__standalonePreload = [...(globalThis.__standalonePreload ?? []), 'exec'];\n");
    process.execArgv = ["--import", "./exec-preload.ts"];
    await runtime.__cottontailLoadStandaloneExecPreloads();
    expect(runtime.__standalonePreload).toEqual(["default", "explicit", "exec"]);

    writeFileSync(join(root, ".env"), "CT_STANDALONE_DEFAULT_ENV=default\n");
    writeFileSync(join(root, "explicit.env"), "CT_STANDALONE_EXPLICIT_ENV=explicit\n");
    runtime.__cottontailStandaloneFlags.disableDefaultEnvFiles = true;
    runtime.__cottontailStandaloneFlags.disableAutoloadBunfig = true;
    process.execArgv = ["--env-file", "./explicit.env"];
    delete runtime.__cottontailDotenvLoaded;
    delete process.env.CT_STANDALONE_DEFAULT_ENV;
    delete process.env.CT_STANDALONE_EXPLICIT_ENV;
    runtime.__cottontailLoadDotenv();
    expect(process.env.CT_STANDALONE_DEFAULT_ENV).toBeUndefined();
    expect(process.env.CT_STANDALONE_EXPLICIT_ENV).toBe("explicit");
  } finally {
    process.chdir(originalCwd);
    process.execArgv = originalExecArgv;
    if (originalFlags === undefined) delete runtime.__cottontailStandaloneFlags;
    else runtime.__cottontailStandaloneFlags = originalFlags;
    delete runtime.__cottontailStandaloneBunfigLoaded;
    delete runtime.__cottontailStandaloneExecPreloadsLoaded;
    if (originalDotenvLoaded === undefined) delete runtime.__cottontailDotenvLoaded;
    else runtime.__cottontailDotenvLoaded = originalDotenvLoaded;
    if (originalDefaultEnv === undefined) delete process.env.CT_STANDALONE_DEFAULT_ENV;
    else process.env.CT_STANDALONE_DEFAULT_ENV = originalDefaultEnv;
    if (originalExplicitEnv === undefined) delete process.env.CT_STANDALONE_EXPLICIT_ENV;
    else process.env.CT_STANDALONE_EXPLICIT_ENV = originalExplicitEnv;
    delete runtime.__standalonePreload;
    rmSync(root, { recursive: true, force: true });
  }
});
