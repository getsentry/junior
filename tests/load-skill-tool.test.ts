import { describe, expect, it } from "vitest";
import { SkillSandbox } from "@/chat/skill-sandbox";
import { discoverSkills } from "@/chat/skills";
import { createLoadSkillTool } from "@/chat/tools/load-skill";

describe("load_skill tool", () => {
  it("loads a skill from sandbox context and returns instructions", async () => {
    const availableSkills = await discoverSkills();
    const sandbox = new SkillSandbox(availableSkills);
    const tool = createLoadSkillTool(availableSkills);
    if (typeof tool.execute !== "function") {
      throw new Error("load_skill execute function missing");
    }

    const result = await tool.execute(
      { skill_name: "brief" },
      {
        toolCallId: "tool-call-1",
        messages: [],
        experimental_context: sandbox
      } as any
    );

    expect(result).toMatchObject({
      ok: true,
      skill_name: "brief"
    });
    expect(typeof (result as any).location).toBe("string");
    expect(typeof (result as any).skill_dir).toBe("string");
  });

  it("returns unknown-skill when the name does not exist", async () => {
    const availableSkills = await discoverSkills();
    const sandbox = new SkillSandbox(availableSkills);
    const tool = createLoadSkillTool(availableSkills);
    if (typeof tool.execute !== "function") {
      throw new Error("load_skill execute function missing");
    }

    const result = await tool.execute(
      { skill_name: "does-not-exist" },
      {
        toolCallId: "tool-call-2",
        messages: [],
        experimental_context: sandbox
      } as any
    );

    expect(result).toMatchObject({
      ok: false,
      error: "Unknown skill: does-not-exist"
    });
  });
});
