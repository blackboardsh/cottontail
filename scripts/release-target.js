export const BASELINE_CPU_ARG = '-Dcpu=baseline';
export const WINDOWS_X64_TARGET_ARG = '-Dtarget=x86_64-windows-msvc';

export function releaseTargetArgs(platform) {
  switch (platform) {
    case 'darwin':
    case 'linux':
      return [BASELINE_CPU_ARG];
    case 'win32':
      return [WINDOWS_X64_TARGET_ARG, BASELINE_CPU_ARG];
    default:
      throw new Error(`Unsupported Cottontail release platform: ${platform}`);
  }
}
