#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const root = process.cwd();
const publicBase = 'https://electrobun-artifacts.blackboard.sh';
const requested = process.argv[2]?.trim();
const manifestUrl = !requested
  ? `${publicBase}/jsc/latest.json`
  : /^https:\/\//.test(requested)
    ? requested
    : `${publicBase}/jsc/releases/${encodeURIComponent(requested)}/manifest.json`;

const response = await fetch(manifestUrl, { headers: { accept: 'application/json' } });
if (!response.ok) throw new Error(`Could not fetch ${manifestUrl}: HTTP ${response.status}`);
const release = await response.json();

if (
  release.schema !== 1 ||
  !/^WebKit-[A-Za-z0-9._-]+$/.test(release.webkitRef) ||
  !/^[0-9a-f]{40}$/.test(release.webkitSha) ||
  !/^[0-9a-f]{40}$/.test(release.revision)
) {
  throw new Error(`Invalid JSC release manifest at ${manifestUrl}`);
}

const currentPath = join(root, 'scripts', 'jsc-manifest.json');
const current = JSON.parse(readFileSync(currentPath, 'utf8'));
const platformMap = {
  'macos-arm64': 'macos-arm64',
  'linux-amd64': 'linux-x64',
  'linux-arm64': 'linux-arm64',
  'windows-amd64': 'windows-x64',
};
const assets = {};
for (const [local, published] of Object.entries(platformMap)) {
  const archive = release.platforms?.[published]?.archive;
  if (!archive || !/^https:\/\//.test(archive.url) || !/^[0-9a-f]{64}$/.test(archive.sha256)) {
    throw new Error(`JSC release is missing a valid ${published} archive`);
  }
  assets[local] = {
    name: `cottontail-jsc-${local}.tar.gz`,
    url: archive.url,
    sha256: archive.sha256,
  };
}

const data = release.icu?.data;
if (
  release.icu?.version !== current.icuFallback.version ||
  release.icu?.abi !== current.icuFallback.abi ||
  !data ||
  !/^https:\/\//.test(data.url) ||
  data.sha256 !== current.icuFallback.dataSha256 ||
  data.size !== current.icuFallback.dataSize
) {
  throw new Error('Published JSC ICU contract does not match Cottontail');
}

const tag = `jsc-${release.webkitRef}-${release.revision.slice(0, 12)}`;
const next = {
  repo: current.repo,
  tag,
  upstreamTag: release.webkitRef,
  upstreamCommit: release.webkitSha,
  jscBuildRevision: release.revision,
  icuFallback: {
    ...current.icuFallback,
    dataUrl: data.url,
  },
  assets,
};
writeFileSync(currentPath, `${JSON.stringify(next, null, 2)}\n`);

const buildPath = join(root, 'build.zig');
const build = readFileSync(buildPath, 'utf8');
const updated = build.replace(
  /const jsc_vendor_tag = "[^"]+";/,
  `const jsc_vendor_tag = "${tag}";`
);
if (updated === build) throw new Error(`Could not update ${basename(buildPath)} JSC vendor tag`);
writeFileSync(buildPath, updated);

console.log(`Pinned ${release.webkitRef} (${release.webkitSha}) from JSC build ${release.revision}`);
