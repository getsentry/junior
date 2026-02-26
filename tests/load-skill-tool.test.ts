import { describe, expect, it } from "vitest";
import { discoverSkills } from "@/chat/skills";
import { sandboxSkillDir, sandboxSkillFile } from "@/chat/sandbox/paths";
import { createLoadSkillTool } from "@/chat/tools/load-skill";
import type { Skill } from "@/chat/skills";

describe("load_skill tool", () => {
  it("loads a skill from sandbox and returns instructions", async () => {
    const availableSkills = await discoverSkills();
    const [firstSkill] = availableSkills;
    if (!firstSkill) {
      throw new Error("expected at least one available skill");
    }

    const sandbox = {
      readFileToBuffer: async ({ path }: { path: string }) =>
        path === sandboxSkillFile(firstSkill.name)
          ? Buffer.from("---\nname: test\n---\nInstruction body", "utf8")
          : null
    } as any;
    const loaded: Skill[] = [];
    const tool = createLoadSkillTool(sandbox, availableSkills, {
      onSkillLoaded: (skill) => {
        loaded.push(skill);
      }
    });
    if (typeof tool.execute !== "function") {
      throw new Error("load_skill execute function missing");
    }

    const result = await tool.execute(
      { skill_name: firstSkill.name },
      {
        toolCallId: "tool-call-1",
        messages: []
      } as any
    );

    expect(result).toMatchObject({
      ok: true,
      skill_name: firstSkill.name
    });
    expect((result as any).location).toBe(sandboxSkillFile(firstSkill.name));
    expect((result as any).skill_dir).toBe(sandboxSkillDir(firstSkill.name));
    expect((result as any).instructions).toBe("Instruction body");
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({
      name: firstSkill.name,
      skillPath: sandboxSkillDir(firstSkill.name),
      body: "Instruction body"
    });
  });

  it("returns unknown-skill when the name does not exist", async () => {
    const availableSkills = await discoverSkills();
    const sandbox = {
      readFileToBuffer: async () => null
    } as any;
    const tool = createLoadSkillTool(sandbox, availableSkills);
    if (typeof tool.execute !== "function") {
      throw new Error("load_skill execute function missing");
    }

    const result = await tool.execute(
      { skill_name: "does-not-exist" },
      {
        toolCallId: "tool-call-2",
        messages: []
      } as any
    );

    expect(result).toMatchObject({
      ok: false,
      error: "Unknown skill: does-not-exist"
    });
  });
});
