import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupCheckCliTempRoots,
  makeTempDir,
  writeFile,
  expectCheckFailure,
  runCheckAndCollect,
  writeAppFiles,
} from "../../fixtures/check-cli";

afterEach(cleanupCheckCliTempRoots);

describe("check cli skills", () => {
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

    const lines = await runCheckAndCollect(repoRoot);

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

    await expectCheckFailure(
      repoRoot,
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

    const lines = await expectCheckFailure(
      repoRoot,
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
});
