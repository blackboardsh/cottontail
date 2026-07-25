import { expect, test } from "bun:test";

const windowsTest = test.skipIf(process.platform !== "win32");

windowsTest("Bun.secrets uses Windows Credential Manager for persistent Unicode credentials", async () => {
  const service = `cottontail-secrets-${process.pid}-${Date.now()}`;
  const name = "用户/name@example.com";
  const initialValue = "密码🔒\n\t\r\0initial";
  const updatedValue = "updated !@#$%^&*()_+-=[]{}|;':\",./<>?`~";

  try {
    expect(await Bun.secrets.get({ service, name })).toBeNull();
    expect(await Bun.secrets.delete({ service, name })).toBe(false);

    const setResult = Bun.secrets.set({ service, name, value: initialValue });
    expect(setResult).toBeInstanceOf(Promise);
    expect(await setResult).toBeUndefined();
    expect(await Bun.secrets.get({ service, name })).toBe(initialValue);

    await Bun.secrets.set({
      service,
      name,
      value: updatedValue,
      allowUnrestrictedAccess: true,
    });
    expect(await Bun.secrets.get({ service, name })).toBe(updatedValue);
    expect(await Bun.secrets.delete({ service, name })).toBe(true);
    expect(await Bun.secrets.get({ service, name })).toBeNull();
    expect(await Bun.secrets.delete({ service, name })).toBe(false);

    await Bun.secrets.set({ service, name, value: initialValue });
    await Bun.secrets.set({ service, name, value: "" });
    expect(await Bun.secrets.get({ service, name })).toBeNull();
  } finally {
    await Bun.secrets.delete({ service, name });
  }
});

windowsTest("Bun.secrets reports Windows Credential Manager failures with Bun error codes", async () => {
  const service = `cottontail-secrets-error-${process.pid}-${Date.now()}`;
  const name = "oversize";

  try {
    await Bun.secrets.set({ service, name, value: "x".repeat(3000) });
    throw new Error("Expected an oversized Credential Manager value to fail");
  } catch (error: any) {
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("ERR_SECRETS_PLATFORM_ERROR");
    expect(error.message).toContain("(code: 1783)");
  } finally {
    await Bun.secrets.delete({ service, name });
  }

  const longService = `${service}-${"x".repeat(8192)}`;
  try {
    await Bun.secrets.set({ service: longService, name, value: "value" });
    throw new Error("Expected an oversized Credential Manager target to fail");
  } catch (error: any) {
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("ERR_SECRETS_PLATFORM_ERROR");
    expect(error.message).toContain("(code: 24)");
  } finally {
    await Bun.secrets.delete({ service: longService, name });
  }
  expect(await Bun.secrets.get({ service: longService, name })).toBeNull();
  expect(await Bun.secrets.delete({ service: longService, name })).toBe(false);
});

windowsTest("Bun.secrets keeps ambiguous Windows credential keys isolated", async () => {
  const prefix = `cottontail-secrets-key-${process.pid}-${Date.now()}`;
  const entries = [
    {
      service: `${prefix}/shared`,
      name: "account",
      value: "slash-in-service",
    },
    {
      service: prefix,
      name: "shared/account",
      value: "slash-in-name",
    },
    {
      service: `${prefix}-Case`,
      name: "account",
      value: "upper-case-service",
    },
    {
      service: `${prefix}-case`,
      name: "account",
      value: "lower-case-service",
    },
    {
      service: `${prefix}-nul\0left`,
      name: "account",
      value: "nul-left",
    },
    {
      service: `${prefix}-nul\0right`,
      name: "account",
      value: "nul-right",
    },
    {
      service: `${prefix}-surrogate-\ud800`,
      name: "account",
      value: "surrogate-d800",
    },
    {
      service: `${prefix}-surrogate-\ud801`,
      name: "account",
      value: "surrogate-d801",
    },
  ];

  try {
    for (const entry of entries) {
      await Bun.secrets.set(entry);
    }
    for (const entry of entries) {
      expect(await Bun.secrets.get(entry)).toBe(entry.value);
    }

    expect(await Bun.secrets.delete(entries[0])).toBe(true);
    expect(await Bun.secrets.get(entries[0])).toBeNull();
    expect(await Bun.secrets.get(entries[1])).toBe(entries[1].value);

    expect(await Bun.secrets.delete(entries[2])).toBe(true);
    expect(await Bun.secrets.get(entries[2])).toBeNull();
    expect(await Bun.secrets.get(entries[3])).toBe(entries[3].value);

    expect(await Bun.secrets.delete(entries[4])).toBe(true);
    expect(await Bun.secrets.get(entries[4])).toBeNull();
    expect(await Bun.secrets.get(entries[5])).toBe(entries[5].value);

    expect(await Bun.secrets.delete(entries[6])).toBe(true);
    expect(await Bun.secrets.get(entries[6])).toBeNull();
    expect(await Bun.secrets.get(entries[7])).toBe(entries[7].value);
  } finally {
    for (const entry of entries) {
      await Bun.secrets.delete(entry);
    }
  }
});
