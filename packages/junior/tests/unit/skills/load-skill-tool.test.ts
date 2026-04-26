import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { discoverSkills } from "@/chat/skills";
import { sandboxSkillDir, sandboxSkillFile } from "@/chat/sandbox/paths";
import { createLoadSkillTool } from "@/chat/tools/skill/load-skill";
import type { Skill, SkillMetadata } from "@/chat/skills";

describe("load_skill tool", () => {
  it("loads a skill from host storage and returns instructions", async () => {
    const skillRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-load-skill-"),
    );
    await fs.writeFile(
      path.join(skillRoot, "SKILL.md"),
      [
        "---",
        "name: test-skill",
        "description: A test skill with metadata",
        "---",
        "",
        "Instruction body",
      ].join("\n"),
      "utf8",
    );

    const firstSkill: SkillMetadata = {
      name: "test-skill",
      description: "A test skill with metadata",
      skillPath: skillRoot,
      allowedTools: ["bash"],
    };
    const availableSkills = [firstSkill];
    const loaded: Skill[] = [];
    const tool = createLoadSkillTool(availableSkills, {
      onSkillLoaded: (skill) => {
        loaded.push(skill);
      },
    });
    if (typeof tool.execute !== "function") {
      throw new Error("load_skill execute function missing");
    }

    const result = await tool.execute({ skill_name: firstSkill.name }, {
      toolCallId: "tool-call-1",
      messages: [],
    } as any);

    expect(result).toMatchObject({
      ok: true,
      skill_name: firstSkill.name,
    });
    expect((result as any).location).toBe(sandboxSkillFile(firstSkill.name));
    expect((result as any).skill_dir).toBe(sandboxSkillDir(firstSkill.name));
    expect((result as any).instructions).toBe("Instruction body");
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({
      name: firstSkill.name,
      skillPath: firstSkill.skillPath,
      body: "Instruction body",
    });
    expect(loaded[0]).toMatchObject({
      ...(firstSkill.pluginProvider
        ? { pluginProvider: firstSkill.pluginProvider }
        : {}),
      ...(firstSkill.allowedTools
        ? { allowedTools: firstSkill.allowedTools }
        : {}),
    });
  });

  it("returns unknown-skill when the name does not exist", async () => {
    const availableSkills = await discoverSkills();
    const tool = createLoadSkillTool(availableSkills);
    if (typeof tool.execute !== "function") {
      throw new Error("load_skill execute function missing");
    }

    const result = await tool.execute({ skill_name: "does-not-exist" }, {
      toolCallId: "tool-call-2",
      messages: [],
    } as any);

    expect(result).toMatchObject({
      ok: false,
      error: "Unknown skill: does-not-exist",
    });
  });
});
