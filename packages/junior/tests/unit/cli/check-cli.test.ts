import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCheck } from "@/cli/check";

const tempRoots: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function writeFile(targetPath: string, contents: string): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, contents, "utf8");
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("check cli", () => {
  it("validates local plugins and skills from an explicit repo root", async () => {
    const repoRoot = makeTempDir("junior-validate-");
    writeFile(
      path.join(repoRoot, "app", "plugins", "demo", "plugin.yaml"),
      [
        "name: demo",
        "description: Demo plugin",
        "capabilities:",
        "  - issues.read",
        "config-keys:",
        "  - repo",
        "target:",
        "  type: repo",
        "  config-key: repo",
        "",
      ].join("\n"),
    );
    writeFile(
      path.join(
        repoRoot,
        "app",
        "plugins",
        "demo",
        "skills",
        "demo-helper",
        "SKILL.md",
      ),
      [
        "---",
        "name: demo-helper",
        "description: Help with demo tasks.",
        "uses-config: demo.repo",
        "requires-capabilities: demo.issues.read",
        "---",
        "",
        "Use this skill.",
        "",
      ].join("\n"),
    );
    writeFile(
      path.join(repoRoot, "app", "skills", "repo-local", "SKILL.md"),
      [
        "---",
        "name: repo-local",
        "description: Help with repo-local tasks.",
        "---",
        "",
        "Use this skill.",
        "",
      ].join("\n"),
    );

    const lines: string[] = [];
    await runCheck(repoRoot, {
      info: (line) => lines.push(line),
      warn: (line) => lines.push(line),
      error: (line) => lines.push(line),
    });

    expect(lines).toEqual([
      `Checking ${repoRoot}`,
      "✓ plugin demo",
      "  └─ ✓ skill demo-helper",
      "✓ app skills",
      "  └─ ✓ skill repo-local",
      "✓ Validation passed (1 plugin manifest, 2 skill directories checked).",
    ]);
  });

  it("ignores plugin manifests outside app/plugins", async () => {
    const repoRoot = makeTempDir("junior-validate-invalid-plugin-");
    writeFile(
      path.join(repoRoot, "plugins", "demo", "plugin.yaml"),
      "name: Demo\n",
    );

    const lines: string[] = [];
    await runCheck(repoRoot, {
      info: (line) => lines.push(line),
      warn: (line) => lines.push(line),
      error: (line) => lines.push(line),
    });

    expect(lines).toEqual([
      `Checking ${repoRoot}`,
      "✓ Validation passed (0 plugin manifests, 0 skill directories checked).",
    ]);
  });

  it("only checks skill directories under app and plugin skill roots", async () => {
    const repoRoot = makeTempDir("junior-validate-duplicate-skill-");
    writeFile(
      path.join(repoRoot, "skills", "shared-skill", "SKILL.md"),
      [
        "---",
        "name: shared-skill",
        "description: Shared skill.",
        "---",
        "",
        "Use this skill.",
        "",
      ].join("\n"),
    );
    writeFile(
      path.join(repoRoot, "app", "plugins", "demo", "plugin.yaml"),
      ["name: demo", "description: Demo plugin", ""].join("\n"),
    );
    writeFile(
      path.join(
        repoRoot,
        "app",
        "plugins",
        "demo",
        "skills",
        "shared-skill",
        "SKILL.md",
      ),
      [
        "---",
        "name: shared-skill",
        "description: Shared skill again.",
        "---",
        "",
        "Use this skill.",
        "",
      ].join("\n"),
    );

    const lines: string[] = [];
    await runCheck(repoRoot, {
      info: (line) => lines.push(line),
      warn: (line) => lines.push(line),
      error: (line) => lines.push(line),
    });

    expect(lines).toEqual([
      `Checking ${repoRoot}`,
      "✓ plugin demo",
      "  └─ ✓ skill shared-skill",
      "✓ Validation passed (1 plugin manifest, 1 skill directory checked).",
    ]);
  });

  it("fails when skill uses-config tokens are invalid", async () => {
    const repoRoot = makeTempDir("junior-validate-invalid-uses-config-");
    writeFile(
      path.join(repoRoot, "app", "plugins", "demo", "plugin.yaml"),
      ["name: demo", "description: Demo plugin", ""].join("\n"),
    );
    writeFile(
      path.join(repoRoot, "app", "skills", "repo-local", "SKILL.md"),
      [
        "---",
        "name: repo-local",
        "description: Help with repo-local tasks.",
        "uses-config: GITHUB_REPO",
        "---",
        "",
        "Use this skill.",
        "",
      ].join("\n"),
    );

    await expect(
      runCheck(repoRoot, {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      }),
    ).rejects.toThrow(
      "Validation failed (1 error, 1 plugin manifest, 1 skill directory checked).",
    );
  });
});
