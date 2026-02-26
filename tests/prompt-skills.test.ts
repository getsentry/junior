import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "@/chat/prompt";
import type { Skill, SkillMetadata } from "@/chat/skills";

describe("buildSystemPrompt skill paths", () => {
  it("renders available and loaded skill locations in sandbox workspace paths", () => {
    const availableSkills: SkillMetadata[] = [
      {
        name: "brief",
        description: "Create a candidate brief",
        skillPath: "/host/path/skills/brief"
      }
    ];

    const activeSkills: Skill[] = [
      {
        ...availableSkills[0],
        body: "# Instructions"
      }
    ];

    const prompt = buildSystemPrompt({
      availableSkills,
      activeSkills,
      invocation: null
    });

    expect(prompt).toContain("<location>/workspace/skills/brief/SKILL.md</location>");
    expect(prompt).toContain('<skill name="brief" location="/workspace/skills/brief/SKILL.md">');
    expect(prompt).toContain("References are relative to /workspace/skills/brief.");
    expect(prompt).not.toContain("/host/path/skills/brief/SKILL.md");
  });
});
