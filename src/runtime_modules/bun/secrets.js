function secretsError(message, code = "ERR_INVALID_ARG_TYPE") {
  const error = new TypeError(message);
  error.code = code;
  return error;
}

function validateSecretOptions(method, options, needsValue = false) {
  if (options == null) throw secretsError(`secrets.${method} requires an options object`);
  if (typeof options !== "object" || Array.isArray(options)) throw secretsError("Expected options to be an object");
  if (typeof options.service !== "string" || typeof options.name !== "string") {
    throw secretsError("Expected service and name to be strings");
  }
  if (!options.service || !options.name) throw secretsError("Expected service and name to not be empty");
  if (needsValue && typeof options.value !== "string") throw secretsError("Expected 'value' to be a string");
  return options;
}

function secretCommand(args, input = undefined) {
  const encodedInput = typeof input === "string" ? new TextEncoder().encode(input) : input;
  return globalThis.Bun.spawnSync(args, {
    input: encodedInput,
    stdin: encodedInput == null ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
}

function secretCommandError(result, operation) {
  const message = String(result.stderr || result.stdout || `Unable to ${operation} secret`).trim();
  const error = new Error(message);
  error.code = "ERR_SECRETS";
  throw error;
}

export const secrets = {
  async get(rawOptions) {
    const options = validateSecretOptions("get", rawOptions);
    if (process.platform === "win32") {
      return cottontail.secretGet(options.service, options.name);
    }
    if (process.platform === "darwin") {
      const result = secretCommand(["security", "find-generic-password", "-s", options.service, "-a", options.name, "-g"]);
      if (result.exitCode === 44) return null;
      if (result.exitCode !== 0) secretCommandError(result, "read");
      const output = String(result.stderr || result.stdout);
      const hex = /^password:\s+0x([0-9a-f]+)/im.exec(output);
      if (hex) return Buffer.from(hex[1], "hex").toString("utf8");
      const quoted = /^password:\s+"(.*)"\s*$/m.exec(output);
      if (quoted) return quoted[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      secretCommandError(result, "read");
    }
    if (process.platform === "linux") {
      const result = secretCommand(["secret-tool", "lookup", "service", options.service, "name", options.name]);
      if (result.exitCode !== 0 || String(result.stdout).length === 0) return null;
      return String(result.stdout).replace(/\r?\n$/, "");
    }
    throw secretsError(`Bun.secrets is not supported on ${process.platform}`, "ERR_NOT_SUPPORTED");
  },
  async set(rawOptions) {
    const options = validateSecretOptions("set", rawOptions, true);
    if (options.value === "") {
      await this.delete(options);
      return;
    }
    if (process.platform === "win32") {
      cottontail.secretSet(options.service, options.name, options.value);
      return;
    }
    if (process.platform === "darwin") {
      const args = ["security", "add-generic-password", "-U", "-s", options.service, "-a", options.name, "-w", options.value];
      if (options.allowUnrestrictedAccess === true) args.push("-A");
      const result = secretCommand(args);
      if (result.exitCode !== 0) secretCommandError(result, "store");
      return;
    }
    if (process.platform === "linux") {
      const result = secretCommand(
        ["secret-tool", "store", `--label=${options.service}`, "service", options.service, "name", options.name],
        options.value,
      );
      if (result.exitCode !== 0) secretCommandError(result, "store");
      return;
    }
    throw secretsError(`Bun.secrets is not supported on ${process.platform}`, "ERR_NOT_SUPPORTED");
  },
  async delete(rawOptions) {
    const options = validateSecretOptions("delete", rawOptions);
    if (process.platform === "win32") {
      return cottontail.secretDelete(options.service, options.name);
    }
    if (process.platform === "darwin") {
      const result = secretCommand(["security", "delete-generic-password", "-s", options.service, "-a", options.name]);
      if (result.exitCode === 44) return false;
      if (result.exitCode !== 0) secretCommandError(result, "delete");
      return true;
    }
    if (process.platform === "linux") {
      const existing = await this.get(options);
      if (existing == null) return false;
      const result = secretCommand(["secret-tool", "clear", "service", options.service, "name", options.name]);
      if (result.exitCode !== 0) secretCommandError(result, "delete");
      return true;
    }
    throw secretsError(`Bun.secrets is not supported on ${process.platform}`, "ERR_NOT_SUPPORTED");
  },
};
