#!/usr/bin/env node
/**
 * Publish captured dashboard screenshots to a sticky PR comment.
 *
 * Hosts images on an orphan branch `visual-ci/pr-<number>` so markdown can
 * render them inline. Same-repo PRs only.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MARKER = "<!-- junior-dashboard-visual-ci -->";

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env ${name}`);
  return value;
}

function ghJson(args) {
  const stdout = execFileSync("gh", args, {
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(stdout);
}

function ghInput(args, body) {
  execFileSync("gh", args, {
    encoding: "utf8",
    env: process.env,
    input: body,
    stdio: ["pipe", "inherit", "inherit"],
  });
}

function git(args, options = {}) {
  execFileSync("git", args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: process.env,
    stdio: options.stdio ?? "inherit",
  });
}

function buildBody(manifest, imageBaseUrl) {
  if (manifest.skipped || manifest.shots.length === 0) {
    return [
      MARKER,
      "## Dashboard visual evidence",
      "",
      "_No matching dashboard scenarios for this diff._",
      "",
    ].join("\n");
  }

  const reasonLines =
    manifest.reasons.length > 0
      ? manifest.reasons
          .slice(0, 8)
          .map((file) => `- \`${file}\``)
          .join("\n")
      : "- _(changed paths unavailable)_";

  const shotBlocks = manifest.shots
    .map((shot) => {
      const url = `${imageBaseUrl}/${shot.file}`;
      return [`### ${shot.label}`, "", `![${shot.label}](${url})`, ""].join(
        "\n",
      );
    })
    .join("\n");

  const modeLine =
    manifest.mode === "all"
      ? "Mode: full suite (`visual:all` / `--all`)"
      : manifest.mode === "explicit"
        ? "Mode: explicit scenario list"
        : "Mode: path-selected";

  return [
    MARKER,
    "## Dashboard visual evidence",
    "",
    modeLine,
    `Selected: \`${manifest.scenarioIds.join("`, `")}\``,
    "",
    "Triggered by:",
    reasonLines,
    "",
    shotBlocks,
    "_Head-only screenshots from the mock dashboard. Not a pixel-diff gate._",
    "",
  ].join("\n");
}

function publishImages(outDir, branch, commitSha) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "junior-visual-ci-"));
  const files = fs
    .readdirSync(outDir)
    .filter((name) => name.endsWith(".png") || name === "manifest.json");
  for (const file of files) {
    fs.copyFileSync(path.join(outDir, file), path.join(tmp, file));
  }

  git(["init", "-q"], { cwd: tmp });
  git(["checkout", "--orphan", branch], { cwd: tmp });
  git(["add", "."], { cwd: tmp });
  git(
    [
      "-c",
      "user.name=junior-visual-ci",
      "-c",
      "user.email=junior-visual-ci@users.noreply.github.com",
      "commit",
      "-m",
      `dashboard visual evidence ${commitSha}`,
    ],
    { cwd: tmp },
  );

  const remote = `https://x-access-token:${requiredEnv("GITHUB_TOKEN")}@github.com/${requiredEnv("GITHUB_REPOSITORY")}.git`;
  git(["remote", "add", "origin", remote], { cwd: tmp });
  git(["push", "-f", "origin", `HEAD:${branch}`], { cwd: tmp });
  fs.rmSync(tmp, { force: true, recursive: true });
}

function upsertComment(repo, prNumber, body) {
  const comments = ghJson([
    "api",
    `repos/${repo}/issues/${prNumber}/comments`,
    "--paginate",
  ]);
  const existing = comments.find(
    (comment) =>
      typeof comment.body === "string" && comment.body.includes(MARKER),
  );
  const payload = JSON.stringify({ body });

  if (existing) {
    ghInput(
      [
        "api",
        "-X",
        "PATCH",
        `repos/${repo}/issues/comments/${existing.id}`,
        "--input",
        "-",
      ],
      payload,
    );
    return;
  }

  ghInput(
    [
      "api",
      "-X",
      "POST",
      `repos/${repo}/issues/${prNumber}/comments`,
      "--input",
      "-",
    ],
    payload,
  );
}

function main() {
  const outDir = path.resolve(
    process.argv[2] ?? ".playwright/visual-dashboard",
  );
  const prNumber = requiredEnv("PR_NUMBER");
  const repo = requiredEnv("GITHUB_REPOSITORY");
  const commitSha = process.env.GITHUB_SHA ?? "unknown";
  const branch = `visual-ci/pr-${prNumber}`;
  const manifestPath = path.join(outDir, "manifest.json");

  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Missing manifest at ${manifestPath}`);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.skipped || manifest.shots.length === 0) {
    console.log("no dashboard visual scenarios selected; skipping PR comment");
    return;
  }

  publishImages(outDir, branch, commitSha);
  const imageBaseUrl = `https://raw.githubusercontent.com/${repo}/${branch}`;
  const body = buildBody(manifest, imageBaseUrl);
  upsertComment(repo, prNumber, body);
  console.log(`updated visual evidence comment on PR #${prNumber}`);
}

main();
