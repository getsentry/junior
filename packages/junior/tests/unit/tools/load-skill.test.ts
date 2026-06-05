import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sandboxSkillDir, sandboxSkillFile } from "@/chat/sandbox/paths";
import { createLoadSkillTool } from "@/chat/tools/skill/load-skill";
import { createPluginAppFixture } from "../../fixtures/plugin-app";
import type { Skill, SkillMetadata } from "@/chat/skills";

const originalCwd = process.cwd();

async function writeSkillFile(args: {
  body: string;
  description: string;
  name: string;
  skillDir: string;
}) {
  await fs.mkdir(args.skillDir, { recursive: true });
  await fs.writeFile(
    path.join(args.skillDir, "SKILL.md"),
    [
      "---",
      `name: ${args.name}`,
      `description: ${args.description}`,
      "---",
      "",
      args.body,
    ].join("\n"),
    "utf8",
  );
}

async function writePluginSkill(pluginDir: string, name: string) {
  const skillDir = path.join(pluginDir, "skills", name);
  await writeSkillFile({
    body: "Use the provider CLI.",
    description: "Use provider data.",
    name,
    skillDir,
  });
  return skillDir;
}

async function createHostSkill(args: {
  body: string;
  description: string;
  name: string;
}) {
  const skillDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "junior-load-skill-host-"),
  );
  await writeSkillFile({
    body: args.body,
    description: args.description,
    name: args.name,
    skillDir,
  });
  return skillDir;
}

async function executeLoadSkill(
  tool: ReturnType<typeof createLoadSkillTool>,
  skillName: string,
) {
  const execute = tool.execute;
  if (!execute) {
    throw new Error("loadSkill execute function missing");
  }
  return await execute({ skill_name: skillName }, {});
}

afterEach(() => {
  process.chdir(originalCwd);
  vi.resetModules();
});

describe("loadSkill tool", () => {
  it("loads a host skill and returns sandbox path guidance", async () => {
    const skillDir = await createHostSkill({
      body: "Instruction body",
      description: "A test skill with metadata",
      name: "test-skill",
    });

    try {
      const firstSkill: SkillMetadata = {
        name: "test-skill",
        description: "A test skill with metadata",
        skillPath: skillDir,
        allowedTools: ["bash"],
      };
      const loaded: Skill[] = [];
      const result = await executeLoadSkill(
        createLoadSkillTool([firstSkill], {
          onSkillLoaded: (skill) => {
            loaded.push(skill);
          },
        }),
        firstSkill.name,
      );

      expect(result).toMatchObject({
        ok: true,
        skill_name: firstSkill.name,
        location: sandboxSkillFile(firstSkill.name),
        skill_dir: sandboxSkillDir(firstSkill.name),
        working_directory: sandboxSkillDir(firstSkill.name),
        instructions: "Instruction body",
      });
      expect(result).toMatchObject({
        path_resolution: expect.stringContaining(
          sandboxSkillDir(firstSkill.name),
        ),
      });
      expect(loaded).toEqual([
        expect.objectContaining({
          name: firstSkill.name,
          skillPath: firstSkill.skillPath,
          body: "Instruction body",
          allowedTools: firstSkill.allowedTools,
        }),
      ]);
    } finally {
      await fs.rm(skillDir, { recursive: true, force: true });
    }
  });

  it("returns unknown-skill when the name does not exist", async () => {
    await expect(
      executeLoadSkill(createLoadSkillTool([]), "does-not-exist"),
    ).resolves.toMatchObject({
      ok: false,
      error: "Unknown skill: does-not-exist",
      available_skills: [],
    });
  });

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
    await writePluginSkill(pluginDir, "sentry");

    try {
      const app = await createPluginAppFixture([pluginDir]);
      try {
        const { discoverSkills } = await import("@/chat/skills");

        const skills = await discoverSkills();
        expect(skills).toEqual([
          expect.objectContaining({
            name: "sentry",
            pluginProvider: "sentry",
          }),
        ]);

        const result = await executeLoadSkill(
          createLoadSkillTool(skills),
          "sentry",
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
    await writePluginSkill(pluginDir, "linear");

    try {
      const app = await createPluginAppFixture([pluginDir]);
      try {
        const { discoverSkills } = await import("@/chat/skills");

        const skills = await discoverSkills();
        const result = await executeLoadSkill(
          createLoadSkillTool(skills, {
            onSkillLoaded: async () => ({
              mcp_provider: "linear",
              available_tool_count: 2,
            }),
          }),
          "linear",
        );

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
