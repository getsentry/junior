import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createReleaseManifest,
  RELEASE_MANIFEST,
} from "./release-artifacts.mjs";

// The GitHub CLI is the only fake. Packaging, git, validation, and pnpm are real.
test("leaves failed verification in draft, resumes it, and never changes a published release", (t) => {
  const root = mkdtempSync(join(tmpdir(), "junior-publish-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const artifacts = join(root, "artifacts");
  const bin = join(root, "bin");
  const source = join(root, "packages/junior");
  const staging = join(root, "staging/package");
  for (const directory of [artifacts, bin, source, staging])
    mkdirSync(directory, { recursive: true });
  const pkg = { name: "@sentry/junior", version: "1.2.3" };
  writeFileSync(join(source, "package.json"), JSON.stringify(pkg));
  writeFileSync(join(staging, "package.json"), JSON.stringify(pkg));
  writeFileSync(
    join(root, "CHANGELOG.md"),
    "# Changelog\n## 1.2.3\n\nRelease notes.\n\n## 1.2.2\nOld notes.\n",
  );
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init");
  git("add", ".");
  git(
    "-c",
    "user.name=Release test",
    "-c",
    "user.email=release@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "Release fixture",
  );
  git("tag", "1.2.3");
  const commit = git("rev-parse", "HEAD");
  execFileSync("tar", [
    "-czf",
    join(artifacts, "sentry-junior-1.2.3.tgz"),
    "-C",
    join(root, "staging"),
    "package",
  ]);
  writeFileSync(
    join(artifacts, RELEASE_MANIFEST),
    JSON.stringify(createReleaseManifest(root, artifacts, commit)),
  );
  const stateFile = join(bin, "state.json");
  const save = (state) => writeFileSync(stateFile, JSON.stringify(state));
  const read = () => JSON.parse(readFileSync(stateFile, "utf8"));
  save({ commit, assets: [], corrupt: true, mutations: [] });
  writeFileSync(
    join(bin, "gh"),
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const file = path.join(__dirname, 'state.json');
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
const endpoint = args[1];
let result;
if (args[0] === 'release' && args[1] === 'upload') {
  for (const file of args.slice(3, args.indexOf('--repo'))) {
    const name = path.basename(file);
    if (state.assets.some(asset => asset.name === name)) throw new Error('Duplicate upload');
    state.assets.push({id: state.assets.length + 1, name, state: 'uploaded', size: fs.statSync(file).size, bytes: fs.readFileSync(file).toString('base64')});
  }
  state.mutations.push('upload');
} else if (endpoint.includes('/releases?')) {
  process.stdout.write(state.release ? JSON.stringify(state.release) : '');
  process.exit(0);
} else if (endpoint.endsWith('/releases') && args.includes('POST')) {
  state.release = {id: 1, ...JSON.parse(fs.readFileSync(0, 'utf8'))};
  state.mutations.push('draft');
  result = state.release;
} else if (endpoint.includes('/releases/1/assets?')) {
  result = [state.assets.map(({bytes, ...asset}) => asset)];
} else if (endpoint.includes('/releases/assets/')) {
  const asset = state.assets.find(asset => asset.id === Number(endpoint.split('/').at(-1)));
  fs.writeFileSync(file, JSON.stringify(state));
  process.stdout.write(state.corrupt ? Buffer.from('corrupt bytes') : Buffer.from(asset.bytes, 'base64'));
  process.exit(0);
} else if (endpoint.endsWith('/commits/1.2.3')) {
  process.stdout.write(state.commit);
  process.exit(0);
} else if (endpoint.endsWith('/releases/1') && args.includes('PATCH')) {
  Object.assign(state.release, JSON.parse(fs.readFileSync(0, 'utf8')));
  state.mutations.push('publish');
  result = state.release;
} else {
  throw new Error('Unexpected GitHub call: ' + args.join(' '));
}
fs.writeFileSync(file, JSON.stringify(state));
process.stdout.write(JSON.stringify(result ?? {}));
`,
    { mode: 0o755 },
  );
  const run = () =>
    spawnSync(
      process.execPath,
      [
        join(import.meta.dirname, "publish-github-release.mjs"),
        "1.2.3",
        artifacts,
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          GITHUB_REPOSITORY: "getsentry/junior",
        },
        encoding: "utf8",
      },
    );

  const failed = run();
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /GitHub asset differs from CI/);
  let state = read();
  assert.equal(state.release.draft, true);
  assert.equal(state.release.body, "Release notes.");
  assert.deepEqual(state.mutations, ["draft", "upload"]);

  state.corrupt = false;
  // Model an interrupted upload. Resume must upload only the missing file.
  state.assets.pop();
  state.commit = "b".repeat(40);
  save(state);
  const movedTag = run();
  assert.notEqual(movedTag.status, 0);
  assert.match(movedTag.stderr, /Release tag moved during verification/);
  state = read();
  assert.equal(state.release.draft, true);
  assert.deepEqual(state.mutations, ["draft", "upload", "upload"]);

  state.commit = commit;
  save(state);
  const resumed = run();
  assert.equal(resumed.status, 0, resumed.stderr + resumed.stdout);
  state = read();
  assert.equal(state.release.draft, false);
  assert.deepEqual(state.mutations, ["draft", "upload", "upload", "publish"]);

  const repeated = run();
  assert.equal(repeated.status, 0, repeated.stderr + repeated.stdout);
  assert.deepEqual(read().mutations, state.mutations);

  state.assets.pop();
  save(state);
  const incomplete = run();
  assert.notEqual(incomplete.status, 0);
  assert.match(incomplete.stderr, /Published release is incomplete/);
  assert.deepEqual(read().mutations, state.mutations);
});
