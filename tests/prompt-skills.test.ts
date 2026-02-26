import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "@/chat/prompt";
import { sandboxSkillFile, sandboxSkillDir } from "@/chat/sandbox/paths";
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

    expect(prompt).toContain(`<location>${sandboxSkillFile("brief")}</location>`);
    expect(prompt).toContain(`<skill name="brief" location="${sandboxSkillFile("brief")}">`);
    expect(prompt).toContain(`References are relative to ${sandboxSkillDir("brief")}.`);
    expect(prompt).not.toContain("/host/path/skills/brief/SKILL.md");
  });
});
