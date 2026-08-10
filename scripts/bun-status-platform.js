const platformKeyPattern = /^(?:aix|darwin|freebsd|linux|openbsd|sunos|win32)-(?:arm64|ia32|x64)$/;

export function bunStatusPlatformKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

export function applyBunStatusEntryOverride(entry, override) {
  const result = { ...(entry ?? {}) };
  for (const [key, value] of Object.entries(override ?? {})) {
    if (value === null) delete result[key];
    else result[key] = value;
  }
  return result;
}

export function resolveBunStatusPlatform(
  status,
  platform = process.platform,
  arch = process.arch,
) {
  const key = bunStatusPlatformKey(platform, arch);
  const override = status.platformOverrides?.[key];
  if (override == null) return status;

  const tests = { ...(status.tests ?? {}) };
  for (const [path, entryOverride] of Object.entries(override.tests ?? {})) {
    tests[path] = applyBunStatusEntryOverride(tests[path], entryOverride);
  }
  return { ...status, tests };
}

export function validateBunStatusPlatformOverrides(status) {
  const errors = [];
  const overrides = status.platformOverrides;
  if (overrides == null) return errors;
  if (typeof overrides !== 'object' || Array.isArray(overrides)) {
    return ['status.platformOverrides must be an object keyed by platform-architecture'];
  }

  for (const [key, override] of Object.entries(overrides)) {
    if (!platformKeyPattern.test(key)) {
      errors.push(`status.platformOverrides has invalid platform key ${key}`);
    }
    if (override == null || typeof override !== 'object' || Array.isArray(override)) {
      errors.push(`status.platformOverrides.${key} must be an object`);
      continue;
    }
    const unknownFields = Object.keys(override).filter((field) => field !== 'tests');
    if (unknownFields.length > 0) {
      errors.push(
        `status.platformOverrides.${key} has unknown field(s): ${unknownFields.join(', ')}`,
      );
    }
    if (override.tests == null || typeof override.tests !== 'object' || Array.isArray(override.tests)) {
      errors.push(`status.platformOverrides.${key}.tests must be an object`);
      continue;
    }
    for (const [path, entryOverride] of Object.entries(override.tests)) {
      if (status.tests?.[path] == null) {
        errors.push(`status.platformOverrides.${key}.tests contains an unknown path: ${path}`);
      }
      if (entryOverride == null || typeof entryOverride !== 'object' || Array.isArray(entryOverride)) {
        errors.push(`status.platformOverrides.${key}.tests.${path} must be an object`);
      }
    }
  }
  return errors;
}
