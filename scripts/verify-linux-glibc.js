#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function compareVersions(left, right) {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export function glibcRequirements(binary) {
  const source = binary.toString('latin1');
  const versions = new Set();
  for (const match of source.matchAll(/GLIBC_(\d+(?:\.\d+)*)/g)) {
    versions.add(match[1]);
  }
  return {
    versions: [...versions].sort(compareVersions),
    privateAbi: source.includes('GLIBC_PRIVATE'),
  };
}

export function verifyLinuxGlibc(binaryPath, maximum) {
  if (!/^\d+(?:\.\d+)*$/.test(maximum)) {
    throw new Error(`invalid maximum glibc version: ${maximum}`);
  }

  const { versions, privateAbi } = glibcRequirements(readFileSync(binaryPath));
  if (privateAbi) {
    throw new Error(`${binaryPath} requires the unstable GLIBC_PRIVATE ABI`);
  }
  if (versions.length === 0) {
    throw new Error(`${binaryPath} does not declare any GLIBC symbol versions`);
  }

  const unsupported = versions.filter(
    (version) => compareVersions(version, maximum) > 0,
  );
  if (unsupported.length > 0) {
    throw new Error(
      `${binaryPath} requires GLIBC_${unsupported.at(-1)}, above GLIBC_${maximum}`,
    );
  }
  return versions.at(-1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , binaryPath, maximum] = process.argv;
  if (!binaryPath || !maximum) {
    console.error('Usage: verify-linux-glibc.js <ELF path> <maximum version>');
    process.exit(2);
  }
  try {
    const observed = verifyLinuxGlibc(binaryPath, maximum);
    console.log(`OK ${binaryPath} requires at most GLIBC_${observed}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
