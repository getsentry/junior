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
        skillPath: "/host/path/skills/brief",
        usesConfig: ["github.repo"]
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
    expect(prompt).toContain("<uses_config>github.repo</uses_config>");
    expect(prompt).toContain(`<skill name="brief" location="${sandboxSkillFile("brief")}">`);
    expect(prompt).toContain("Uses config keys: github.repo.");
    expect(prompt).toContain(`References are relative to ${sandboxSkillDir("brief")}.`);
    expect(prompt).not.toContain("/host/path/skills/brief/SKILL.md");
  });

  it("renders configuration-context with relevant and other keys", () => {
    const prompt = buildSystemPrompt({
      availableSkills: [],
      activeSkills: [],
      invocation: null,
      configuration: {
        "github.repo": "getsentry/junior",
        "jira.project": "PLAT"
      },
      relevantConfigurationKeys: ["github.repo"]
    });

    expect(prompt).toContain("<configuration-context>");
    expect(prompt).toContain("- relevant_for_active_skills:");
    expect(prompt).toContain("  - github.repo: getsentry/junior");
    expect(prompt).toContain("- other_available_keys:");
    expect(prompt).toContain("  - jira.project: PLAT");
    expect(prompt).toContain("<provider-capabilities>");
    expect(prompt).toContain("- provider: github");
    expect(prompt).toContain("  - config_keys: github.repo");
    expect(prompt).toContain("github.issues.read");
  });
});
