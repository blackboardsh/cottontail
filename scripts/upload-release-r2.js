#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

import {
  RELEASE_PLATFORMS,
  buildArchiveKey,
  buildManifestKey,
  channelManifestKey,
  createBuildManifest,
  createChannelManifest,
  createReleaseManifest,
  releaseManifestKey,
  validateReleaseTag,
  validateRevision,
} from './release-contract.js';

const rootDir = process.cwd();
const packageJson = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));
const dryRun = process.argv.includes('--dry-run') || process.env.COTTONTAIL_R2_DRY_RUN === '1';
const publishAll = process.argv.includes('--all');
const bucket = 'electrobun-artifacts';
const product = 'cottontail';

function fail(message) {
  console.error(`cottontail publish: ${message}`);
  process.exit(1);
}

function gitRevision() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: rootDir,
      encoding: 'utf8',
    }).trim();
  } catch {
    return fail('unable to determine the release revision');
  }
}

function releaseTag() {
  if (process.env.GITHUB_REF_TYPE === 'tag') return process.env.GITHUB_REF_NAME;
  const argument = process.argv.find((value) => value.startsWith('--tag='));
  if (argument) return argument.slice('--tag='.length);
  if (dryRun) return `v${packageJson.version}`;
  return fail('publishing is only allowed from a release tag');
}

function sha256(value, encoding = 'hex') {
  return createHash('sha256').update(value).digest(encoding);
}

function hmac(key, value) {
  return createHmac('sha256', key).update(value).digest();
}

function awsEncode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function signingHeaders({
  accountId,
  accessKeyId,
  secretAccessKey,
  bucket: bucketName,
  key,
  body,
  contentType,
  cacheControl,
  now = new Date(),
}) {
  const endpoint = new URL(`https://${accountId}.r2.cloudflarestorage.com`);
  const canonicalUri = `/${[bucketName, ...key.split('/')].map(awsEncode).join('/')}`;
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const payloadHash = sha256(body);
  const canonicalHeaders = [
    `cache-control:${cacheControl}`,
    `content-type:${contentType}`,
    `host:${endpoint.host}`,
    `x-amz-content-sha256:${payloadHash}`,
    `x-amz-date:${amzDate}`,
    '',
  ].join('\n');
  const signedHeaders = 'cache-control;content-type;host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = ['PUT', canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${date}/auto/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256(canonicalRequest),
  ].join('\n');
  const dateKey = hmac(Buffer.from(`AWS4${secretAccessKey}`), date);
  const regionKey = hmac(dateKey, 'auto');
  const serviceKey = hmac(regionKey, 's3');
  const signingKey = hmac(serviceKey, 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  return {
    url: new URL(canonicalUri, endpoint).href,
    headers: {
      Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      'Cache-Control': cacheControl,
      'Content-Type': contentType,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    },
  };
}

async function putObject(config, object) {
  if (dryRun) {
    console.log(`dry-run PUT ${object.key} (${object.body.length} bytes, ${object.contentType})`);
    return;
  }

  const request = signingHeaders({ ...config, ...object });
  const response = await fetch(request.url, {
    method: 'PUT',
    headers: request.headers,
    body: object.body,
  });
  if (!response.ok) {
    const details = await response.text();
    throw new Error(
      `R2 upload failed for ${object.key}: ${response.status} ${response.statusText}\n${details}`,
    );
  }
  console.log(`uploaded ${object.key}`);
}

function readArtifact(platform) {
  const archiveName = `cottontail-v${packageJson.version}-${platform}.tar.gz`;
  const archivePath = join(rootDir, 'release', archiveName);
  const checksumPath = `${archivePath}.sha256`;
  if (!existsSync(archivePath) || !existsSync(checksumPath)) {
    fail(`release matrix is incomplete; missing ${archivePath} or its checksum`);
  }

  const archive = readFileSync(archivePath);
  const checksumFile = readFileSync(checksumPath);
  const checksum = sha256(archive);
  const recordedChecksum = checksumFile.toString('utf8').trim().split(/\s+/, 1)[0];
  if (checksum !== recordedChecksum) fail(`release checksum mismatch for ${basename(archivePath)}`);

  return {
    platform,
    archivePath,
    checksumFile,
    sha256: checksum,
    size: statSync(archivePath).size,
  };
}

function jsonBody(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

if (!publishAll) fail('publishing requires --all and a complete platform matrix');

const requiredVariables = [
  'COTTONTAIL_R2_ACCOUNT_ID',
  'COTTONTAIL_R2_ACCESS_KEY_ID',
  'COTTONTAIL_R2_SECRET_ACCESS_KEY',
  'COTTONTAIL_R2_PUBLIC_BASE_URL',
];
if (!dryRun) {
  const missing = requiredVariables.filter((name) => !process.env[name]);
  if (missing.length > 0) fail(`missing required R2 environment variables: ${missing.join(', ')}`);
}

const version = packageJson.version;
const revision = gitRevision();
let release;
try {
  validateRevision(revision);
  release = validateReleaseTag(releaseTag(), version);
} catch (error) {
  fail(error.message);
}

const publicBaseUrl = (
  process.env.COTTONTAIL_R2_PUBLIC_BASE_URL ?? 'https://artifacts.invalid'
).replace(/\/+$/, '');
const artifacts = RELEASE_PLATFORMS.map(readArtifact);
const publishedAt = new Date().toISOString();
const manifestOptions = {
  product,
  version,
  revision,
  publishedAt,
  publicBaseUrl,
  artifacts,
};
const buildManifest = jsonBody(createBuildManifest(manifestOptions));
const versionManifest = jsonBody(createReleaseManifest(manifestOptions));
const channelManifest = jsonBody(createChannelManifest(manifestOptions));
const config = {
  accountId: process.env.COTTONTAIL_R2_ACCOUNT_ID ?? 'dry-run-account',
  accessKeyId: process.env.COTTONTAIL_R2_ACCESS_KEY_ID ?? 'dry-run-access-key',
  secretAccessKey: process.env.COTTONTAIL_R2_SECRET_ACCESS_KEY ?? 'dry-run-secret',
  bucket,
};
const immutable = 'public, max-age=31536000, immutable';
const mutable = 'no-cache, no-store, must-revalidate';

for (const artifact of artifacts) {
  const archiveKey = buildArchiveKey(product, revision, artifact.platform);
  await putObject(config, {
    key: archiveKey,
    body: readFileSync(artifact.archivePath),
    contentType: 'application/gzip',
    cacheControl: immutable,
  });
  await putObject(config, {
    key: `${archiveKey}.sha256`,
    body: artifact.checksumFile,
    contentType: 'text/plain; charset=utf-8',
    cacheControl: immutable,
  });
}

await putObject(config, {
  key: buildManifestKey(product, revision),
  body: buildManifest,
  contentType: 'application/json; charset=utf-8',
  cacheControl: immutable,
});
await putObject(config, {
  key: releaseManifestKey(product, version),
  body: versionManifest,
  contentType: 'application/json; charset=utf-8',
  cacheControl: immutable,
});

// The mutable channel pointer is deliberately last. A failed matrix or manifest
// upload can leave unused immutable objects, but it cannot publish a partial release.
await putObject(config, {
  key: channelManifestKey(product, release.channel),
  body: channelManifest,
  contentType: 'application/json; charset=utf-8',
  cacheControl: mutable,
});

console.log(JSON.stringify({
  product,
  channel: release.channel,
  version,
  revision,
  platforms: RELEASE_PLATFORMS,
}, null, 2));
