export function createBunBuildFacade(dependencies) {
  const {
    Transpiler,
    cottontail,
    file,
    hash,
    nodeIsBuiltin,
    nodePathBasename,
    nodePathIsAbsolute,
    nodePathRelative,
    nodePathResolve,
    pathDirname,
    pathJoin,
    resolveSync,
    tmpRoot,
  } = dependencies;

  class BuildMessage {
    constructor({ name = "BuildMessage", message = "", level = "error", position = null, notes = [], rendered = null } = {}) {
      this.name = name;
      this.message = String(message);
      this.level = level;
      this.position = position;
      this.notes = Array.isArray(notes) ? notes : [];
      Object.defineProperty(this, "rendered", { value: rendered, enumerable: false, configurable: true, writable: true });
    }
    toString() {
      return `${this.name}: ${this.message}`;
    }
    [Symbol.for("nodejs.util.inspect.custom")]() {
      return this.rendered ?? `${this.level ?? "error"}: ${this.message}`;
    }
  }

  function runBuildDriver(spec) {
    const processCwd = globalThis.process?.cwd?.() ?? cottontail.cwd();
    const cwd = spec.__cottontailWorkingDirectory != null
      ? nodePathResolve(processCwd, String(spec.__cottontailWorkingDirectory))
      : processCwd;
    const toAbsolute = (value) => (
      value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) ? value : nodePathResolve(cwd, value)
    );
    // A path-like entrypoint is anchored to the filesystem (absolute, or an
    // explicit "./"/"../" relative path). Bare specifiers (e.g. "pkg",
    // "@scope/pkg") are package entry points that the native resolver must
    // look up in node_modules — applying the "exports"/"module"/"main" fields
    // — so they are passed through unchanged rather than force-joined to cwd.
    const isPathLike = (value) =>
      value.startsWith("/") ||
      value.startsWith("./") ||
      value.startsWith("../") ||
      value.startsWith(".\\") ||
      value.startsWith("..\\") ||
      value === "." ||
      value === ".." ||
      /^[A-Za-z]:[\\/]/.test(value);
    try {
      const entrypoints = [];
      const virtualFiles = spec.files && typeof spec.files === "object" ? spec.files : null;
      for (const entrypoint of spec.entrypoints ?? []) {
        const entry = String(entrypoint);
        const absoluteEntry = toAbsolute(entry);
        // Resolve to a concrete file when the entry exists on disk (or in the
        // virtual file map). Otherwise, defer bare package specifiers to the
        // native resolver (node_modules lookup); only reject path-like entries
        // that point at a non-existent file.
        if (Object.prototype.hasOwnProperty.call(virtualFiles ?? {}, absoluteEntry) || cottontail.existsSync(absoluteEntry)) {
          entrypoints.push(absoluteEntry);
        } else if (isPathLike(entry)) {
          return {
            ok: false,
            name: "AggregateError",
            message: "Bundle failed",
            logs: [{
              name: "BuildMessage",
              level: "error",
              message: `ModuleNotFound resolving "${entry}" (entry point)`,
              position: null,
            }],
          };
        } else {
          entrypoints.push(entry);
        }
      }
      const request = { ...spec, plugins: undefined, __cottontailWorkingDirectory: undefined, entrypoints };
      const parsed = JSON.parse(cottontail.buildNative(JSON.stringify(request), cwd));
      const metafile = parsed.metafile == null ? null : JSON.parse(parsed.metafile);
      const outdir = spec.outdir != null ? toAbsolute(String(spec.outdir)) : null;
      const writeMetafile = (path, contents) => {
        if (path == null || contents == null) return;
        const value = String(path);
        const absolute = value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)
          ? value
          : nodePathResolve(outdir ?? cwd, value);
        const parent = pathDirname(absolute);
        if (parent && parent !== ".") cottontail.mkdirSync(parent, true);
        cottontail.writeFile(absolute, contents);
      };
      if (typeof spec.metafile === "string") {
        writeMetafile(spec.metafile, parsed.metafile);
      } else if (spec.metafile && typeof spec.metafile === "object") {
        writeMetafile(spec.metafile.json, parsed.metafile);
        writeMetafile(spec.metafile.markdown, parsed.metafileMarkdown);
      }
      // Real Bun writes output files whenever `outdir` is set (the `write`
      // option does not suppress it); in-memory builds have no outdir.
      for (const output of parsed.outputs ?? []) {
        const relative = String(output.path ?? "").replace(/^\.\//, "");
        if (outdir) {
          const absolute = nodePathResolve(outdir, relative);
          if (output.kind === "sourcemap") {
            const sourceMap = JSON.parse(globalThis.Buffer.from(output.b64 ?? "", "base64").toString("utf8"));
            if (Array.isArray(sourceMap.sources)) {
              const mapDirectory = pathDirname(absolute);
              sourceMap.sources = sourceMap.sources.map((source) => {
                source = String(source);
                if (!nodePathIsAbsolute(source) && /^[A-Za-z][A-Za-z0-9+.-]*:/.test(source)) return source;
                return nodePathRelative(mapDirectory, nodePathResolve(cwd, source));
              });
              output.b64 = globalThis.Buffer.from(JSON.stringify(sourceMap)).toString("base64");
            }
          }
          const parent = pathDirname(absolute);
          if (parent && parent !== ".") cottontail.mkdirSync(parent, true);
          cottontail.writeFile(absolute, globalThis.Buffer.from(output.b64 ?? "", "base64"));
          output.path = absolute;
        } else {
          output.path = `./${relative}`;
        }
      }
      if (parsed.success === false) {
        return {
          ok: false,
          name: "AggregateError",
          message: "Bundle failed",
          logs: parsed.logs ?? [],
        };
      }
      return { ok: true, success: true, logs: parsed.logs ?? [], outputs: parsed.outputs ?? [], metafile };
    } catch (error) {
      return {
        ok: false,
        name: error?.name ?? "AggregateError",
        message: error?.message ?? "Bundle failed",
        logs: [{
          name: error?.name ?? "BuildMessage",
          level: "error",
          message: error?.message ?? String(error),
          position: error?.position ?? null,
          rendered: error?.stack ?? String(error),
        }],
      };
    }
  }

  function finalizeDriverResult(parsed, options) {
    const logs = (parsed.logs || []).map((entry) => new BuildMessage(entry));
    if (parsed.ok === false) {
      if (options?.throw === false) return { success: false, logs, outputs: [] };
      const errors = logs.filter((log) => (log?.level ?? "error") === "error");
      const error = new AggregateError(errors.length > 0 ? errors : logs, parsed.message || "Bundle failed");
      if (parsed.name) error.name = parsed.name;
      throw error;
    }
    return {
      success: parsed.success !== false,
      logs,
      outputs: (parsed.outputs || []).map((output) => new CTBuildArtifact(
        globalThis.Buffer.from(output.b64 ?? "", "base64"),
        {
          path: output.path,
          kind: output.kind ?? "entry-point",
          hash: output.hash ?? null,
          loader: output.loader ?? "js",
        },
      )),
      ...(parsed.metafile != null ? { metafile: parsed.metafile } : {}),
    };
  }

  async function finalizePluginDriverResult(parsed, options, onEndCallbacks) {
    const result = finalizeDriverResult(parsed, { ...options, throw: false });
    await ctRunOnEnd({ onEnd: onEndCallbacks }, result);
    if (!result.success && options?.throw !== false) {
      const errors = result.logs.filter((log) => (log?.level ?? "error") === "error");
      const error = new AggregateError(errors.length > 0 ? errors : result.logs, parsed.message || "Bundle failed");
      if (parsed.name) error.name = parsed.name;
      throw error;
    }
    return result;
  }

  const bundleLoaderExtensions = {
    js: ".js",
    jsx: ".jsx",
    ts: ".ts",
    tsx: ".tsx",
    css: ".css",
    html: ".html",
    json: ".json",
    jsonc: ".jsonc",
    json5: ".json5",
    yaml: ".yaml",
    toml: ".toml",
    text: ".txt",
    wasm: ".wasm",
    napi: ".node",
    base64: ".base64",
    dataurl: ".dataurl",
    bunsh: ".bun.sh",
    sqlite: ".sqlite",
    sqlite_embedded: ".sqlite-embedded",
    md: ".md",
  };

  // Keep this table in lockstep with Bun's public native bundler plugin ABI.
  const nativePluginLoaderNames = [
    "jsx", "js", "ts", "tsx", "css", "file", "json", "jsonc", "toml", "wasm",
    "napi", "base64", "dataurl", "text", "bunsh", "sqlite", "sqlite_embedded",
    "html", "yaml", "json5", "md",
  ];
  const nativePluginLoaderIds = Object.fromEntries(
    nativePluginLoaderNames.map((loader, id) => [loader, id]),
  );
  const nativePluginLogLevels = ["verbose", "debug", "info", "warning", "error"];

  function ctBuildContentsText(contents) {
    if (typeof contents === "string") return contents;
    if (contents instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(contents));
    if (ArrayBuffer.isView(contents)) {
      return new TextDecoder().decode(new Uint8Array(contents.buffer, contents.byteOffset, contents.byteLength));
    }
    return String(contents);
  }

  function ctNativePluginFilterMatches(filter, value) {
    const lastIndex = filter.lastIndex;
    filter.lastIndex = 0;
    try {
      return filter.test(value);
    } finally {
      filter.lastIndex = lastIndex;
    }
  }

  function ctValidatePluginConstraints(constraints) {
    if (!constraints || typeof constraints !== "object") {
      throw new TypeError('Expected an object with "filter" RegExp');
    }
    let { filter, namespace = "file" } = constraints;
    if (!filter) throw new TypeError('Expected an object with "filter" RegExp');
    if (!(filter instanceof RegExp)) throw new TypeError("filter must be a RegExp");
    if (namespace && typeof namespace !== "string") throw new TypeError("namespace must be a string");
    if ((namespace?.length ?? 0) === 0) namespace = "file";
    if (!/^([/$a-zA-Z0-9_-]+)$/.test(namespace)) {
      throw new TypeError("namespace can only contain $a-zA-Z0-9_\\-");
    }
    return { filter, namespace };
  }

  function ctPluginInvalidArgument(message) {
    const error = new TypeError(message);
    error.code = "ERR_INVALID_ARG_TYPE";
    error.name = "TypeError [ERR_INVALID_ARG_TYPE]";
    return error;
  }

  async function ctNormalizeBuildFiles(options, preserveBinary = false) {
    if (options?.files == null || typeof options.files !== "object") return options;
    const cwd = globalThis.process?.cwd?.() ?? cottontail.cwd();
    const files = {};
    for (const [path, value] of Object.entries(options.files)) {
      const absolute = String(path).startsWith("/") || /^[A-Za-z]:[\\/]/.test(String(path))
        ? String(path)
        : nodePathResolve(cwd, String(path));
      if (typeof value === "string") {
        files[absolute] = value;
      } else if (value instanceof ArrayBuffer) {
        files[absolute] = preserveBinary ? value : ctBuildContentsText(value);
      } else if (ArrayBuffer.isView(value)) {
        const view = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        files[absolute] = preserveBinary ? view : ctBuildContentsText(view);
      } else if (preserveBinary && typeof value?.arrayBuffer === "function") {
        const buffer = await value.arrayBuffer();
        files[absolute] = buffer;
      } else if (typeof value?.text === "function") {
        files[absolute] = String(await value.text());
      } else if (typeof value?.arrayBuffer === "function") {
        files[absolute] = ctBuildContentsText(await value.arrayBuffer());
      } else {
        throw new TypeError(`Bun.build files[${JSON.stringify(path)}] must be a string, Blob, ArrayBuffer, or typed array`);
      }
    }
    return { ...options, files };
  }

  function ctBuildVirtualFile(options, path) {
    if (options?.files == null) return undefined;
    return Object.prototype.hasOwnProperty.call(options.files, path) ? options.files[path] : undefined;
  }

  function bundleLoaderForPath(path) {
    const match = /\.([a-zA-Z0-9]+)$/.exec(String(path));
    switch ((match?.[1] ?? "").toLowerCase()) {
      case "js": case "mjs": case "cjs": return "js";
      case "ts": case "mts": case "cts": return "ts";
      case "tsx": return "tsx";
      case "jsx": return "jsx";
      case "css": return "css";
      case "html": case "htm": return "html";
      case "json": return "json";
      case "toml": return "toml";
      case "yaml": case "yml": return "yaml";
      case "txt": return "text";
      case "wasm": return "wasm";
      default: return "file";
    }
  }

  function scanBundleImportsForLoader(source, loader) {
    if (loader === "html" || loader === "js" || loader === "jsx" || loader === "ts" || loader === "tsx") {
      try {
        return JSON.parse(cottontail.transpilerScanImports(String(source), "{}", loader))
          .map(({ path, kind }) => ({ specifier: path, kind }));
      } catch {
        // The delegated native build reports parser errors with full locations.
        return [];
      }
    }
    if (loader === "css") {
      const found = new Map();
      const push = (specifier, kind) => {
        const value = String(specifier ?? "").trim();
        if (!value || value.startsWith("#") || /^(?:data|https?):/i.test(value) || found.has(value)) return;
        found.set(value, kind);
      };
      const text = String(source).replace(/\/\*[\s\S]*?\*\//g, "");
      for (const match of text.matchAll(/@import\s+(?:url\(\s*)?["']([^"']+)["']/gi)) push(match[1], "import-rule");
      for (const match of text.matchAll(/url\(\s*(?:["']([^"']+)["']|([^\s)'\"]+))\s*\)/gi)) {
        push(match[1] ?? match[2], "url-token");
      }
      return [...found].map(([specifier, kind]) => ({ specifier, kind }));
    }
    return [];
  }

  function ctBuildPluginInitialOptions(options) {
    const minify = options?.minify;
    const minifyOptions = minify && typeof minify === "object" ? minify : null;
    const minifyIdentifiers = minifyOptions?.identifiers === true ? true : undefined;
    const minifySyntax = minifyOptions?.syntax === true ? true : undefined;
    const minifyWhitespace = minifyOptions?.whitespace === true ? true : undefined;
    return {
      bundle: true,
      entryPoints: [...(options?.entrypoints ?? [])],
      external: options?.external,
      format: options?.format ?? "esm",
      minify: minify === true || (
        minifyIdentifiers === true &&
        minifySyntax === true &&
        minifyWhitespace === true
      ),
      minifyIdentifiers,
      minifySyntax,
      minifyWhitespace,
      outdir: options?.outdir,
      platform: options?.target ?? "browser",
      sourcemap: options?.sourcemap,
    };
  }

  function ctPluginBuildMessage(error, path, namespace = "file") {
    return new BuildMessage({
      message: error?.message ?? String(error),
      position: path ? { file: String(path), namespace: namespace || "file" } : null,
    });
  }

  function ctBuildSourceExtension(path) {
    const base = String(path).replace(/\\/g, "/").split("/").pop() ?? "";
    const dot = base.lastIndexOf(".");
    return dot > 0 ? base.slice(dot) : "";
  }

  // Validates build plugins and runs their setup() functions synchronously.
  // Bun.build surfaces synchronous setup errors (including calling missing
  // builder methods such as `module()`) as synchronous throws, so this phase
  // must not be deferred into a promise.
  function prepareBuildPlugins(options, plugins) {
    const onResolveRules = [];
    const onLoadRules = [];
    const onBeforeParseRules = [];
    const onStartPromises = [];
    const onEndCallbacks = [];
    const builder = {
      config: options,
      initialOptions: ctBuildPluginInitialOptions(options),
      target: options?.target ?? "browser",
      onResolve(constraints, callback) {
        if (!callback || typeof callback !== "function") throw new TypeError("lmao callback must be a function");
        onResolveRules.push({
          ...ctValidatePluginConstraints(constraints),
          // Unlike onLoad, omitting the namespace on onResolve means that the
          // filter applies to imports from every namespace. Keep that intent
          // separate from the normalized default namespace so an explicitly
          // requested "file" namespace can still be matched exactly.
          allNamespaces: constraints.namespace === undefined,
          callback,
        });
        return this;
      },
      onLoad(constraints, callback) {
        if (!callback || typeof callback !== "function") throw new TypeError("lmao callback must be a function");
        onLoadRules.push({ ...ctValidatePluginConstraints(constraints), callback });
        return this;
      },
      onStart(callback) {
        if (typeof callback !== "function") throw new TypeError("callback must be a function");
        const result = Reflect.apply(callback, undefined, []);
        if (cottontail.promiseStatus?.(result) >= 0) onStartPromises.push(result);
        return this;
      },
      onEnd(callback) {
        if (typeof callback !== "function") throw new TypeError("onEnd() expects a callback function");
        onEndCallbacks.push(callback);
        return this;
      },
      onBeforeParse(constraints, { napiModule, external, symbol }) {
        if (!constraints || typeof constraints !== "object") {
          throw new TypeError('Expected an object with "filter" RegExp');
        }
        if (!napiModule || (typeof napiModule !== "object" && typeof napiModule !== "function")) {
          throw new TypeError(
            "onBeforeParse `napiModule` must be a Napi module which exports the `BUN_PLUGIN_NAME` symbol.",
          );
        }
        if (typeof symbol !== "string") throw new TypeError("onBeforeParse `symbol` must be a string");
        const rule = ctValidatePluginConstraints(constraints);
        const validation = cottontail.nativeBundlerPluginValidate(napiModule, symbol, external);
        if (validation?.status === "invalid-module") {
          throw new TypeError(
            "onBeforeParse `napiModule` must be a Napi module which exports the `BUN_PLUGIN_NAME` symbol.",
          );
        }
        if (validation?.status === "missing-symbol") {
          throw ctPluginInvalidArgument(`Could not find the symbol "${symbol}" in the given napi module.`);
        }
        if (validation?.status === "invalid-external") {
          throw ctPluginInvalidArgument("Expected external (3rd argument) to be a NAPI external");
        }
        onBeforeParseRules.push({
          ...rule,
          filter: new RegExp(rule.filter.source, rule.filter.flags),
          napiModule,
          external,
          symbol,
          name: validation?.name ?? "<unknown>",
        });
        return this;
      },
    };
    for (const plugin of plugins) {
      if (typeof plugin?.setup !== "function") {
        const error = new TypeError("Expected plugin to have a setup() function");
        error.code = "ERR_INVALID_ARG_TYPE";
        throw error;
      }
    }
    const setupPromises = [];
    for (const plugin of plugins) {
      const setupResult = Reflect.apply(plugin.setup, undefined, [builder]);
      if (cottontail.promiseStatus?.(setupResult) >= 0) setupPromises.push(setupResult);
    }
    return {
      onResolveRules,
      onLoadRules,
      onBeforeParseRules,
      onStartPromises,
      onEndCallbacks,
      setupPromises,
    };
  }

  // Runs Bun.build plugins in-process, materializes the
  // resolved module graph into a shadow directory, and delegates the actual
  // bundling of the materialized files to the plugin-free build pipeline.
  async function buildWithPlugins(options, plugins, prepared = null) {
    options = await ctNormalizeBuildFiles(options, true);
    const pluginGraphHook = typeof options?.__cottontailPluginGraph === "function"
      ? options.__cottontailPluginGraph
      : null;
    const {
      onResolveRules,
      onLoadRules,
      onBeforeParseRules,
      onStartPromises,
      onEndCallbacks,
      setupPromises,
    } = prepared ?? prepareBuildPlugins(options, plugins);
    for (const setupPromise of setupPromises) await setupPromise;
    if (onStartPromises.length > 0) await Promise.all(onStartPromises);

    if (onResolveRules.length === 0 && onLoadRules.length === 0 && onBeforeParseRules.length === 0) {
      options = await ctNormalizeBuildFiles(options);
      const compile = ctNormalizeCompileOptions(options);
      if (compile) {
        return ctRunCompiledBuild(options, compile, {
          setupPromises: [],
          onStart: [],
          onEnd: onEndCallbacks,
        });
      }
      return finalizePluginDriverResult(
        runBuildDriver({ ...options, plugins: undefined }),
        options,
        onEndCallbacks,
      );
    }

    const errors = [];
    const pluginWarnings = [];
    const pluginResolveFailures = [];
    const moduleRecords = new Map();
    const resolveCache = new Map();
    const packageMetadata = new Map();
    const materializedLoaders = {};
    const usedShadowNames = new Set();
    let depCounter = 0;
    const shadowRootPath = pathJoin(tmpRoot("bun-build"), `plugin-${Date.now()}-${Math.floor(Math.random() * 1000000)}`);
    cottontail.mkdirSync(shadowRootPath, true);
    const shadowRoot = cottontail.realpathSync(shadowRootPath);
    let activeOnLoadCallbacks = 0;
    let deferredOnLoadCallbacks = [];
    let deferredDrainScheduled = false;

    const scheduleDeferredOnLoadDrain = () => {
      if (activeOnLoadCallbacks !== 0 || deferredOnLoadCallbacks.length === 0 || deferredDrainScheduled) return;
      deferredDrainScheduled = true;
      queueMicrotask(() => {
        deferredDrainScheduled = false;
        if (activeOnLoadCallbacks !== 0 || deferredOnLoadCallbacks.length === 0) return;
        const batch = deferredOnLoadCallbacks;
        deferredOnLoadCallbacks = [];
        for (const state of batch) {
          if (!state.completed) {
            state.resumed = true;
            activeOnLoadCallbacks++;
          }
        }
        for (const state of batch) state.resolve();
      });
    };

    const invokeOnLoadCallback = async (callback, arguments_) => {
      const state = {
        called: false,
        resumed: false,
        completed: false,
        resolve: null,
      };
      activeOnLoadCallbacks++;
      const defer = () => {
        if (state.called) throw new Error("Can't call .defer() more than once within an onLoad plugin");
        state.called = true;
        activeOnLoadCallbacks--;
        const promise = new Promise((resolve) => {
          state.resolve = resolve;
        });
        deferredOnLoadCallbacks.push(state);
        scheduleDeferredOnLoadDrain();
        return promise;
      };

      try {
        return await Reflect.apply(callback, undefined, [{ ...arguments_, defer }]);
      } finally {
        state.completed = true;
        if (!state.called || state.resumed) activeOnLoadCallbacks--;
        scheduleDeferredOnLoadDrain();
      }
    };

    const resolveWithPlugins = async (specifier, importer, importerNamespace, resolveDir, kind) => {
      // Entry points report the empty namespace to callbacks, but participate
      // in namespace-filter matching as files.
      const namespaceForMatching = importerNamespace || "file";
      for (const rule of onResolveRules) {
        if (!rule.allNamespaces && rule.namespace !== namespaceForMatching) continue;
        if (!rule.filter.test(specifier)) continue;
        const result = await Reflect.apply(rule.callback, undefined, [{
          path: specifier,
          importer,
          namespace: importerNamespace,
          resolveDir: importerNamespace === "file" ? resolveDir : undefined,
          kind,
        }]);
        if (result == null || typeof result !== "object") continue;
        let { path, namespace: userNamespace = importerNamespace, external } = result;
        if (path !== undefined && typeof path !== "string") {
          throw new TypeError("onResolve plugins 'path' field must be a string if provided");
        }
        if (result.namespace !== undefined && typeof result.namespace !== "string") {
          throw new TypeError("onResolve plugins 'namespace' field must be a string if provided");
        }
        if (!path) continue;
        if (!userNamespace) userNamespace = importerNamespace;
        // Entry points are resolved in the empty namespace, but a resolved
        // entry module itself lives in the default "file" namespace unless
        // the plugin explicitly redirects it elsewhere.
        if (!userNamespace) userNamespace = "file";
        if (typeof external !== "boolean" && external != null) {
          throw new TypeError('onResolve plugins "external" field must be boolean or unspecified');
        }
        if (!external) {
          if (userNamespace === "file" && (!nodePathIsAbsolute(path) || path.includes(".."))) {
            throw new TypeError('onResolve plugin "path" must be absolute when the namespace is "file"');
          }
          if (userNamespace === "dataurl" && !path.startsWith("data:")) {
            throw new TypeError('onResolve plugin "path" must start with "data:" when the namespace is "dataurl"');
          }
          if (userNamespace !== "file" && !onLoadRules.some(rule => rule.namespace === userNamespace)) {
            throw new TypeError(`Expected onLoad plugin for namespace ${userNamespace} to exist`);
          }
        }
        return external ? { external: true } : { path, namespace: userNamespace };
      }
      return null;
    };

    const applyBuildAlias = specifier => {
      const aliases = options?.alias;
      if (aliases === null || typeof aliases !== "object" || Array.isArray(aliases)) return specifier;
      let matched = null;
      for (const key of Object.keys(aliases)) {
        if (specifier !== key && !specifier.startsWith(`${key}/`)) continue;
        if (matched === null || key.length > matched.length) matched = key;
      }
      if (matched === null || typeof aliases[matched] !== "string") return specifier;
      return `${aliases[matched]}${specifier.slice(matched.length)}`;
    };

    const buildResolveConditions = new Set([
      "import",
      "default",
      ...(Array.isArray(options?.conditions) ? options.conditions : []),
      options?.target === "browser" ? "browser" : "node",
    ]);
    const conditionalPackageCache = new Map();

    const selectConditionalPackageTarget = (target, wildcard = "") => {
      if (typeof target === "string") return target.replaceAll("*", wildcard);
      if (Array.isArray(target)) {
        for (const item of target) {
          const selected = selectConditionalPackageTarget(item, wildcard);
          if (selected !== null) return selected;
        }
        return null;
      }
      if (target === null || typeof target !== "object") return null;
      for (const [condition, value] of Object.entries(target)) {
        if (condition !== "default" && !buildResolveConditions.has(condition)) continue;
        const selected = selectConditionalPackageTarget(value, wildcard);
        if (selected !== null) return selected;
      }
      return null;
    };

    const conditionalPackageResolution = (specifier, fallback) => {
      const cacheKey = `${specifier}\0${fallback}`;
      if (conditionalPackageCache.has(cacheKey)) return conditionalPackageCache.get(cacheKey);

      const parts = specifier.split("/");
      const packageName = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
      const subpathParts = specifier.startsWith("@") ? parts.slice(2) : parts.slice(1);
      const subpath = subpathParts.length === 0 ? "." : `./${subpathParts.join("/")}`;
      let directory = pathDirname(fallback);
      let resolved = fallback;
      while (true) {
        const packageJsonPath = pathJoin(directory, "package.json");
        try {
          const packageJson = JSON.parse(String(cottontail.readFile(packageJsonPath)));
          if (packageJson.name === packageName && packageJson.exports !== undefined) {
            const exportsField = packageJson.exports;
            let target = exportsField;
            if (exportsField !== null && typeof exportsField === "object" && !Array.isArray(exportsField) &&
                Object.keys(exportsField).some(key => key.startsWith("."))) {
              target = exportsField[subpath];
              if (target === undefined) {
                const patterns = Object.keys(exportsField)
                  .filter(key => key.includes("*"))
                  .sort((left, right) => right.length - left.length);
                for (const pattern of patterns) {
                  const [prefix, suffix] = pattern.split("*");
                  if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
                  target = selectConditionalPackageTarget(
                    exportsField[pattern],
                    subpath.slice(prefix.length, subpath.length - suffix.length),
                  );
                  break;
                }
              }
            }
            const selected = typeof target === "string" ? target : selectConditionalPackageTarget(target);
            if (typeof selected === "string" && selected.startsWith("./")) {
              resolved = nodePathResolve(directory, selected);
            }
            break;
          }
        } catch {}
        const parent = pathDirname(directory);
        if (parent === directory) break;
        directory = parent;
      }
      conditionalPackageCache.set(cacheKey, resolved);
      return resolved;
    };

    const defaultResolveImport = (specifier, importerRecord) => {
      specifier = applyBuildAlias(specifier);
      if (!specifier.startsWith("./") && !specifier.startsWith("../") && !specifier.startsWith("/")) {
        try {
          let resolved = resolveSync(specifier, importerRecord.path);
          if (resolved.startsWith("node:") || resolved.startsWith("bun:") || nodeIsBuiltin(resolved)) {
            return { external: true };
          }
          resolved = conditionalPackageResolution(specifier, resolved);
          return { path: resolved, namespace: "file" };
        } catch {
          return null;
        }
      }
      if (importerRecord.namespace !== "file" && !specifier.startsWith("/")) {
        return { error: `Could not resolve: "${specifier}"` };
      }
      const base = specifier.startsWith("/") ? specifier : nodePathResolve(pathDirname(importerRecord.path), specifier);
      const candidates = [base];
      for (const ext of [".tsx", ".ts", ".jsx", ".mjs", ".js", ".cjs", ".css", ".html", ".json"]) candidates.push(base + ext);
      for (const ext of [".tsx", ".ts", ".jsx", ".mjs", ".js", ".cjs", ".css", ".html", ".json"]) candidates.push(`${base}/index${ext}`);
      for (const candidate of candidates) {
        if (ctBuildVirtualFile(options, candidate) !== undefined) return { path: candidate, namespace: "file" };
        try {
          if (cottontail.statSync(candidate, true)?.isFile) return { path: candidate, namespace: "file" };
        } catch {}
      }
      return { error: `Could not resolve: "${specifier}"` };
    };

    const loadWithPlugins = async (record) => {
      // The default loader is derived from the resolved path's extension for
      // every namespace, matching Bun's `Path.loader()` which ignores the
      // namespace. A path whose extension has no dedicated loader (the "file"
      // fallback) is treated as JavaScript for non-"file" namespaces, mirroring
      // Bun's `orelse .js` default for virtual/plugin-resolved modules.
      const extensionLoader = bundleLoaderForPath(record.path);
      const defaultLoader = record.namespace === "file"
        ? extensionLoader
        : extensionLoader === "file" ? "js" : extensionLoader;
      for (const rule of onLoadRules) {
        if (rule.namespace !== record.namespace) continue;
        if (!rule.filter.test(record.path)) continue;
        const result = await invokeOnLoadCallback(rule.callback, {
          path: record.path,
          namespace: record.namespace,
          loader: defaultLoader,
          side: options?.target === "browser" ? "client" : "server",
        });
        if (result == null || typeof result !== "object") continue;
        let { contents, loader } = result;
        // When an onLoad plugin omits the loader, Bun falls back to the
        // extension's loader, but extensions that would otherwise use the
        // "file" loader are parsed as JavaScript instead.
        loader ??= defaultLoader === "file" ? "js" : defaultLoader;
        if (loader === "object") {
          if (!("exports" in result)) {
            throw new TypeError('onLoad plugin returning loader: "object" must have "exports" property');
          }
          try {
            contents = JSON.stringify(result.exports);
            loader = "json";
          } catch (error) {
            throw new TypeError(`When using Bun.build, onLoad plugin must return a JSON-serializable object: ${error}`);
          }
        }
        if (typeof contents !== "string" && !ArrayBuffer.isView(contents)) {
          throw new TypeError('onLoad plugins must return an object with "contents" as a string or Uint8Array');
        }
        if (typeof loader !== "string") {
          throw new TypeError('onLoad plugins must return an object with "loader" as a string');
        }
        if (nativePluginLoaderIds[loader] === undefined) throw new TypeError(`Loader ${loader} is not supported.`);
        const normalizedContents = typeof contents === "string"
          ? contents
          : new Uint8Array(contents.buffer, contents.byteOffset, contents.byteLength);
        return { contents: normalizedContents, loader, fromOnLoad: true };
      }
      if (record.namespace === "file") {
        const virtual = ctBuildVirtualFile(options, record.path);
        const loader = bundleLoaderForPath(record.path);
        if (virtual !== undefined) return { contents: virtual, loader };
        return { contents: cottontail.readFileBuffer(record.path), loader };
      }
      throw new Error(`Could not load: "${record.namespace}:${record.path}" (no onLoad plugin returned contents)`);
    };

    const runNativeBeforeParse = (record, loaded) => {
      if (loaded.fromOnLoad) return { loaded, failed: false };
      const rules = onBeforeParseRules.filter(rule => rule.namespace === record.namespace);
      if (rules.length === 0) return { loaded, failed: false };

      const initialContents = loaded.contents;
      const initialLoader = loaded.loader ?? bundleLoaderForPath(record.path);
      const loaderId = nativePluginLoaderIds[initialLoader];
      if (loaderId === undefined) {
        errors.push(new BuildMessage({
          message: `Native plugin received an invalid loader: ${String(initialLoader)}`,
          position: { file: record.path, namespace: record.namespace },
        }));
        return { loaded, failed: true };
      }

      let sourceContents = initialContents;
      let sourceFetched = false;
      let finalHasSource = false;
      let finalContents;
      let finalLoader = initialLoader;
      let matched = false;
      let failed = false;

      for (let index = 0; index < rules.length; index++) {
        const rule = rules[index];
        finalHasSource = sourceFetched;
        finalContents = sourceFetched ? sourceContents : undefined;
        finalLoader = initialLoader;
        if (!ctNativePluginFilterMatches(rule.filter, record.path)) continue;
        matched = true;

        const result = cottontail.nativeBundlerPluginRun(
          rule.napiModule,
          rule.symbol,
          rule.external,
          record.path,
          record.namespace,
          sourceContents,
          loaderId,
          sourceFetched,
        );

        for (const log of result?.logs ?? []) {
          const level = nativePluginLogLevels[log.level] ?? "info";
          const line = Number.isFinite(Number(log.line)) ? Math.max(Number(log.line), -1) : -1;
          const column = Number.isFinite(Number(log.column)) ? Math.max(Number(log.column), -1) : -1;
          const columnEnd = Number.isFinite(Number(log.columnEnd))
            ? Math.max(Number(log.columnEnd), column)
            : column;
          const message = new BuildMessage({
            message: log.message ?? "",
            level,
            position: {
              file: log.path || record.path,
              namespace: record.namespace,
              line,
              column,
              length: columnEnd - column,
              lineText: log.sourceLineText || "",
            },
          });
          if (level === "error") {
            errors.push(message);
            failed = true;
          } else {
            pluginWarnings.push(message);
          }
        }

        if (result?.status === "invalid-context") {
          errors.push(new BuildMessage({
            message: "Native plugin set the `free_plugin_source_code_context` field without setting the `plugin_source_code_context` field.",
          }));
          failed = true;
        } else if (result?.status === "out-of-memory") {
          errors.push(new BuildMessage({ message: "Native plugin callback ran out of memory." }));
          failed = true;
        } else if (result?.status !== "ok") {
          errors.push(new BuildMessage({ message: `Native plugin callback failed: ${result?.status ?? "unknown error"}` }));
          failed = true;
        }

        if (result?.inputContents instanceof ArrayBuffer) sourceContents = result.inputContents;
        sourceFetched ||= result?.fetchedSource === true;
        finalHasSource = result?.hasSource === true;
        finalContents = finalHasSource ? result.contents : undefined;
        finalLoader = finalHasSource ? nativePluginLoaderNames[result.loader] : initialLoader;
        if (finalHasSource && finalLoader === undefined) {
          errors.push(new BuildMessage({
            message: `Native plugin returned an invalid loader: ${String(result.loader)}`,
            position: { file: record.path, namespace: record.namespace },
          }));
          failed = true;
          finalLoader = initialLoader;
        }
        if (result?.stopsChain) break;
      }

      if (!matched || !finalHasSource) return { loaded: { contents: initialContents, loader: initialLoader }, failed };
      return { loaded: { contents: finalContents, loader: finalLoader }, failed };
    };

    const packageLocation = sourcePath => {
      const normalized = String(sourcePath).replace(/\\/g, "/");
      const firstNodeModules = normalized.indexOf("/node_modules/");
      const packageNodeModules = normalized.lastIndexOf("/node_modules/");
      if (firstNodeModules < 0 || packageNodeModules < 0) return null;
      const packageStart = packageNodeModules + "/node_modules/".length;
      const firstSlash = normalized.indexOf("/", packageStart);
      if (firstSlash < 0) return null;
      const packageEnd = normalized[packageStart] === "@"
        ? normalized.indexOf("/", firstSlash + 1)
        : firstSlash;
      const end = packageEnd < 0 ? normalized.length : packageEnd;
      const packageName = normalized.slice(packageStart, end);
      if (!packageName) return null;
      return {
        name: packageName,
        sourceRoot: normalized.slice(0, end),
        shadowRoot: pathJoin(shadowRoot, normalized.slice(firstNodeModules + 1, end)),
        relativePath: normalized.slice(firstNodeModules + 1),
      };
    };

    const preservePackageMetadata = sourcePath => {
      const location = packageLocation(sourcePath);
      if (!location) return;
      const shadowPackageJson = pathJoin(location.shadowRoot, "package.json");
      if (packageMetadata.has(shadowPackageJson)) return;
      const sourcePackageJson = pathJoin(location.sourceRoot, "package.json");
      let contents = ctBuildVirtualFile(options, sourcePackageJson);
      if (contents === undefined) {
        try { contents = cottontail.readFile(sourcePackageJson); } catch {}
      }
      if (contents !== undefined) packageMetadata.set(shadowPackageJson, ctBuildContentsText(contents));
    };

    const shadowName = (sourcePath, loader, entryName, namespace = "file") => {
      const base = String(entryName ?? sourcePath).replace(/\\/g, "/").split("/").pop() || "module";
      const known = /\.(tsx|ts|jsx|mjs|cjs|js|css|html|json|toml|txt|wasm)$/i.exec(base);
      const stem = known ? base.slice(0, -known[0].length) : base;
      const sourceExtension = ctBuildSourceExtension(base);
      const ext = loader === "file"
        ? (sourceExtension || ".bin")
        : (bundleLoaderExtensions[loader] ?? (known ? known[0] : ".js"));
      const location = namespace === "file" ? packageLocation(sourcePath) : null;
      const sourceRoot = nodePathResolve(options?.root ?? cottontail.cwd());
      const sourceRelative = namespace === "file"
        ? nodePathRelative(sourceRoot, nodePathResolve(sourcePath)).replace(/\\/g, "/")
        : "";
      const sourceRelativeIsLocal = sourceRelative !== "" && sourceRelative !== ".." &&
        !sourceRelative.startsWith("../") && !sourceRelative.startsWith("/");
      const sourceRelativeDir = sourceRelativeIsLocal ? pathDirname(sourceRelative).replace(/\\/g, "/") : "";
      const namespaceHash = namespace === "file"
        ? ""
        : BigInt.asUintN(64, hash(`${namespace}\0${sourcePath}`)).toString(16);
      const namespaceName = String(namespace).replace(/[^a-zA-Z0-9_-]+/g, "-") || "virtual";
      let name = location
        ? `${location.relativePath.slice(0, location.relativePath.length - base.length)}${stem}${ext}`
        : sourceRelativeIsLocal
          ? `${sourceRelativeDir === "." ? "" : `${sourceRelativeDir}/`}${stem}${ext}`
          : namespace !== "file" && entryName == null
            ? `deps/${namespaceName}-${stem}-${namespaceHash}${ext}`
          : `${entryName == null ? `deps/dep-${depCounter++}-` : ""}${stem}${ext}`;
      // A plugin may resolve a module to a path nested beneath another
      // module's own path (e.g. onResolve returning path.resolve(importer,
      // specifier)). The shadow directory cannot represent a file as a
      // directory, so fall back to a flat deps name when any path component
      // collides with an already-materialized module.
      {
        const parts = name.split("/");
        let prefix = "";
        let collides = false;
        for (let index = 0; index < parts.length - 1; index++) {
          prefix = prefix === "" ? parts[index] : `${prefix}/${parts[index]}`;
          if (usedShadowNames.has(prefix)) {
            collides = true;
            break;
          }
        }
        if (!collides) {
          const prefixWithSlash = `${name}/`;
          for (const used of usedShadowNames) {
            if (used.startsWith(prefixWithSlash)) {
              collides = true;
              break;
            }
          }
        }
        if (collides) name = `deps/dep-${depCounter++}-${stem}${ext}`;
      }
      let counter = 1;
      const originalName = name;
      while (usedShadowNames.has(name)) {
        name = `${originalName.slice(0, -ext.length)}-${counter++}${ext}`;
      }
      usedShadowNames.add(name);
      return pathJoin(shadowRoot, name);
    };

    async function discoverModuleEdges(record) {
      const loader = record.loader;
      if (loader !== "js" && loader !== "jsx" && loader !== "ts" && loader !== "tsx" && loader !== "html" && loader !== "css") {
        return [];
      }
      record.contents = ctBuildContentsText(record.contents);
      const edges = await Promise.all(scanBundleImportsForLoader(record.contents, loader).map(async ({ specifier, kind }) => {
        const resolveDir = record.namespace === "file" ? pathDirname(record.path) : cottontail.cwd();
        // Bun resolves a given specifier from a given importer only once, so
        // duplicate imports within one file must not re-run onResolve hooks.
        // The in-flight attempt is cached so concurrent duplicate imports
        // share a single resolution.
        const cacheKey = `${record.namespace}\0${record.path}\0${kind}\0${specifier}`;
        let attempt = resolveCache.get(cacheKey);
        if (attempt === undefined) {
          attempt = (async () => {
            try {
              return {
                target: await resolveWithPlugins(specifier, record.path, record.namespace, resolveDir, kind)
                  ?? defaultResolveImport(specifier, record),
              };
            } catch (error) {
              return { error };
            }
          })();
          resolveCache.set(cacheKey, attempt);
        }
        const { target, error } = await attempt;
        if (error !== undefined) {
          errors.push(ctPluginBuildMessage(error, record.path, record.namespace));
          pluginResolveFailures.push({ importer: record.path, specifier });
          return null;
        }
        if (!target || target.external) return null;
        if (target.error) {
          // The lightweight graph scan can see import-looking text in comments
          // and template literals. Leave unresolved text untouched so the
          // native parser decides whether it is an actual dependency.
          return null;
        }
        return { specifier, target: await addModule(target) };
      }));
      return edges.filter(Boolean);
    }

    const addModule = async (resolved, entryName = undefined) => {
      const key = `${resolved.namespace}\0${resolved.path}`;
      if (moduleRecords.has(key)) return moduleRecords.get(key);
      const record = {
        key,
        path: resolved.path,
        namespace: resolved.namespace,
        shadowPath: null,
        contents: "",
        loader: "js",
        edges: [],
        pluginLoadFailed: false,
      };
      moduleRecords.set(key, record);
      let loaded;
      try {
        loaded = await loadWithPlugins(record);
      } catch (error) {
        errors.push(ctPluginBuildMessage(error, record.path, record.namespace));
        record.pluginLoadFailed = true;
        record.shadowPath = shadowName(record.path, "js", entryName, record.namespace);
        return record;
      }
      const nativeResult = runNativeBeforeParse(record, loaded);
      loaded = nativeResult.loaded;
      record.contents = loaded.contents;
      const loader = loaded.loader ?? bundleLoaderForPath(record.path);
      record.loader = loader;
      record.shadowPath = shadowName(record.path, loader, entryName, record.namespace);
      const materializedExtension = ctBuildSourceExtension(record.shadowPath);
      if (materializedExtension) materializedLoaders[materializedExtension] = loader;
      if (record.namespace === "file") preservePackageMetadata(record.path);
      if (nativeResult.failed) {
        record.pluginLoadFailed = true;
        return record;
      }
      record.edges.push(...await discoverModuleEdges(record));
      return record;
    };

    const shadowEntries = [];
    for (const entry of (options?.entrypoints ?? []).map(String)) {
      let resolved;
      try {
        resolved = await resolveWithPlugins(entry, "", "", ".", "entry-point-build");
      } catch (error) {
        errors.push(ctPluginBuildMessage(error, entry.startsWith("/") ? entry : nodePathResolve(entry), "file"));
        continue;
      }
      if (resolved?.external) continue;
      if (!resolved) {
        const abs = entry.startsWith("/") ? entry : nodePathResolve(entry);
        if (ctBuildVirtualFile(options, abs) === undefined && !cottontail.existsSync(abs)) {
          errors.push(new BuildMessage({ message: `ModuleNotFound resolving "${entry}" (entry point)` }));
          continue;
        }
        resolved = { path: abs, namespace: "file" };
      }
      const record = await addModule(resolved, entry);
      shadowEntries.push(record.shadowPath);
    }

    const jsxRecord = [...moduleRecords.values()].find(record => record.loader === "jsx" || record.loader === "tsx");
    const implicitImports = new Set();
    if (jsxRecord) {
      const importSource = typeof options?.jsx?.importSource === "string" ? options.jsx.importSource : "react";
      implicitImports.add(`${importSource}/jsx-runtime`);
      implicitImports.add(`${importSource}/jsx-dev-runtime`);
    }
    if (options?.reactFastRefresh) implicitImports.add("react-refresh/runtime");
    const implicitImporter = jsxRecord ?? moduleRecords.values().next().value;
    if (implicitImporter) {
      for (const specifier of implicitImports) {
        const target = defaultResolveImport(specifier, implicitImporter);
        if (target?.path && !target.external) await addModule(target);
      }
    }

    if (pluginGraphHook !== null && errors.length === 0) {
      const replacements = await pluginGraphHook([...moduleRecords.values()].map(record => ({
        key: record.key,
        id: nodePathRelative(shadowRoot, record.shadowPath).replace(/\\/g, "/"),
        path: record.path,
        namespace: record.namespace,
        contents: record.contents,
        loader: record.loader,
      })));
      if (replacements != null && !(replacements instanceof Map)) {
        throw new TypeError("Bake's plugin graph hook must return a Map");
      }
      if (replacements) {
        for (const record of moduleRecords.values()) {
          if (!replacements.has(record.key)) continue;
          const contents = replacements.get(record.key);
          if (typeof contents !== "string" && !ArrayBuffer.isView(contents)) {
            throw new TypeError("Bake's plugin graph replacement must be a string or Uint8Array");
          }
          record.contents = contents;
          record.edges = await discoverModuleEdges(record);
        }
      }
    }

    for (const [path, contents] of packageMetadata) {
      cottontail.mkdirSync(pathDirname(path), true);
      cottontail.writeFile(path, contents);
    }
    for (const record of moduleRecords.values()) {
      let contents = record.contents;
      if (record.edges.length > 0 && typeof contents !== "string") contents = ctBuildContentsText(contents);
      for (const edge of record.edges) {
        if (!edge.target?.shadowPath) continue;
        let relativeTarget = nodePathRelative(pathDirname(record.shadowPath), edge.target.shadowPath).replace(/\\/g, "/");
        if (!relativeTarget.startsWith("./") && !relativeTarget.startsWith("../")) relativeTarget = `./${relativeTarget}`;
        const replacement = JSON.stringify(relativeTarget);
        for (const quote of ['"', "'", "`"]) {
          contents = contents.split(`${quote}${edge.specifier}${quote}`).join(replacement);
        }
      }
      cottontail.mkdirSync(pathDirname(record.shadowPath), true);
      cottontail.writeFile(record.shadowPath, contents);
    }

    const sourceByShadowPath = new Map();
    for (const record of moduleRecords.values()) {
      if (record.shadowPath) sourceByShadowPath.set(nodePathResolve(record.shadowPath), record.path);
    }

    const shadowLoaderOptions = Object.keys(materializedLoaders).length > 0
      ? {
          ...(options?.loader && typeof options.loader === "object" ? options.loader : {}),
          ...materializedLoaders,
        }
      : options?.loader;
    const compile = ctNormalizeCompileOptions(options);
    if (compile && errors.length === 0) {
      const result = await ctRunCompiledBuild(
        {
          ...options,
          __cottontailPluginGraph: undefined,
          throw: false,
          files: undefined,
          plugins: undefined,
          root: shadowRoot,
          loader: shadowLoaderOptions,
          entrypoints: shadowEntries,
        },
        compile,
        { setupPromises: [], onStart: [], onEnd: [] },
      );
      result.logs = [...pluginWarnings, ...(result.logs ?? [])];
      await ctRunOnEnd({ onEnd: onEndCallbacks }, result);
      if (!result.success && options?.throw !== false) throw new AggregateError(result.logs, "Bundle failed");
      return result;
    }

    const driverResult = runBuildDriver({
      ...options,
      __cottontailPluginGraph: undefined,
      files: undefined,
      plugins: undefined,
      root: shadowRoot,
      __cottontailWorkingDirectory: shadowRoot,
      loader: shadowLoaderOptions,
      entrypoints: shadowEntries,
    });
    for (const log of driverResult.logs ?? []) {
      const file = log?.position?.file;
      if (!file) continue;
      const originalPath = sourceByShadowPath.get(nodePathResolve(String(file)));
      if (originalPath) log.position = { ...log.position, file: originalPath };
    }
    const failedShadowNames = new Set(
      Array.from(moduleRecords.values())
        .filter((record) => record.pluginLoadFailed && record.shadowPath)
        .map((record) => String(record.shadowPath).replace(/\\/g, "/").split("/").pop()),
    );
    driverResult.logs = (driverResult.logs ?? []).filter((log) => {
      const message = String(log?.message ?? "");
      for (const shadowName of failedShadowNames) {
        if (shadowName && message.includes(shadowName)) return false;
      }
      const file = log?.position?.file;
      for (const failure of pluginResolveFailures) {
        if (file != null && nodePathResolve(String(file)) !== nodePathResolve(failure.importer)) continue;
        if (message.includes(failure.specifier)) return false;
      }
      return true;
    });
    driverResult.logs = [...pluginWarnings, ...(driverResult.logs ?? [])];
    if (errors.length > 0) {
      driverResult.ok = false;
      driverResult.success = false;
      driverResult.name = "AggregateError";
      driverResult.message = "Bundle failed";
      driverResult.logs = [...errors, ...(driverResult.logs ?? [])];
      driverResult.outputs = [];
    }
    return finalizePluginDriverResult(
      driverResult,
      options,
      onEndCallbacks,
    );
  }

  // Bun.build artifacts and plugin callbacks are implemented in-process. Plugin
  // module graphs are materialized into a temporary directory before bundling.

  const ctInspectSymbol = Symbol.for("nodejs.util.inspect.custom");

  const CTBuildMessage = class BuildMessage {
    constructor(fields = {}) {
      this.name = fields.name != null ? String(fields.name) : "BuildMessage";
      this.message = fields.message != null ? String(fields.message) : "";
      this.position = fields.position ?? null;
      this.level = fields.level ?? "error";
      this.notes = Array.isArray(fields.notes) ? fields.notes : [];
      if (fields.rendered != null) {
        Object.defineProperty(this, "__rendered", { value: fields.rendered, configurable: true, writable: true });
      }
    }
    toString() {
      return `${this.name}: ${this.message}`;
    }
    [ctInspectSymbol]() {
      return this.__rendered ?? `${this.level ?? "error"}: ${this.message}`;
    }
  };

  const CTResolveMessage = class ResolveMessage {
    constructor(fields = {}) {
      this.name = "ResolveMessage";
      this.message = fields.message != null ? String(fields.message) : "";
      this.position = fields.position ?? null;
      this.level = fields.level ?? "error";
      this.code = fields.code ?? "";
      this.specifier = fields.specifier ?? "";
      this.importKind = fields.importKind ?? "";
      this.referrer = fields.referrer ?? "";
      if (fields.rendered != null) {
        Object.defineProperty(this, "__rendered", { value: fields.rendered, configurable: true, writable: true });
      }
    }
    toString() {
      return `${this.name}: ${this.message}`;
    }
    [ctInspectSymbol]() {
      return this.__rendered ?? `${this.level ?? "error"}: ${this.message}`;
    }
  };

  if (typeof globalThis.BuildMessage !== "function") globalThis.BuildMessage = CTBuildMessage;
  if (typeof globalThis.ResolveMessage !== "function") globalThis.ResolveMessage = CTResolveMessage;
  // Bun 1.3.10 exposes the legacy Error spellings as exact constructor aliases.
  globalThis.BuildError = globalThis.BuildMessage;
  globalThis.ResolveError = globalThis.ResolveMessage;

  function ctBuildArtifactMime(meta) {
    if (meta.type != null) return String(meta.type);
    if (meta.kind === "sourcemap") return "application/json;charset=utf-8";
    switch (meta.loader) {
      case "js":
      case "jsx":
      case "ts":
      case "tsx":
        return "text/javascript;charset=utf-8";
      case "css":
        return "text/css;charset=utf-8";
      case "html":
        return "text/html;charset=utf-8";
      case "json":
      case "toml":
        return "application/json;charset=utf-8";
      case "wasm":
        return "application/wasm";
      default:
        return "";
    }
  }

  const ctBuildArtifactContentHashSymbol = Symbol.for("cottontail.buildArtifactContentHash");

  const CTBuildArtifact = class BuildArtifact extends Blob {
    constructor(bytes, meta = {}) {
      const type = ctBuildArtifactMime(meta);
      super([bytes], type ? { type } : {});
      this.path = meta.path ?? "";
      this.loader = meta.loader ?? "file";
      this.hash = meta.hash ?? null;
      this.kind = meta.kind ?? "chunk";
      this.sourcemap = null;
      Object.defineProperty(this, ctBuildArtifactContentHashSymbol, { value: meta.contentHash ?? null });
    }
  };

  function ctErrorMessage(error) {
    if (error instanceof Error) return error.message != null ? String(error.message) : String(error);
    return String(error);
  }

  function ctDecodeThrown(encoded) {
    if (!encoded) return new Error("Unknown Bun.build error");
    if (encoded.primitive) return encoded.value;
    const error = new Error(encoded.message ?? "Unknown Bun.build error");
    if (encoded.name) error.name = encoded.name;
    if (encoded.stack) error.stack = encoded.stack;
    return error;
  }

  function ctCheckInvalidJsonImports(options) {
    for (const entrypoint of options.entrypoints ?? []) {
      let source;
      try { source = cottontail.readFile(String(entrypoint)); } catch { continue; }
      let imports;
      try { imports = new Transpiler().scanImports(source); } catch { continue; }
      for (const imported of imports) {
        const specifier = String(imported.path).split(/[?#]/, 1)[0];
        if (!specifier.startsWith(".") || !specifier.endsWith(".json")) continue;
        const basename = specifier.replace(/\\/g, "/").split("/").pop()?.toLowerCase();
        if (basename === "tsconfig.json" || basename === "package.json") continue;
        if (/\btype\s*:\s*["']jsonc["']/.test(source)) continue;
        const target = pathJoin(pathDirname(String(entrypoint)), specifier);
        try {
          JSON.parse(cottontail.readFile(target));
        } catch (error) {
          return new SyntaxError(`Invalid JSON in ${target}: ${error?.message ?? error}`);
        }
      }
    }
    return null;
  }

  async function ctRunBuildDriver(options, state) {
    const parsed = runBuildDriver(options);
    if (parsed.ok === false) {
      return { success: false, logs: parsed.logs ?? [], outputs: [], fatal: {
        message: parsed.message ?? "Bundle failed",
        name: parsed.name ?? "AggregateError",
      } };
    }
    return {
      success: parsed.success !== false,
      logs: parsed.logs ?? [],
      outputs: (parsed.outputs ?? []).map((output) => ({
        path: output.path,
        kind: output.kind ?? "entry-point",
        hash: output.hash ?? null,
        contentHash: output.contentHash ?? null,
        loader: output.loader ?? "js",
        b64: output.b64 ?? "",
        sourcemapIndex: output.sourcemapIndex ?? null,
      })),
      metafile: parsed.metafile ?? null,
    };
  }

  function ctMaterializeBuildResult(raw) {
    const rawOutputs = raw.outputs ?? [];
    const outputs = rawOutputs.map((output) => new CTBuildArtifact(
      output.b64 ? globalThis.Buffer.from(output.b64, "base64") : new Uint8Array(0),
      output,
    ));
    rawOutputs.forEach((output, index) => {
      if (output.sourcemapIndex != null && output.sourcemapIndex >= 0 && outputs[output.sourcemapIndex]) {
        outputs[index].sourcemap = outputs[output.sourcemapIndex];
      }
    });
    const logs = (raw.logs ?? []).map((log) => (
      log.name === "ResolveMessage" ? new CTResolveMessage(log) : new CTBuildMessage(log)
    ));
    const result = { success: raw.success !== false, outputs, logs };
    if (raw.metafile != null) result.metafile = raw.metafile;
    return result;
  }

  // Every callback starts in registration order. Bun turns synchronous throws
  // into rejected promises, then waits for all asynchronous callbacks together.
  async function ctRunOnEnd(state, result) {
    if (state.onEnd.length === 0) return;
    const promises = [];
    for (const callback of state.onEnd) {
      try {
        const returned = Reflect.apply(callback, undefined, [result]);
        if (cottontail.promiseStatus?.(returned) >= 0) promises.push(returned);
      } catch (error) {
        promises.push(Promise.reject(error));
      }
    }
    if (promises.length > 0) await Promise.all(promises);
  }

  async function ctRunBuild(options, state) {
    if (state.setupPromises.length > 0) await Promise.all(state.setupPromises);
    options = await ctNormalizeBuildFiles(options);

    const preError = ctCheckInvalidJsonImports(options);
    if (preError) {
      if (options.throw === false) return { success: false, logs: [preError], outputs: [] };
      throw preError;
    }

    if (state.onStart.length > 0) {
      try {
        const pending = [];
        for (const callback of state.onStart) {
          const returned = callback();
          if (returned && typeof returned.then === "function") pending.push(returned);
        }
        await Promise.all(pending);
      } catch (error) {
        const result = {
          success: false,
          outputs: [],
          logs: [new CTBuildMessage({ message: ctErrorMessage(error) })],
        };
        await ctRunOnEnd(state, result);
        if (options.throw !== false) throw error;
        return result;
      }
    }

    const raw = await ctRunBuildDriver(options, state);
    if (raw.fatal) {
      const logs = (raw.logs ?? []).map((log) => (
        log.name === "ResolveMessage" ? new CTResolveMessage(log) : new CTBuildMessage(log)
      ));
      if (logs.length === 0) logs.push(new CTBuildMessage({ message: raw.fatal.message ?? "Bundle failed" }));
      const result = { success: false, outputs: [], logs };
      await ctRunOnEnd(state, result);
      if (options.throw === false) return result;
      const errors = result.logs.filter((log) => (log?.level ?? "error") === "error");
      const error = new AggregateError(errors.length > 0 ? errors : result.logs, raw.fatal.message ?? "Bundle failed");
      if (raw.fatal.name) error.name = raw.fatal.name;
      throw error;
    }

    const result = ctMaterializeBuildResult(raw);
    await ctRunOnEnd(state, result);
    if (!result.success && options.throw !== false) {
      const errors = result.logs.filter((log) => (log?.level ?? "error") === "error");
      throw new AggregateError(errors.length > 0 ? errors : result.logs, "Bundle failed");
    }
    return result;
  }

  function ctCurrentCompileTargets() {
    const platform = globalThis.process?.platform ?? cottontail.platform();
    const arch = globalThis.process?.arch ?? "x64";
    const os = platform === "win32" ? "windows" : platform;
    const arches = arch === "arm64" || arch === "aarch64" ? ["arm64", "aarch64"] : [arch];
    return new Set(arches.map(value => `bun-${os}-${value}`));
  }

  function ctNormalizeCompileOptions(options) {
    const value = options?.compile;
    if (value == null || value === false) return null;
    if (value !== true && typeof value !== "string" && (typeof value !== "object" || Array.isArray(value))) {
      throw new TypeError('Bun.build expects "compile" to be a boolean, target string, or object');
    }

    const compile = value === true ? {} : typeof value === "string" ? { target: value } : { ...value };
    if (compile.target != null) {
      if (typeof compile.target !== "string" || !ctCurrentCompileTargets().has(compile.target)) {
        throw new Error(`Unknown compile target: ${String(compile.target)}`);
      }
    }
    if (compile.outfile != null && typeof compile.outfile !== "string") {
      throw new TypeError('Bun.build compile.outfile must be a string');
    }
    if (compile.execArgv != null && !Array.isArray(compile.execArgv)) {
      throw new TypeError('Bun.build compile.execArgv must be an array');
    }
    if (compile.executablePath != null && typeof compile.executablePath !== "string") {
      throw new TypeError('Bun.build compile.executablePath must be a string');
    }
    if (compile.windows != null) {
      if (typeof compile.windows !== "object" || Array.isArray(compile.windows)) {
        throw new TypeError("Bun.build compile.windows must be an object");
      }
      const windows = { ...compile.windows };
      if (Object.hasOwn(windows, "hideConsole")) {
        windows.hideConsole = Boolean(windows.hideConsole);
      }
      for (const name of ["icon", "title", "publisher", "version", "description", "copyright"]) {
        if (windows[name] != null && typeof windows[name] !== "string") {
          throw new TypeError(`Bun.build compile.windows.${name} must be a string`);
        }
      }
      compile.windows = windows;
    }
    for (const name of ["autoloadDotenv", "autoloadBunfig", "autoloadTsconfig", "autoloadPackageJson"]) {
      if (Object.hasOwn(compile, name)) compile[name] = Boolean(compile[name]);
    }
    return compile;
  }

  function ctIsStandaloneHtmlCompile(options, compile) {
    return !!compile &&
      (options?.target ?? "browser") === "browser" &&
      options.entrypoints.every(entrypoint => /\.html?$/i.test(String(entrypoint)));
  }

  function ctCompiledOutputPath(options, compile, cwd) {
    const entry = String(options.entrypoints[0]);
    const entryName = nodePathBasename(entry);
    const extension = /\.[^./\\]+$/.exec(entryName)?.[0] ?? "";
    let outfile = compile.outfile != null
      ? String(compile.outfile)
      : entryName.slice(0, extension ? -extension.length : undefined) || "index";
    if (!outfile.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(outfile)) {
      outfile = nodePathResolve(options.outdir != null ? String(options.outdir) : cwd, outfile);
    }
    if ((globalThis.process?.platform ?? cottontail.platform()) === "win32" && !/\.exe$/i.test(outfile)) {
      outfile += ".exe";
    }
    return outfile;
  }

  async function ctRunCompiledBuild(options, compile, state) {
    if (options.entrypoints.length !== 1) {
      throw new TypeError("Bun.build compile requires exactly one entrypoint");
    }
    if (state.setupPromises.length > 0) await Promise.all(state.setupPromises);
    if (state.onStart.length > 0) {
      for (const callback of state.onStart) await callback();
    }

    const cwd = globalThis.process?.cwd?.() ?? cottontail.cwd();
    const entry = nodePathResolve(cwd, String(options.entrypoints[0]));
    const outfile = ctCompiledOutputPath(options, compile, cwd);
    const request = {
      ...options,
      plugins: undefined,
      entrypoints: [entry],
      compile: {
        ...compile,
        execArgv: Array.isArray(compile.execArgv) ? compile.execArgv.map(String) : undefined,
      },
    };
    let parsed;
    try {
      parsed = JSON.parse(cottontail.compileBuildNative(JSON.stringify(request), cwd, outfile));
    } catch (error) {
      const result = { success: false, outputs: [], logs: [new CTBuildMessage({ message: ctErrorMessage(error) })] };
      await ctRunOnEnd(state, result);
      if (options.throw === false) return result;
      throw new AggregateError(result.logs, "Bundle failed");
    }

    const outputs = [];
    for (const output of parsed.outputs ?? []) {
      outputs.push(new CTBuildArtifact(new Uint8Array(await file(output.path).arrayBuffer()), {
        path: output.path,
        kind: output.kind,
        loader: output.loader,
        hash: null,
      }));
    }
    const executableArtifact = outputs.find(output => output.kind === "entry-point");
    const sourceMapArtifact = outputs.find(output => output.kind === "sourcemap");
    if (executableArtifact && sourceMapArtifact) executableArtifact.sourcemap = sourceMapArtifact;
    const result = {
      success: parsed.success !== false,
      outputs,
      logs: [],
    };
    await ctRunOnEnd(state, result);
    if (!result.success && options.throw !== false) {
      throw new AggregateError(result.logs, "Bundle failed");
    }
    return result;
  }

  function build(options) {
    if (globalThis[Symbol.for("cottontail.macroMode")] === true ||
        globalThis.process?.execArgv?.includes("--cottontail-macro-mode") ||
        globalThis.process?.env?.COTTONTAIL_MACRO_MODE === "1") {
      throw new Error("Bun.build cannot be called from within a macro");
    }
    if (options == null || typeof options !== "object") {
      throw new TypeError("Expected a config object to be passed to Bun.build");
    }
    if (!Array.isArray(options.entrypoints) || options.entrypoints.length === 0) {
      throw new TypeError('Bun.build expects "entrypoints" to be a non-empty array of strings');
    }
    for (const entry of options.entrypoints) {
      if (typeof entry !== "string") {
        throw new TypeError('Bun.build expects "entrypoints" to be an array of strings');
      }
    }
    if (options.format != null && !["esm", "cjs", "iife", "internal_bake_dev"].includes(options.format)) {
      throw new TypeError(`Invalid "format" value in Bun.build: ${String(options.format)}`);
    }
    if (options.target != null && !["browser", "bun", "node"].includes(options.target)) {
      throw new TypeError(`Invalid "target" value in Bun.build: ${String(options.target)}`);
    }
    let compile = ctNormalizeCompileOptions(options);
    if (ctIsStandaloneHtmlCompile(options, compile)) {
      if (options.splitting === true) {
        throw new TypeError("Cannot use compile with target 'browser' and splitting for standalone HTML");
      }
      options = { ...options, compile: undefined, compileToStandaloneHtml: true };
      compile = null;
    }
    const sourcemap = options.sourcemap;
    if (sourcemap != null && typeof sourcemap !== "boolean"
        && !["none", "linked", "inline", "external"].includes(sourcemap)) {
      throw new TypeError(`Invalid "sourcemap" value in Bun.build: ${String(sourcemap)}`);
    }
    if (options.plugins != null) {
      if (!Array.isArray(options.plugins)) {
        throw new TypeError("Expected plugins to be an array of objects");
      }
      for (const plugin of options.plugins) {
        if (plugin === null || typeof plugin !== "object") {
          throw new TypeError("Expected plugin to be an object");
        }
      }
      // Plugin setup runs synchronously so that configuration errors throw
      // from Bun.build itself instead of rejecting the returned promise.
      return buildWithPlugins(options, options.plugins, prepareBuildPlugins(options, options.plugins));
    }

    const state = {
      onStart: [],
      onEnd: [],
      setupPromises: [],
    };

    if (compile) return ctRunCompiledBuild(options, compile, state);
    return ctRunBuild(options, state);
  }

  return Object.freeze({
    build,
    CTBuildMessage,
    CTResolveMessage,
  });
}
