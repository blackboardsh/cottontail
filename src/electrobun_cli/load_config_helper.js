import * as loadedConfigModule from "./__MODULE_NAME__";

const loadedConfig = loadedConfigModule.default ?? loadedConfigModule ?? {};

const defaultConfig = {
  app: {
    name: "MyApp",
    identifier: "com.example.myapp",
    version: "0.1.0",
    description: undefined,
    urlSchemes: undefined,
    fileAssociations: undefined,
  },
  build: {
    buildFolder: "build",
    artifactFolder: "artifacts",
    mainProcess: "bun",
    main: {
      entrypoint: "src/bun/index.ts",
    },
    zig: {
      entrypoint: "src/zig/main.zig",
    },
    views: {},
    copy: {},
    watch: [],
    watchIgnore: [],
  },
  runtime: {},
  scripts: {
    preBuild: "",
    postBuild: "",
    postWrap: "",
    postPackage: "",
  },
  release: {
    baseUrl: "",
    generatePatch: true,
  },
};

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mergeConfig(base, override) {
  if (Array.isArray(base)) {
    return Array.isArray(override) ? override.slice() : base.slice();
  }

  if (!isPlainObject(base)) {
    return override === undefined ? base : override;
  }

  const result = { ...base };

  if (!isPlainObject(override)) {
    return override === undefined ? result : override;
  }

  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) {
      continue;
    }

    const existing = result[key];

    if (Array.isArray(value)) {
      result[key] = value.slice();
      continue;
    }

    if (isPlainObject(value) && isPlainObject(existing)) {
      result[key] = mergeConfig(existing, value);
      continue;
    }

    result[key] = value;
  }

  return result;
}

const merged = mergeConfig(defaultConfig, loadedConfig);

if (!merged.build.main && merged.build.bun) {
  merged.build.main = { ...merged.build.bun };
}

if (!merged.build.bun && merged.build.main) {
  merged.build.bun = { ...merged.build.main };
}

console.log(JSON.stringify(merged));
