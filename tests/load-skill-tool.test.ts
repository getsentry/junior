import { describe, expect, it } from "vitest";
import { discoverSkills } from "@/chat/skills";
import { createLoadSkillTool } from "@/chat/tools/load-skill";

describe("load_skill tool", () => {
  it("loads a skill from sandbox and returns instructions", async () => {
    const availableSkills = await discoverSkills();
    const [firstSkill] = availableSkills;
    if (!firstSkill) {
      throw new Error("expected at least one available skill");
    }

    const sandbox = {
      readFileToBuffer: async ({ path }: { path: string }) =>
        path === `/workspace/skills/${firstSkill.name}/SKILL.md`
          ? Buffer.from("---\nname: test\n---\nInstruction body", "utf8")
          : null
    } as any;
    const tool = createLoadSkillTool(sandbox, availableSkills);
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
    expect((result as any).location).toBe(`/workspace/skills/${firstSkill.name}/SKILL.md`);
    expect((result as any).skill_dir).toBe(`/workspace/skills/${firstSkill.name}`);
    expect((result as any).instructions).toBe("Instruction body");
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
