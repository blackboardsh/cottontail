import { assert, binaryName, fail, fs, os, path, proc, runChecked } from './ct-runtime.js';

const ZIG_VERSION = '0.16.0';
const ROOT = proc.cwd();
const ZIG_DIR = path.join(ROOT, 'vendors', 'zig');
const ZIG_VERSION_STAMP = path.join(ZIG_DIR, '.zig-version');
const ZIG_BINARY = path.join(ZIG_DIR, binaryName('zig'));
const COTTONTAIL_BINARY = path.join(ROOT, 'zig-out', 'bin', binaryName('cottontail'));

function printHelp() {
  console.log('cottontail repo workflow');
  console.log('');
  console.log('Usage:');
  console.log('  cottontail scripts/repo.js <command> [args...]');
  console.log('');
  console.log('Commands:');
  console.log('  setup');
  console.log('  check-zig-version');
  console.log('  build');
  console.log('  build:release');
  console.log('  run <entrypoint.js> [args...]');
  console.log('  dev');
  console.log('  test:zig');
  console.log('  test:js');
  console.log('  test');
  console.log('  bench:build');
  console.log('  bench');
}

function readStamp(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  return fs.readFileSync(filePath, 'utf8').trim();
}

function isCurrentZigVendored() {
  return fs.existsSync(ZIG_BINARY) && readStamp(ZIG_VERSION_STAMP) === ZIG_VERSION;
}

function resetZigVendorDir() {
  fs.rmSync(ZIG_DIR, { recursive: true, force: true });
  fs.mkdirSync(ZIG_DIR, { recursive: true });
}

function getHostArch() {
  if (os.arch() === 'arm64') {
    return 'aarch64';
  }

  if (os.arch() === 'x64') {
    return 'x86_64';
  }

  throw new Error(`Unsupported architecture: ${os.arch()}`);
}

function getHostPlatform() {
  const platform = os.platform();

  if (platform === 'darwin') {
    return { os: 'macos', archive: 'tar.xz' };
  }

  if (platform === 'linux') {
    return { os: 'linux', archive: 'tar.xz' };
  }

  if (platform === 'win32') {
    return { os: 'windows', archive: 'zip' };
  }

  throw new Error(`Unsupported platform: ${platform}`);
}

function ensureVendorsRoot() {
  fs.mkdirSync(path.join(ROOT, 'vendors'), { recursive: true });
}

function vendorZig() {
  if (isCurrentZigVendored()) {
    console.log(`✓ Zig ${ZIG_VERSION} already vendored`);
    return;
  }

  ensureVendorsRoot();

  const arch = getHostArch();
  const { os: hostOs, archive } = getHostPlatform();
  const folder = `zig-${arch}-${hostOs}-${ZIG_VERSION}`;

  console.log(`Vendoring Zig ${ZIG_VERSION}...`);
  resetZigVendorDir();

  if (archive === 'tar.xz') {
    const archivePath = path.join(ROOT, 'vendors', 'zig.tar.xz');
    const url = `https://ziglang.org/download/${ZIG_VERSION}/${folder}.tar.xz`;

    runChecked('curl', ['-L', url, '-o', archivePath]);
    runChecked('tar', [
      '-xJf',
      archivePath,
      '--strip-components=1',
      '-C',
      ZIG_DIR,
      `${folder}/zig`,
      `${folder}/lib`,
      `${folder}/doc`,
    ]);

    if (fs.existsSync(archivePath)) {
      fs.unlinkSync(archivePath);
    }
  } else {
    const zipPath = path.join(ROOT, 'vendors', 'zig.zip');
    const tempDir = path.join(ROOT, 'vendors', 'zig-temp');

    runChecked('curl', [
      '-L',
      `https://ziglang.org/download/${ZIG_VERSION}/${folder}.zip`,
      '-o',
      zipPath,
    ]);
    runChecked('powershell', [
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `Expand-Archive -Path '${zipPath}' -DestinationPath '${tempDir}' -Force`,
    ]);
    runChecked('powershell', [
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `Move-Item -Path '${path.join(tempDir, folder, 'zig.exe')}' -Destination '${ZIG_DIR}' -Force; Move-Item -Path '${path.join(tempDir, folder, 'lib')}' -Destination '${ZIG_DIR}' -Force; if (Test-Path '${path.join(tempDir, folder, 'doc')}') { Move-Item -Path '${path.join(tempDir, folder, 'doc')}' -Destination '${ZIG_DIR}' -Force }`,
    ]);

    if (fs.existsSync(zipPath)) {
      fs.unlinkSync(zipPath);
    }

    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  assert(fs.existsSync(ZIG_BINARY), `Vendored Zig binary not found at ${ZIG_BINARY}`);

  if (os.platform() !== 'win32') {
    fs.chmodSync(ZIG_BINARY, 0o755);
  }

  fs.writeFileSync(ZIG_VERSION_STAMP, `${ZIG_VERSION}\n`);
  console.log(`✓ Zig ${ZIG_VERSION} vendored for ${os.platform()}/${os.arch()}`);
}

function setup() {
  vendorZig();
  console.log('');
  console.log('Setup complete. You can now run: ./zig-out/bin/cottontail scripts/repo.js build');
}

function ensureSetup() {
  setup();
}

function ensureBuiltBinary() {
  if (!fs.existsSync(COTTONTAIL_BINARY)) {
    fail(`Built cottontail binary not found at ${COTTONTAIL_BINARY}. Run the build command first.`);
  }
}

function runZig(args) {
  if (!fs.existsSync(ZIG_BINARY)) {
    fail(`Vendored Zig compiler not found at ${ZIG_BINARY}. Run the setup command first.`);
  }

  runChecked(ZIG_BINARY, args);
}

function build() {
  ensureSetup();
  runZig(['build']);
}

function buildRelease() {
  ensureSetup();
  const args = ['build', '-Doptimize=ReleaseSmall'];
  if (os.platform() === 'win32') {
    args.push('-Dtarget=x86_64-windows-msvc');
  }
  args.push('-Dcpu=baseline');
  runZig(args);
}

function runCommand(scriptArgs) {
  build();
  ensureBuiltBinary();
  runChecked(COTTONTAIL_BINARY, scriptArgs);
}

function dev() {
  runCommand(['test.js']);
}

function testZig() {
  ensureSetup();
  runZig(['build', 'test']);
}

function testJs() {
  build();
  ensureBuiltBinary();
  runChecked(COTTONTAIL_BINARY, ['scripts/test-js-ct.js']);
}

function testAll() {
  testZig();
  testJs();
}

function benchBuild() {
  buildRelease();
}

function bench() {
  benchBuild();
  ensureBuiltBinary();
  runChecked(COTTONTAIL_BINARY, ['scripts/bench-ct.js']);
}

const [command, ...rest] = proc.argv;

switch (command) {
  case undefined:
  case '--help':
  case '-h':
    printHelp();
    break;
  case 'setup':
    setup();
    break;
  case 'check-zig-version':
    ensureSetup();
    runZig(['version']);
    break;
  case 'build':
    build();
    break;
  case 'build:release':
    buildRelease();
    break;
  case 'run':
    if (rest.length === 0) {
      fail('Usage: cottontail scripts/repo.js run <entrypoint.js> [args...]');
    }
    runCommand(rest);
    break;
  case 'dev':
    dev();
    break;
  case 'test:zig':
    testZig();
    break;
  case 'test:js':
    testJs();
    break;
  case 'test':
    testAll();
    break;
  case 'bench:build':
    benchBuild();
    break;
  case 'bench':
    bench();
    break;
  default:
    fail(`Unknown command: ${command}`);
}
