import { describe, expect, it, vi } from "vitest";
import { buildSystemPrompt } from "@/chat/prompt";
import { sandboxSkillFile, sandboxSkillDir } from "@/chat/sandbox/paths";
import type { Skill, SkillMetadata } from "@/chat/skills";

vi.mock("@/chat/capabilities/catalog", () => ({
  listCapabilityProviders: () => [
    {
      provider: "github",
      configKeys: ["github.repo"],
      capabilities: ["github.issues.read"]
    }
  ]
}));

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

  it("documents harness-owned Slack artifact targeting and explicit channel-post behavior", () => {
    const prompt = buildSystemPrompt({
      availableSkills: [],
      activeSkills: [],
      invocation: null
    });

    expect(prompt).toContain("`slackCanvasUpdate` targets the active artifact-context canvas automatically");
    expect(prompt).toContain("do not ask the user for `canvas_id`");
    expect(prompt).toContain("`slackListAddItems`, `slackListGetItems`, and `slackListUpdateItem` target the active artifact-context list automatically");
    expect(prompt).toContain("do not ask the user for `list_id`");
    expect(prompt).toContain(
      "If the user explicitly asks to post/send/share/say/show/announce/broadcast in the channel (outside this thread), call `slackChannelPostMessage`"
    );
  });

  it("renders runtime-metadata with provided version", () => {
    const prompt = buildSystemPrompt({
      availableSkills: [],
      activeSkills: [],
      invocation: null,
      runtimeMetadata: {
        version: "deadbeef"
      }
    });

    expect(prompt).toContain("<runtime-metadata>");
    expect(prompt).toContain("- version: deadbeef");
  });

  it("renders runtime-metadata with unknown when version is unavailable", () => {
    const prompt = buildSystemPrompt({
      availableSkills: [],
      activeSkills: [],
      invocation: null
    });

    expect(prompt).toContain("<runtime-metadata>");
    expect(prompt).toContain("- version: unknown");
  });

});
