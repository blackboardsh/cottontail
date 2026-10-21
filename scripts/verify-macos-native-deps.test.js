import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import test from 'node:test';

import { parseOtoolLoadCommands, verifyMacosNativeDependencies } from './verify-macos-native-deps.js';

function output({ architecture = 'ARM64', executable = false, dependencies = [], rpaths = [], id, deploymentTargets = [] } = {}) {
  const commands = [];
  for (const { command = 'LC_BUILD_VERSION', platform = 'MACOS', minimumVersion, sdk = '26.0' } of deploymentTargets) {
    commands.push(command === 'LC_BUILD_VERSION'
      ? `cmd ${command}\n cmdsize 32\n platform ${platform}\n minos ${minimumVersion}\n sdk ${sdk}\n ntools 0`
      : `cmd ${command}\n cmdsize 16\n version ${minimumVersion}\n sdk ${sdk}`);
  }
  if (id) commands.push(`cmd LC_ID_DYLIB\n name ${id} (offset 24)`);
  for (const dependency of dependencies) {
    const { path, command = 'LC_LOAD_DYLIB' } = typeof dependency === 'string' ? { path: dependency } : dependency;
    commands.push(`cmd ${command}\n cmdsize 72\n name ${path} (offset 24)`);
  }
  for (const rpath of rpaths) commands.push(`cmd LC_RPATH\n path ${rpath} (offset 12)`);
  return `artifact:\nMach header\n magic cputype cpusubtype caps filetype ncmds sizeofcmds flags\nMH_MAGIC_64 ${architecture} ALL 0x00 ${executable ? 'EXECUTE' : 'DYLIB'} ${commands.length} 4096 DYLDLINK\n${commands.map((command, index) => `Load command ${index}\n ${command}`).join('\n')}\n`;
}

function fixture(t, files) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cottontail-macos-deps-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of Object.keys(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), Buffer.from('cffaedfe', 'hex'));
  }
  return {
    root,
    verify: (options = {}) => verifyMacosNativeDependencies(root, { ...options, inspect: (path) => files[relative(root, path).split(sep).join('/')] }),
  };
}

test('parses universal load commands, paths with spaces, weak imports, and library IDs', () => {
  const parsed = parseOtoolLoadCommands(output({
    id: '/build/machine/library.dylib',
    dependencies: [
      '/usr/lib/libSystem.B.dylib',
      { path: '@rpath/Optional Framework.framework/Optional Framework', command: 'LC_LOAD_WEAK_DYLIB' },
      { path: '@loader_path/reexport.dylib', command: 'LC_REEXPORT_DYLIB' },
    ],
    rpaths: ['@loader_path/Library Folder'],
  }) + output({ architecture: 'X86_64', executable: true }));
  assert.deepEqual(parsed, [
    {
      architecture: 'arm64', executable: false,
      dependencies: [
        { path: '/usr/lib/libSystem.B.dylib', weak: false },
        { path: '@rpath/Optional Framework.framework/Optional Framework', weak: true },
        { path: '@loader_path/reexport.dylib', weak: false },
      ],
      rpaths: ['@loader_path/Library Folder'],
    },
    { architecture: 'x86_64', executable: true, dependencies: [], rpaths: [] },
  ]);
  assert.throws(() => parseOtoolLoadCommands('otool failed'), /did not report a Mach-O header/);
});

test('parses modern and legacy deployment targets independently for universal slices', () => {
  const parsed = parseOtoolLoadCommands(output({
    architecture: 'X86_64', deploymentTargets: [{ minimumVersion: '14.0', platform: '1' }],
  }) + output({ deploymentTargets: [{ command: 'LC_VERSION_MIN_MACOSX', minimumVersion: '11.0' }] }));
  assert.deepEqual(parsed.map((slice) => slice.deploymentTargets), [
    [{ command: 'LC_BUILD_VERSION', platform: '1', minimumVersion: '14.0' }],
    [{ command: 'LC_VERSION_MIN_MACOSX', platform: 'MACOS', minimumVersion: '11.0' }],
  ]);
});

test('requires the requested architecture in every Mach-O file, including unlinked capabilities', (t) => {
  const files = {
    runtime: output({ architecture: 'X86_64', executable: true }),
    'capabilities/unlinked.dylib': output(),
  };
  const { verify } = fixture(t, files);
  assert.equal(verify().files, 2);
  assert.throws(() => verify({ expectedArchitecture: 'x86_64' }), /capabilities\/unlinked\.dylib: missing required x86_64 architecture \(found arm64\)/);
  files['capabilities/unlinked.dylib'] += output({ architecture: 'X86_64' });
  assert.equal(verify({ expectedArchitecture: 'x86_64' }).slices, 3);
  assert.throws(() => verify({ expectedArchitecture: 'arm64' }), /runtime: missing required arm64 architecture \(found x86_64\)/);
});

test('checks only the requested deployment slice while accepting universal files', (t) => {
  const files = {
    runtime: output({ architecture: 'X86_64', executable: true, deploymentTargets: [{ minimumVersion: '14.0.0' }] })
      + output({ executable: true, deploymentTargets: [{ minimumVersion: '15.0' }] }),
    'capability.dylib': output({ architecture: 'X86_64', deploymentTargets: [{ command: 'LC_VERSION_MIN_MACOSX', minimumVersion: '10.15.7' }] })
      + output({ deploymentTargets: [{ minimumVersion: '15.0' }] }),
  };
  const { verify } = fixture(t, files);
  assert.equal(verify({ expectedArchitecture: 'x86_64', maxMacosVersion: '14.0' }).slices, 4);
  assert.throws(() => verify({ expectedArchitecture: 'arm64', maxMacosVersion: '14.0' }), /runtime \(arm64\): LC_BUILD_VERSION requires macOS 15.0, above allowed 14.0/);
  assert.throws(() => verify({ maxMacosVersion: '14.0' }), /capability\.dylib \(arm64\): LC_BUILD_VERSION requires macOS 15.0/);
});

test('rejects too-new modern and legacy deployment targets using numeric version comparison', (t) => {
  for (const command of ['LC_BUILD_VERSION', 'LC_VERSION_MIN_MACOSX']) {
    const files = {
      runtime: output({ architecture: 'X86_64', executable: true, deploymentTargets: [{ command, minimumVersion: '14.0.1' }] }),
    };
    const { verify } = fixture(t, files);
    assert.throws(() => verify({ expectedArchitecture: 'x86_64', maxMacosVersion: '14.0' }), /requires macOS 14.0.1, above allowed 14.0/);
    files.runtime = output({ architecture: 'X86_64', executable: true, deploymentTargets: [{ command, minimumVersion: '10.15' }] });
    assert.throws(() => verify({ maxMacosVersion: '10.9' }), /requires macOS 10.15, above allowed 10.9/);
    assert.equal(verify({ maxMacosVersion: '14' }).files, 1);
  }
});

test('requires valid macOS deployment metadata when a maximum is requested', (t) => {
  const files = { runtime: output({ executable: true }) };
  const { verify } = fixture(t, files);
  assert.equal(verify({ expectedArchitecture: 'arm64' }).files, 1);
  assert.throws(() => verify({ maxMacosVersion: '14.0' }), /runtime \(arm64\): missing macOS deployment target/);
  files.runtime = output({ executable: true, deploymentTargets: [{ platform: 'IOS', minimumVersion: '12.0' }] });
  assert.throws(() => verify({ maxMacosVersion: '14.0' }), /missing macOS deployment target/);
  files.runtime = output({ executable: true, deploymentTargets: [{ minimumVersion: 'invalid' }] });
  assert.throws(() => verify({ maxMacosVersion: '14.0' }), /LC_BUILD_VERSION: Invalid macOS version: invalid/);
  assert.throws(() => verify({ maxMacosVersion: '14.x' }), /Invalid macOS version: 14.x/);
  assert.throws(() => verify({ expectedArchitecture: 'x64' }), /Unsupported expected Mach-O architecture: x64/);
});

test('still checks external dependencies in universal slices outside the requested architecture', (t) => {
  const { verify } = fixture(t, {
    runtime: output({ architecture: 'X86_64', executable: true, deploymentTargets: [{ minimumVersion: '14.0' }] })
      + output({ executable: true, deploymentTargets: [{ minimumVersion: '15.0' }], dependencies: ['/opt/homebrew/lib/unsafe.dylib'] }),
  });
  assert.throws(() => verify({ expectedArchitecture: 'x86_64', maxMacosVersion: '14.0' }), /runtime \(arm64\): external absolute dependency \/opt\/homebrew\/lib\/unsafe.dylib/);
});

test('accepts Apple system dependencies without requiring files outside the bundle to exist', (t) => {
  const { verify } = fixture(t, { cottontail: output({ executable: true, dependencies: [
    '/usr/lib/libz.1.dylib', '/System/Library/Frameworks/Security.framework/Security',
    '/System/iOSSupport/System/Library/Frameworks/AppKit.framework/AppKit',
  ] }) });
  assert.equal(verify().files, 1);
});

test('accepts Apple system libraries selected through an absolute system rpath', (t) => {
  const { verify } = fixture(t, { runtime: output({
    executable: true, rpaths: ['/usr/lib/swift'], dependencies: ['@rpath/libswiftCore.dylib'],
  }) });
  assert.equal(verify().files, 1);
});

test('rejects hard build-machine dependencies in every packaged capability, including other universal slices', (t) => {
  const { verify } = fixture(t, {
    cottontail: output({ executable: true }),
    'capabilities/unrelated/name.dylib': output() + output({ architecture: 'X86_64', dependencies: [
      '/opt/homebrew/opt/brotli/lib/libbrotlidec.1.dylib', '/usr/local/lib/libother.dylib',
    ] }),
  });
  assert.throws(verify, /name\.dylib \(x86_64\): external absolute dependency \/opt\/homebrew/);
  assert.throws(verify, /external absolute dependency \/usr\/local\/lib\/libother\.dylib/);
});

test('rejects absolute paths even when they point to a library inside the staging directory', (t) => {
  const files = { cottontail: output({ executable: true }), 'libbundled.dylib': output() };
  const { root, verify } = fixture(t, files);
  files.cottontail = output({ executable: true, dependencies: [join(root, 'libbundled.dylib')] });
  assert.throws(verify, /external absolute dependency/);
});

test('allows missing weak CEF references but rejects the same strong reference', (t) => {
  const cef = '@executable_path/../Frameworks/Chromium Embedded Framework.framework/Chromium Embedded Framework';
  const files = {
    'Contents/MacOS/cottontail': output({ executable: true }),
    'Contents/MacOS/wrapper.dylib': output({ dependencies: [{ path: cef, command: 'LC_LOAD_WEAK_DYLIB' }] }),
  };
  const { verify } = fixture(t, files);
  assert.equal(verify().files, 2);
  files['Contents/MacOS/wrapper.dylib'] = output({ dependencies: [cef] });
  assert.throws(verify, /unresolved bundled dependency @executable_path\/\.\.\/Frameworks\/Chromium/);
});

test('resolves executable, loader, and inherited rpaths through a linked library chain', (t) => {
  const { verify } = fixture(t, {
    'bin/runtime': output({ executable: true, rpaths: ['@executable_path/../lib'], dependencies: ['@rpath/parent.dylib'] }),
    'lib/parent.dylib': output({ rpaths: ['@loader_path/nested'], dependencies: ['@rpath/child.dylib'] }),
    'lib/nested/child.dylib': output({ dependencies: ['@rpath/shared.dylib', '@loader_path/local.dylib'] }),
    'lib/shared.dylib': output(),
    'lib/nested/local.dylib': output(),
  });
  assert.equal(verify().files, 5);
});

test('checks dynamic plugins with bundled host rpaths and plugin loader rpaths', (t) => {
  const { verify } = fixture(t, {
    runtime: output({ executable: true, rpaths: ['@executable_path/lib'] }),
    'plugins/a-child.dylib': output({ dependencies: ['@rpath/shared.dylib'] }),
    'plugins/z-loader.dylib': output({ rpaths: ['@loader_path/nested'], dependencies: ['@loader_path/a-child.dylib'] }),
    'plugins/nested/shared.dylib': output(),
    'lib/other.dylib': output({ dependencies: ['@executable_path/runtime'] }),
  });
  assert.equal(verify().files, 5);
});

test('accepts internal framework symlinks and prevents external symlinks from satisfying a dependency', {
  skip: process.platform === 'win32' ? 'Windows file symlinks require developer mode or administrator privileges' : false,
}, (t) => {
  const { root, verify } = fixture(t, {
    runtime: output({ executable: true, dependencies: ['@loader_path/Library.framework/Library'] }),
    'Library.framework/Versions/A/Library': output(),
  });
  symlinkSync('Versions/A/Library', join(root, 'Library.framework/Library'));
  assert.equal(verify().files, 2);
  rmSync(join(root, 'Library.framework/Library'));
  const outside = mkdtempSync(join(tmpdir(), 'cottontail-host-dep-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'Library'), Buffer.from('cffaedfe', 'hex'));
  symlinkSync(join(outside, 'Library'), join(root, 'Library.framework/Library'));
  assert.throws(verify, /Native runtime entry leaves the staged directory/);
});

test('rejects an external native capability symlink even when it is loaded dynamically', {
  skip: process.platform === 'win32' ? 'Windows file symlinks require developer mode or administrator privileges' : false,
}, (t) => {
  const { root, verify } = fixture(t, { runtime: output({ executable: true }) });
  const outside = mkdtempSync(join(tmpdir(), 'cottontail-host-capability-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'capability'), Buffer.from('cffaedfe', 'hex'));
  symlinkSync(join(outside, 'capability'), join(root, 'capability.dylib'));
  assert.throws(verify, /Native runtime entry leaves the staged directory/);
});

test('rejects missing strong, wrong-architecture, and working-directory-dependent imports', (t) => {
  for (const dependency of ['@rpath/missing.dylib', '@loader_path/other.dylib', 'other.dylib']) {
    const { verify } = fixture(t, {
      runtime: output({ executable: true, dependencies: [dependency] }),
      'other.dylib': output({ architecture: 'X86_64' }),
    });
    assert.throws(verify, /unresolved bundled dependency/);
  }
});

test('handles cycles and verifies each executable rather than borrowing another executable’s layout', (t) => {
  const files = {
    'one/runtime': output({ executable: true, dependencies: ['@executable_path/lib.dylib'] }),
    'one/lib.dylib': output({ dependencies: ['@loader_path/lib.dylib'] }),
    'two/runtime': output({ executable: true }),
  };
  const { verify } = fixture(t, files);
  assert.equal(verify().files, 3);
  files['two/runtime'] = output({ executable: true, dependencies: ['@executable_path/lib.dylib'] });
  assert.throws(verify, /two\/runtime.*unresolved bundled dependency/);
});

test('does not treat normalized escapes from Apple system directories as system imports', (t) => {
  const { verify } = fixture(t, { runtime: output({ executable: true, dependencies: ['/usr/lib/../../opt/homebrew/lib/unsafe.dylib'] }) });
  assert.throws(verify, /external absolute dependency/);
});

test('fails closed for an empty staging directory and ignores ordinary non-native assets', (t) => {
  const { root, verify } = fixture(t, {});
  writeFileSync(join(root, 'main.js'), 'console.log("hello")');
  assert.throws(verify, /No Mach-O files found/);
});
