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

function writeAppFiles(repoRoot: string): void {
  const appDir = path.join(repoRoot, "app");
  fs.mkdirSync(appDir, { recursive: true });
  writeFile(path.join(appDir, "SOUL.md"), "soul");
  writeFile(path.join(appDir, "WORLD.md"), "world");
  writeFile(path.join(appDir, "DESCRIPTION.md"), "description");
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("check cli", () => {
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

    const lines: string[] = [];
    await runCheck(repoRoot, {
      info: (line) => lines.push(line),
      warn: (line) => lines.push(line),
      error: (line) => lines.push(line),
    });

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

    const lines: string[] = [];
    await runCheck(repoRoot, {
      info: (line) => lines.push(line),
      warn: (line) => lines.push(line),
      error: (line) => lines.push(line),
    });

    expect(lines).toEqual([
      `Checking ${repoRoot}`,
      "✓ packaged plugin demo (@acme/junior-demo)",
      "  └─ ✓ skill demo-helper",
      "✓ Validation passed (1 plugin manifest, 1 skill directory checked).",
    ]);
  });

  it("warns when official plugin package versions differ from core", async () => {
    const repoRoot = makeTempDir("junior-validate-version-skew-");
    writeFile(
      path.join(repoRoot, "package.json"),
      JSON.stringify(
        {
          dependencies: {
            "@sentry/junior": "^0.43.0",
            "@sentry/junior-github": "^0.42.0",
          },
        },
        null,
        2,
      ),
    );
    writeFile(
      path.join(repoRoot, "node_modules", "@sentry", "junior", "package.json"),
      JSON.stringify({ name: "@sentry/junior", version: "0.43.0" }),
    );
    writeFile(
      path.join(
        repoRoot,
        "node_modules",
        "@sentry",
        "junior-github",
        "package.json",
      ),
      JSON.stringify({ name: "@sentry/junior-github", version: "0.42.0" }),
    );
    fs.mkdirSync(
      path.join(repoRoot, "node_modules", "@sentry", "junior-github", "skills"),
      { recursive: true },
    );

    const lines: string[] = [];
    await runCheck(repoRoot, {
      info: (line) => lines.push(line),
      warn: (line) => lines.push(line),
      error: (line) => lines.push(line),
    });

    expect(lines).toEqual([
      `Checking ${repoRoot}`,
      `⚠ warning: ${path.join(repoRoot, "package.json")}: @sentry/junior-github version 0.42.0 does not match @sentry/junior version 0.43.0`,
      "✓ Validation passed (0 plugin manifests, 0 skill directories checked).",
    ]);
  });

  it("skips app file validation for unrelated app directories", async () => {
    const repoRoot = makeTempDir("junior-validate-empty-app-");
    fs.mkdirSync(path.join(repoRoot, "app"), { recursive: true });

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
    writeAppFiles(repoRoot);
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
      "✓ app files",
      "✓ plugin demo",
      "  └─ ✓ skill shared-skill",
      "✓ Validation passed (1 plugin manifest, 1 skill directory checked).",
    ]);
  });

  it("fails when skill uses-config frontmatter is present", async () => {
    const repoRoot = makeTempDir("junior-validate-uses-config-");
    writeAppFiles(repoRoot);
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
        "uses-config: demo.repo",
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

  it("fails when skill instructions reference harness tool mechanics", async () => {
    const repoRoot = makeTempDir("junior-validate-use-tool-");
    writeAppFiles(repoRoot);
    writeFile(
      path.join(repoRoot, "app", "plugins", "demo", "plugin.yaml"),
      [
        "name: demo",
        "description: Demo plugin",
        "mcp:",
        "  url: https://mcp.example.test/mcp",
        "  allowed-tools:",
        "    - demo-search",
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
        "Use available_tools, then callMcpTool with the disclosed MCP tool name.",
        "",
      ].join("\n"),
    );

    const lines: string[] = [];
    await expect(
      runCheck(repoRoot, {
        info: (line) => lines.push(line),
        warn: (line) => lines.push(line),
        error: (line) => lines.push(line),
      }),
    ).rejects.toThrow(
      "Validation failed (1 error, 1 plugin manifest, 1 skill directory checked).",
    );

    expect(
      lines.some((line) =>
        line.includes(
          "skill instructions must not hardcode harness tool-discovery or MCP dispatcher mechanics",
        ),
      ),
    ).toBe(true);
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

    const lines: string[] = [];
    await expect(
      runCheck(repoRoot, {
        info: (line) => lines.push(line),
        warn: (line) => lines.push(line),
        error: (line) => lines.push(line),
      }),
    ).rejects.toThrow(
      "Validation failed (1 error, 2 plugin manifests, 0 skill directories checked).",
    );

    expect(
      lines.some((line) =>
        line.includes('duplicate provider domain "api.example.com"'),
      ),
    ).toBe(true);
  });
});
