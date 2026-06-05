import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginAppFixture } from "../../fixtures/plugin-app";

const originalCwd = process.cwd();

async function writeSkill(pluginDir: string, name: string) {
  const skillDir = path.join(pluginDir, "skills", name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    [
      "---",
      `name: ${name}`,
      "description: Use provider data.",
      "---",
      "",
      "Use the provider CLI.",
    ].join("\n"),
    "utf8",
  );
  return skillDir;
}

afterEach(() => {
  process.chdir(originalCwd);
  vi.resetModules();
});

describe("loadSkill tool", () => {
  it("does not advertise MCP for non-MCP plugin skills", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-load-skill-"),
    );

    const pluginDir = path.join(tempRoot, "sentry-plugin");
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, "plugin.yaml"),
      [
        "name: sentry",
        "display-name: Sentry",
        "description: Sentry issue tracking",
        "capabilities:",
        "  - api",
      ].join("\n"),
      "utf8",
    );
    await writeSkill(pluginDir, "sentry");

    try {
      const app = await createPluginAppFixture([pluginDir]);
      try {
        const { discoverSkills } = await import("@/chat/skills");
        const { createLoadSkillTool } =
          await import("@/chat/tools/skill/load-skill");

        const skills = await discoverSkills();
        expect(skills).toEqual([
          expect.objectContaining({
            name: "sentry",
            pluginProvider: "sentry",
          }),
        ]);

        const result = await createLoadSkillTool(skills).execute!(
          { skill_name: "sentry" },
          {},
        );

        expect(result).toMatchObject({
          ok: true,
          skill_name: "sentry",
        });
        expect(result).not.toHaveProperty("mcp_provider");
        expect(result).not.toHaveProperty("available_tool_count");
      } finally {
        await app.cleanup();
      }
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("returns MCP metadata only when runtime activation provides it", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-load-skill-"),
    );

    const pluginDir = path.join(tempRoot, "linear-plugin");
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, "plugin.yaml"),
      [
        "name: linear",
        "display-name: Linear",
        "description: Linear issues",
        "mcp:",
        "  url: https://mcp.linear.example.test/mcp",
      ].join("\n"),
      "utf8",
    );
    await writeSkill(pluginDir, "linear");

    try {
      const app = await createPluginAppFixture([pluginDir]);
      try {
        const { discoverSkills } = await import("@/chat/skills");
        const { createLoadSkillTool } =
          await import("@/chat/tools/skill/load-skill");

        const skills = await discoverSkills();
        const result = await createLoadSkillTool(skills, {
          onSkillLoaded: async () => ({
            mcp_provider: "linear",
            available_tool_count: 2,
          }),
        }).execute!({ skill_name: "linear" }, {});

        expect(result).toMatchObject({
          ok: true,
          skill_name: "linear",
          mcp_provider: "linear",
          available_tool_count: 2,
        });
      } finally {
        await app.cleanup();
      }
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
