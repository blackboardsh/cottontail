import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildArchiveKey,
  channelManifestKey,
  createBuildManifest,
  createChannelManifest,
  createReleaseManifest,
  parseSemver,
  releaseChannel,
  releaseManifestKey,
  validateReleaseTag,
  validateRevision,
} from './release-contract.js';

const revision = '0123456789abcdef0123456789abcdef01234567';
const publishedAt = '2026-07-25T12:00:00.000Z';
const publicBaseUrl = 'https://artifacts.example.test';
const artifacts = [
  ['windows-x64', 'a'],
  ['linux-arm64', 'b'],
  ['macos-arm64', 'c'],
  ['linux-x64', 'd'],
].map(([platform, digit], index) => ({
  platform,
  sha256: digit.repeat(64),
  size: 100 + index,
}));

test('classifies production and canary release targets', () => {
  assert.equal(releaseChannel('1.2.3'), 'production');
  assert.equal(releaseChannel('1.2.3-canary.7'), 'canary');
  assert.equal(releaseChannel('1.2.3-rc.1+build.4'), 'canary');
  assert.deepEqual(parseSemver('0.1.0-beta.1')?.prerelease, ['beta', '1']);
});

test('rejects malformed versions and mismatched tags', () => {
  for (const invalid of ['v1.2.3', '1.2', '01.2.3', '1.2.3-']) {
    assert.throws(() => releaseChannel(invalid), /Invalid semantic version/);
  }
  assert.throws(
    () => validateReleaseTag('v1.2.4', '1.2.3'),
    /does not match package version/,
  );
  assert.deepEqual(validateReleaseTag('v1.2.3', '1.2.3'), {
    tag: 'v1.2.3',
    version: '1.2.3',
    channel: 'production',
  });
});

test('requires full Git revisions', () => {
  assert.equal(validateRevision(revision), revision);
  assert.throws(() => validateRevision('0123456'), /full Git revision/);
});

test('uses one immutable build archive location for all manifests', () => {
  const options = {
    product: 'cottontail',
    version: '1.2.3-canary.4',
    revision,
    publishedAt,
    publicBaseUrl,
    artifacts,
  };
  const build = createBuildManifest(options);
  const release = createReleaseManifest(options);
  const channel = createChannelManifest(options);

  const archiveUrl = `${publicBaseUrl}/${buildArchiveKey('cottontail', revision, 'macos-arm64')}`;
  assert.equal(build.platforms['macos-arm64'].archive.url, archiveUrl);
  assert.equal(release.platforms['macos-arm64'].archive.url, archiveUrl);
  assert.equal(release.channel, 'canary');
  assert.equal(
    release.build.url,
    `${publicBaseUrl}/cottontail/builds/${revision}/manifest.json`,
  );
  assert.equal(
    channel.release.url,
    `${publicBaseUrl}/${releaseManifestKey('cottontail', '1.2.3-canary.4')}`,
  );
  assert.equal(channelManifestKey('cottontail', 'canary'), 'cottontail/channels/canary.json');
});

test('requires one artifact for every supported platform', () => {
  assert.throws(
    () => createBuildManifest({
      product: 'cottontail',
      version: '1.2.3',
      revision,
      publishedAt,
      publicBaseUrl,
      artifacts: artifacts.slice(1),
    }),
    /missing: windows-x64/,
  );
});
