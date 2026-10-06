/** Release package validation. CI and GitHub publication use the same checks. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const RELEASE_MANIFEST = "junior-release.json";
const dependencySections = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
];
const isJunior = (name) =>
  name === "@sentry/junior" || name.startsWith("@sentry/junior-");

/** Read the release package set from its source of truth, not another package list. */
function readReleasePackages(root) {
  return readdirSync(join(root, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const directory = join(root, "packages", entry.name);
      if (!readdirSync(directory).includes("package.json")) return [];
      const pkg = JSON.parse(
        readFileSync(join(directory, "package.json"), "utf8"),
      );
      return pkg.private === true ? [] : [pkg];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Check packed names, versions, and dependencies before writing a release manifest. */
export function createReleaseManifest(root, directory, commit) {
  assert.match(commit, /^[a-f0-9]{40}$/, "Expected the full release commit");
  const expected = readReleasePackages(root);
  assert.ok(expected.length > 0, "No publishable packages");
  const version = expected[0].version;
  assert.match(
    version,
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/,
    "Invalid release version",
  );
  const names = new Set(expected.map((pkg) => pkg.name));
  assert.equal(names.size, expected.length, "Duplicate source package");
  for (const pkg of expected) {
    assert.ok(isJunior(pkg.name), `Unexpected release package: ${pkg.name}`);
    assert.equal(pkg.version, version, `Mixed source version: ${pkg.name}`);
  }

  const packages = readdirSync(directory)
    .filter((file) => file.endsWith(".tgz"))
    .map((file) => {
      const archive = join(directory, file);
      const pkg = JSON.parse(
        execFileSync("tar", ["-xOzf", archive, "package/package.json"], {
          encoding: "utf8",
        }),
      );
      assert.ok(
        names.delete(pkg.name),
        `Unexpected or duplicate package: ${pkg.name}`,
      );
      assert.equal(pkg.version, version, `Wrong packed version: ${pkg.name}`);
      assert.equal(
        file,
        `${pkg.name.replace("@", "").replaceAll("/", "-")}-${version}.tgz`,
        "Unexpected tarball filename",
      );
      const dependencies = {};
      for (const section of dependencySections) {
        for (const [name, specifier] of Object.entries(pkg[section] ?? {})) {
          assert.ok(
            !/^(workspace|catalog|file|link):/.test(specifier),
            `Unresolved dependency: ${pkg.name} -> ${name}`,
          );
          if (!isJunior(name)) continue;
          assert.ok(
            expected.some((candidate) => candidate.name === name),
            `Missing release dependency: ${name}`,
          );
          // Junior packages use workspace:* and release in lockstep. Fail closed if that changes.
          assert.equal(
            specifier,
            version,
            `Wrong release dependency: ${pkg.name} -> ${name}`,
          );
          dependencies[name] = specifier;
        }
      }
      return {
        name: pkg.name,
        version,
        file,
        sha256: createHash("sha256")
          .update(readFileSync(archive))
          .digest("hex"),
        dependencies,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  assert.equal(
    names.size,
    0,
    `Missing release packages: ${[...names].join(", ")}`,
  );
  return { version, commit, packages };
}

/** Verify downloaded bytes and package metadata against the CI manifest. */
export function verifyReleaseArtifacts(root, directory, commit) {
  const manifest = JSON.parse(
    readFileSync(join(directory, RELEASE_MANIFEST), "utf8"),
  );
  assert.deepEqual(
    createReleaseManifest(root, directory, commit),
    manifest,
    "Release manifest does not match the tarballs or source commit",
  );
  return manifest;
}

/** Install the complete package set outside the workspace with no Junior registry fallback. */
export function verifyReleaseInstall(directory, manifest) {
  const consumer = mkdtempSync(join(tmpdir(), "junior-release-install-"));
  try {
    const dependencies = Object.fromEntries(
      manifest.packages.map((pkg) => [
        pkg.name,
        `file:${resolve(directory, pkg.file)}`,
      ]),
    );
    writeFileSync(
      join(consumer, "package.json"),
      JSON.stringify({ private: true, dependencies }),
    );
    writeFileSync(
      join(consumer, "pnpm-workspace.yaml"),
      `overrides: ${JSON.stringify(dependencies)}\nautoInstallPeers: false\n`,
    );
    // A separate store proves this install does not depend on workspace links or cached Junior packages.
    execFileSync(
      "pnpm",
      [
        "install",
        "--ignore-scripts",
        "--no-frozen-lockfile",
        "--store-dir",
        join(consumer, "store"),
      ],
      { cwd: consumer, stdio: "inherit" },
    );
    const lockfile = readFileSync(join(consumer, "pnpm-lock.yaml"), "utf8");
    assert.ok(
      !/@sentry\/junior(?:-[a-z0-9._-]+)?@\d/.test(lockfile),
      "Junior package resolved through the registry",
    );
    // Prove a frozen install reconstructs node_modules, not merely accepts an existing install.
    rmSync(join(consumer, "node_modules"), { recursive: true, force: true });
    execFileSync(
      "pnpm",
      [
        "install",
        "--ignore-scripts",
        "--frozen-lockfile",
        "--offline",
        "--store-dir",
        join(consumer, "store"),
      ],
      { cwd: consumer, stdio: "inherit" },
    );
    for (const pkg of manifest.packages) {
      const installed = JSON.parse(
        readFileSync(
          join(consumer, "node_modules", pkg.name, "package.json"),
          "utf8",
        ),
      );
      assert.equal(installed.name, pkg.name);
      assert.equal(installed.version, manifest.version);
    }
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [mode, directory] = process.argv.slice(2);
  assert.ok(
    directory && ["create", "verify"].includes(mode),
    "Usage: node scripts/release-artifacts.mjs <create|verify> <directory>",
  );
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  if (mode === "create") {
    const manifest = createReleaseManifest(process.cwd(), directory, commit);
    writeFileSync(
      join(directory, RELEASE_MANIFEST),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
  } else {
    verifyReleaseArtifacts(process.cwd(), directory, commit);
  }
}
