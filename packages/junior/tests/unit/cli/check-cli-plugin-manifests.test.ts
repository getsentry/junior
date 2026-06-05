import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupCheckCliTempRoots,
  expectCheckFailure,
  makeTempDir,
  runCheckAndCollect,
  writeAppFiles,
  writeFile,
} from "../../fixtures/check-cli";

afterEach(cleanupCheckCliTempRoots);

describe("check cli plugin manifests", () => {
  it("validates local plugins and skills from an explicit repo root", async () => {
    const repoRoot = makeTempDir("junior-validate-");
    writeAppFiles(repoRoot);
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

    const lines = await runCheckAndCollect(repoRoot);

    expect(lines).toEqual([
      `Checking ${repoRoot}`,
      "✓ app files",
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

    const lines = await runCheckAndCollect(repoRoot);

    expect(lines).toEqual([
      `Checking ${repoRoot}`,
      "✓ Validation passed (0 plugin manifests, 0 skill directories checked).",
    ]);
  });

  it("validates installed packaged plugin manifests and skills", async () => {
    const repoRoot = makeTempDir("junior-validate-packaged-plugin-");
    writeFile(
      path.join(repoRoot, "package.json"),
      JSON.stringify(
        {
          dependencies: {
            "@acme/junior-demo": "1.0.0",
          },
        },
        null,
        2,
      ),
    );
    const packageRoot = path.join(
      repoRoot,
      "node_modules",
      "@acme",
      "junior-demo",
    );
    writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "@acme/junior-demo", version: "1.0.0" }),
    );
    writeFile(
      path.join(packageRoot, "plugin.yaml"),
      [
        "name: demo",
        "description: Demo packaged plugin",
        "capabilities:",
        "  - issues.read",
        "",
      ].join("\n"),
    );
    writeFile(
      path.join(packageRoot, "skills", "demo-helper", "SKILL.md"),
      [
        "---",
        "name: demo-helper",
        "description: Help with packaged demo tasks.",
        "---",
        "",
        "Use this skill.",
        "",
      ].join("\n"),
    );

    const lines = await runCheckAndCollect(repoRoot);

    expect(lines).toEqual([
      `Checking ${repoRoot}`,
      "✓ packaged plugin demo (@acme/junior-demo)",
      "  └─ ✓ skill demo-helper",
      "✓ Validation passed (1 plugin manifest, 1 skill directory checked).",
    ]);
  });

  it("fails when local plugins share a provider domain", async () => {
    const repoRoot = makeTempDir("junior-validate-duplicate-domain-");
    writeAppFiles(repoRoot);
    for (const pluginName of ["alpha", "beta"]) {
      writeFile(
        path.join(repoRoot, "app", "plugins", pluginName, "plugin.yaml"),
        [
          `name: ${pluginName}`,
          `${pluginName === "alpha" ? "description: Alpha" : "description: Beta"} plugin`,
          "credentials:",
          "  type: oauth-bearer",
          "  domains:",
          "    - api.example.com",
          `  auth-token-env: ${pluginName.toUpperCase()}_AUTH_TOKEN`,
          "",
        ].join("\n"),
      );
    }

    const lines = await expectCheckFailure(
      repoRoot,
      "Validation failed (1 error, 2 plugin manifests, 0 skill directories checked).",
    );

    expect(
      lines.some((line) =>
        line.includes('duplicate provider domain "api.example.com"'),
      ),
    ).toBe(true);
  });
});
