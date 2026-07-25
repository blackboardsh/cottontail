const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const revisionPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export const RELEASE_SCHEMA = 1;
export const RELEASE_PLATFORMS = [
  'macos-arm64',
  'linux-x64',
  'linux-arm64',
  'windows-x64',
];

export function parseSemver(version) {
  if (typeof version !== 'string') return null;
  const match = version.match(semverPattern);
  if (!match) return null;
  return {
    version,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split('.') ?? [],
    build: match[5]?.split('.') ?? [],
  };
}

export function releaseChannel(version) {
  const parsed = parseSemver(version);
  if (!parsed) throw new Error(`Invalid semantic version: ${version}`);
  return parsed.prerelease.length === 0 ? 'stable' : 'canary';
}

export function validateReleaseTag(tag, version) {
  releaseChannel(version);
  const expected = `v${version}`;
  if (tag !== expected) {
    throw new Error(`Release tag ${JSON.stringify(tag)} does not match package version ${expected}`);
  }
  return {
    tag,
    version,
    channel: releaseChannel(version),
  };
}

export function validateRevision(revision) {
  if (!revisionPattern.test(revision)) {
    throw new Error(`Expected a full Git revision, received ${JSON.stringify(revision)}`);
  }
  return revision;
}

export function buildArchiveKey(product, revision, platform) {
  validateRevision(revision);
  validatePlatform(platform);
  return `${product}/builds/${revision}/${platform}/${product}.tar.gz`;
}

export function buildManifestKey(product, revision) {
  validateRevision(revision);
  return `${product}/builds/${revision}/manifest.json`;
}

export function releaseManifestKey(product, version) {
  releaseChannel(version);
  return `${product}/releases/${version}/manifest.json`;
}

export function channelManifestKey(product, channel) {
  validateChannel(channel);
  return `${product}/channels/${channel}.json`;
}

export function createBuildManifest({
  product,
  version,
  revision,
  publishedAt,
  publicBaseUrl,
  artifacts,
}) {
  releaseChannel(version);
  validateRevision(revision);
  return {
    schema: RELEASE_SCHEMA,
    kind: 'build',
    product,
    version,
    revision,
    publishedAt,
    platforms: createPlatformManifest({
      product,
      revision,
      publicBaseUrl,
      artifacts,
    }),
  };
}

export function createReleaseManifest({
  product,
  version,
  revision,
  publishedAt,
  publicBaseUrl,
  artifacts,
}) {
  const channel = releaseChannel(version);
  validateRevision(revision);
  return {
    schema: RELEASE_SCHEMA,
    kind: 'release',
    product,
    channel,
    version,
    revision,
    publishedAt,
    build: {
      url: publicUrl(publicBaseUrl, buildManifestKey(product, revision)),
    },
    platforms: createPlatformManifest({
      product,
      revision,
      publicBaseUrl,
      artifacts,
    }),
  };
}

export function createChannelManifest({
  product,
  version,
  revision,
  publishedAt,
  publicBaseUrl,
}) {
  const channel = releaseChannel(version);
  validateRevision(revision);
  return {
    schema: RELEASE_SCHEMA,
    kind: 'channel',
    product,
    channel,
    version,
    revision,
    updatedAt: publishedAt,
    release: {
      url: publicUrl(publicBaseUrl, releaseManifestKey(product, version)),
    },
  };
}

function createPlatformManifest({
  product,
  revision,
  publicBaseUrl,
  artifacts,
}) {
  const byPlatform = new Map(artifacts.map((artifact) => [artifact.platform, artifact]));
  const missing = RELEASE_PLATFORMS.filter((platform) => !byPlatform.has(platform));
  const extra = [...byPlatform.keys()].filter((platform) => !RELEASE_PLATFORMS.includes(platform));
  if (missing.length > 0 || extra.length > 0 || byPlatform.size !== artifacts.length) {
    throw new Error([
      'Release artifact matrix is invalid.',
      missing.length > 0 ? `missing: ${missing.join(', ')}` : null,
      extra.length > 0 ? `unsupported: ${extra.join(', ')}` : null,
      byPlatform.size !== artifacts.length ? 'duplicate platform entries are not allowed' : null,
    ].filter(Boolean).join(' '));
  }

  return Object.fromEntries(RELEASE_PLATFORMS.map((platform) => {
    const artifact = byPlatform.get(platform);
    if (!/^[0-9a-f]{64}$/.test(artifact.sha256)) {
      throw new Error(`Invalid SHA-256 for ${platform}`);
    }
    if (!Number.isSafeInteger(artifact.size) || artifact.size <= 0) {
      throw new Error(`Invalid archive size for ${platform}`);
    }
    return [platform, {
      archive: {
        url: publicUrl(publicBaseUrl, buildArchiveKey(product, revision, platform)),
        sha256: artifact.sha256,
        size: artifact.size,
      },
    }];
  }));
}

function publicUrl(publicBaseUrl, key) {
  return `${publicBaseUrl.replace(/\/+$/, '')}/${key}`;
}

function validatePlatform(platform) {
  if (!RELEASE_PLATFORMS.includes(platform)) {
    throw new Error(`Unsupported release platform: ${platform}`);
  }
}

function validateChannel(channel) {
  if (channel !== 'stable' && channel !== 'canary') {
    throw new Error(`Unsupported release channel: ${channel}`);
  }
}
