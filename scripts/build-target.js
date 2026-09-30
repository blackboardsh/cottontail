export function buildArchitecture(platform = process.platform, arch = process.arch, requested = process.env.COTTONTAIL_TARGET_ARCH) {
  const target = requested || arch;
  if (!['x64', 'arm64'].includes(target)) throw new Error(`Unsupported target architecture: ${target}`);
  if (platform !== 'win32' && target !== arch) throw new Error('Cross-compilation is supported only on Windows');
  return target;
}

export function windowsTarget(arch) {
  if (!['x64', 'arm64'].includes(arch)) throw new Error(`Unsupported Windows architecture: ${arch}`);
  return {
    zig: `${arch === 'arm64' ? 'aarch64' : 'x86_64'}-windows-msvc`,
    triplet: `${arch}-windows-static`,
    jsc: arch === 'arm64' ? 'windows-arm64' : 'windows-amd64',
  };
}

export function buildJobArgs(value = process.env.COTTONTAIL_BUILD_JOBS) {
  if (!value) return [];
  if (!/^[1-9]\d*$/.test(value)) throw new Error('COTTONTAIL_BUILD_JOBS must be a positive integer');
  return [`-j${value}`];
}
