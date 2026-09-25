import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
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
  verifyReleaseArtifacts,
  verifyReleaseInstall,
} from "./release-artifacts.mjs";

const commit = "a".repeat(40);
const version = "1.2.3";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "junior-release-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, "artifacts");
  mkdirSync(directory);
  const packages = [
    {
      name: "@sentry/junior",
      version,
      dependencies: { "@sentry/junior-plugin-api": version },
    },
    { name: "@sentry/junior-plugin-api", version },
  ];
  for (const pkg of packages) {
    const source = join(root, "packages", pkg.name.split("/")[1]);
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "package.json"), JSON.stringify(pkg));
  }
  const pack = (
    pkg,
    file = `${pkg.name.replace("@", "").replace("/", "-")}-${pkg.version}.tgz`,
  ) => {
    const staging = join(root, "staging");
    mkdirSync(join(staging, "package"), { recursive: true });
    writeFileSync(
      join(staging, "package", "package.json"),
      JSON.stringify(pkg),
    );
    execFileSync("tar", [
      "-czf",
      join(directory, file),
      "-C",
      staging,
      "package",
    ]);
    return join(directory, file);
  };
  packages.forEach((pkg) => pack(pkg));
  const manifest = createReleaseManifest(root, directory, commit);
  writeFileSync(join(directory, RELEASE_MANIFEST), JSON.stringify(manifest));
  return { root, directory, packages, pack, manifest };
}

test("verifies a complete release and installs it without the workspace or registry", (t) => {
  const { root, directory, manifest } = fixture(t);
  const verified = verifyReleaseArtifacts(root, directory, commit);
  assert.equal(verified.packages.length, 2);
  assert.deepEqual(verified.packages[0].dependencies, {
    "@sentry/junior-plugin-api": version,
  });
  for (const pkg of verified.packages) {
    assert.equal(
      pkg.sha256,
      createHash("sha256")
        .update(readFileSync(join(directory, pkg.file)))
        .digest("hex"),
    );
  }
  verifyReleaseInstall(directory, manifest);
});

test("rejects incomplete, duplicate, or inconsistent package sets", async (t) => {
  const cases = [
    [
      "missing",
      ({ directory, manifest }) =>
        rmSync(join(directory, manifest.packages[1].file)),
      /Missing release packages/,
    ],
    [
      "duplicate",
      ({ directory, manifest }) =>
        copyFileSync(
          join(directory, manifest.packages[0].file),
          join(directory, "duplicate.tgz"),
        ),
      /Unexpected tarball filename|duplicate package/,
    ],
    [
      "wrong version",
      ({ packages, pack, manifest }) =>
        pack({ ...packages[0], version: "1.2.2" }, manifest.packages[0].file),
      /Wrong packed version/,
    ],
    [
      "missing dependency",
      ({ packages, pack }) =>
        pack({
          ...packages[0],
          dependencies: { "@sentry/junior-missing": version },
        }),
      /Missing release dependency/,
    ],
    [
      "wrong dependency version",
      ({ packages, pack }) =>
        pack({
          ...packages[0],
          dependencies: { "@sentry/junior-plugin-api": "1.2.2" },
        }),
      /Wrong release dependency/,
    ],
    [
      "unresolved workspace",
      ({ packages, pack }) =>
        pack({
          ...packages[0],
          dependencies: { "@sentry/junior-plugin-api": "workspace:*" },
        }),
      /Unresolved dependency/,
    ],
  ];
  for (const [name, change, error] of cases) {
    await t.test(name, (t) => {
      const files = fixture(t);
      change(files);
      assert.throws(
        () => createReleaseManifest(files.root, files.directory, commit),
        error,
      );
    });
  }
});

test("rejects changed bytes and a manifest from a different commit", (t) => {
  const { root, directory, manifest, packages, pack } = fixture(t);
  assert.throws(
    () => verifyReleaseArtifacts(root, directory, "b".repeat(40)),
    /manifest does not match/,
  );
  pack(
    { ...packages[0], description: "Changed after packaging" },
    manifest.packages[0].file,
  );
  assert.throws(
    () => verifyReleaseArtifacts(root, directory, commit),
    /manifest does not match/,
  );
});
