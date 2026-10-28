/** Publish a complete, verified GitHub Release. Craft owns approval, the tag, and npm. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  RELEASE_MANIFEST,
  verifyReleaseArtifacts,
  verifyReleaseInstall,
} from "./release-artifacts.mjs";

const root = process.cwd();
const [tag, artifactDirectory] = process.argv.slice(2);
assert.match(
  tag ?? "",
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/,
  "Expected a release tag",
);
assert.ok(artifactDirectory, "Expected the CI artifact directory");
const directory = resolve(artifactDirectory);
const repo = process.env.GITHUB_REPOSITORY;
assert.equal(
  repo,
  "getsentry/junior",
  "Only publish releases in getsentry/junior",
);
const commit = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const tagCommit = execFileSync(
  "git",
  ["rev-parse", `refs/tags/${tag}^{commit}`],
  { encoding: "utf8" },
).trim();
assert.equal(
  commit,
  tagCommit,
  "Checkout does not match the approved release tag",
);
const manifest = verifyReleaseArtifacts(root, directory, commit);
assert.equal(manifest.version, tag, "Tag and package versions differ");

function gh(args, options = {}) {
  return execFileSync("gh", args, { encoding: "utf8", ...options });
}

/** Change release state only at this GitHub boundary. */
function api(path, body, method = "POST") {
  return JSON.parse(
    gh(["api", `repos/${repo}/${path}`, "--method", method, "--input", "-"], {
      input: JSON.stringify(body),
    }),
  );
}

/** Include drafts so a failed upload can resume without a second release. */
function findRelease() {
  // Filter in gh: release bodies and asset lists can exceed Node's output buffer.
  const result = gh([
    "api",
    `repos/${repo}/releases?per_page=100`,
    "--paginate",
    "--jq",
    `.[] | select(.tag_name == ${JSON.stringify(tag)}) | {id, tag_name, draft}`,
  ]).trim();
  return result ? JSON.parse(result) : undefined;
}

/** Read all uploaded assets, including their immutable IDs and content digests. */
function listAssets(release) {
  return JSON.parse(
    gh([
      "api",
      `repos/${repo}/releases/${release.id}/assets?per_page=100`,
      "--paginate",
      "--slurp",
    ]),
  ).flat();
}

const temporary = mkdtempSync(join(tmpdir(), "junior-github-release-"));
try {
  let release = findRelease();
  if (!release) {
    const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
    const heading = `## ${tag}`;
    const lines = changelog.split("\n");
    const start = lines.findIndex((line) => line.trim() === heading);
    assert.ok(start >= 0, `Missing release notes for ${tag}`);
    const end = lines.findIndex(
      (line, index) => index > start && line.startsWith("## "),
    );
    const body = lines
      .slice(start + 1, end < 0 ? undefined : end)
      .join("\n")
      .trim();
    assert.ok(body, `Empty release notes for ${tag}`);
    release = api("releases", {
      tag_name: tag,
      target_commitish: commit,
      name: tag,
      body,
      draft: true,
      prerelease: tag.includes("-"),
    });
  }

  const expectedFiles = [
    RELEASE_MANIFEST,
    ...manifest.packages.map((pkg) => pkg.file),
  ];
  let assets = listAssets(release);
  for (const asset of assets) {
    assert.ok(
      expectedFiles.includes(asset.name),
      `Unexpected release asset: ${asset.name}`,
    );
    assert.equal(
      asset.state,
      "uploaded",
      `Incomplete release asset: ${asset.name}`,
    );
  }
  const missing = expectedFiles.filter(
    (file) => !assets.some((asset) => asset.name === file),
  );
  // Resume partial drafts without replacing anything. Published releases are read-only.
  assert.ok(
    release.draft || missing.length === 0,
    "Published release is incomplete; do not replace its assets",
  );
  if (missing.length > 0) {
    gh([
      "release",
      "upload",
      tag,
      ...missing.map((file) => join(directory, file)),
      "--repo",
      repo,
    ]);
  }
  assets = listAssets(release);
  assert.deepEqual(
    assets.map((asset) => asset.name).sort(),
    [...expectedFiles].sort(),
    "Release asset set differs from CI",
  );
  for (const asset of assets) {
    assert.equal(
      asset.state,
      "uploaded",
      `Incomplete release asset: ${asset.name}`,
    );
    const bytes = gh(
      [
        "api",
        `repos/${repo}/releases/assets/${asset.id}`,
        "-H",
        "Accept: application/octet-stream",
      ],
      { encoding: "buffer", maxBuffer: 128 * 1024 * 1024 },
    );
    assert.ok(
      bytes.equals(readFileSync(join(directory, asset.name))),
      `GitHub asset differs from CI: ${asset.name}`,
    );
    writeFileSync(join(temporary, asset.name), bytes);
  }
  verifyReleaseArtifacts(root, temporary, commit);
  verifyReleaseInstall(temporary, manifest);

  // Do not publish a tag or asset set changed by another actor during verification.
  const remoteCommit = gh([
    "api",
    `repos/${repo}/commits/${tag}`,
    "--jq",
    ".sha",
  ]).trim();
  assert.equal(remoteCommit, commit, "Release tag moved during verification");
  const identity = (items) =>
    items
      .map(({ id, name, size, digest, state, updated_at }) => ({
        id,
        name,
        size,
        digest,
        state,
        updated_at,
      }))
      .sort((a, b) => a.id - b.id);
  assert.deepEqual(
    identity(listAssets(release)),
    identity(assets),
    "Release assets changed during verification",
  );
  if (release.draft) {
    api(
      `releases/${release.id}`,
      { draft: false, make_latest: "legacy" },
      "PATCH",
    );
  }
  console.log(
    `Verified GitHub Release: https://github.com/${repo}/releases/tag/${tag}`,
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
