import assert from "node:assert/strict";
import test from "node:test";
import {
  checkLockfileFamilies,
  parseLockfile,
} from "./check-lockfile-families.mjs";

// pnpm 12 writes a package-manager document before the workspace document.
const PACKAGE_MANAGER_DOCUMENT = `---
lockfileVersion: '9.0'
importers:
  .:
    packageManagerDependencies:
      pnpm: {specifier: 12.18.0, version: 12.18.0}
packages:
  pnpm@12.18.0: {}
snapshots:
  pnpm@12.18.0: {}
`;

function lockfile(workspaceDocument) {
  return parseLockfile(`${PACKAGE_MANAGER_DOCUMENT}---\n${workspaceDocument}`);
}

test("reports a catalog family split with the importers that pull each version", () => {
  const errors = checkLockfileFamilies(
    lockfile(`lockfileVersion: '9.0'
catalogs:
  default:
    '@acme/node': {specifier: 10.0.0, version: 10.0.0}
importers:
  packages/app:
    dependencies:
      '@acme/node': {specifier: 'catalog:', version: 10.0.0}
      '@acme/lib': {specifier: workspace:*, version: file:packages/lib}
  packages/evals:
    devDependencies:
      roach: {specifier: ^1.0.0, version: 1.0.0}
snapshots:
  '@acme/node@10.0.0':
    dependencies:
      '@acme/core': 10.0.0
  '@acme/core@10.0.0': {}
  '@acme/lib@file:packages/lib':
    dependencies:
      '@acme/core': 10.0.0
  roach@1.0.0:
    dependencies:
      '@acme/node': 9.0.0(peer@1.0.0)
  '@acme/node@9.0.0(peer@1.0.0)':
    dependencies:
      '@acme/core': 9.0.0
  '@acme/core@9.0.0': {}
`),
  );
  assert.deepEqual(errors.slice(0, -1), [
    "@acme/* lockstep family resolves to 9.0.0, 10.0.0. Each copy loads its own module state.",
    "  9.0.0: @acme/core, @acme/node",
    "    packages/evals > roach@1.0.0 > @acme/node@9.0.0",
    "  10.0.0 (catalog): @acme/core, @acme/node",
    "    packages/app > @acme/node@10.0.0",
  ]);
  assert.match(errors.at(-1), /`pnpm update -r @acme\/node`/);
});

test("ignores snapshots that no importer reaches", () => {
  assert.deepEqual(
    checkLockfileFamilies(
      lockfile(`lockfileVersion: '9.0'
catalogs:
  default:
    '@acme/node': {specifier: 2.0.0, version: 2.0.0}
importers:
  packages/app:
    dependencies:
      '@acme/node': {specifier: 'catalog:', version: 2.0.0}
snapshots:
  '@acme/node@2.0.0':
    dependencies:
      '@acme/core': 2.0.0
  '@acme/core@2.0.0': {}
  '@acme/node@1.0.0':
    dependencies:
      '@acme/core': 1.0.0
  '@acme/core@1.0.0': {}
`),
    ),
    [],
  );
});

test("ignores copies outside catalog families", () => {
  assert.deepEqual(
    checkLockfileFamilies(
      lockfile(`lockfileVersion: '9.0'
catalogs:
  default:
    '@acme/node': {specifier: 2.0.0, version: 2.0.0}
    '@types/node': {specifier: ^24.0.0, version: 24.1.0}
    zod: {specifier: ^4.0.0, version: 4.2.0}
importers:
  packages/app:
    dependencies:
      '@acme/node': {specifier: 'catalog:', version: 2.0.0}
snapshots:
  '@acme/node@2.0.0':
    dependencies:
      '@acme/core': 2.0.0
      '@acme/conventions': 0.2.0
  '@acme/core@2.0.0': {}
  '@acme/conventions@0.1.0': {}
  '@acme/conventions@0.2.0': {}
  '@types/node@24.1.0': {}
  '@types/node@22.0.0': {}
  zod@3.0.0: {}
  zod@4.2.0: {}
  '@aws-sdk/client@3.2.0':
    dependencies:
      '@aws-sdk/core': 3.2.0
  '@aws-sdk/client@3.1.0':
    dependencies:
      '@aws-sdk/core': 3.1.0
  '@aws-sdk/core@3.1.0': {}
  '@aws-sdk/core@3.2.0': {}
`),
    ),
    [],
  );
});
