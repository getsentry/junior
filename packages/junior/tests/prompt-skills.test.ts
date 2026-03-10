import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSystemPrompt } from "@/chat/prompt";
import { sandboxSkillFile, sandboxSkillDir } from "@/chat/sandbox/paths";
import type { Skill, SkillMetadata } from "@/chat/skills";

vi.mock("@/chat/capabilities/catalog", () => ({
  listCapabilityProviders: () => [
    {
      provider: "github",
      configKeys: ["github.repo"],
      capabilities: ["github.issues.read"],
    },
  ],
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("buildSystemPrompt skill paths", () => {
  it("renders available and loaded skill locations in sandbox workspace paths", () => {
    const availableSkills: SkillMetadata[] = [
      {
        name: "brief",
        description: "Create a candidate brief",
        skillPath: "/host/path/skills/brief",
        usesConfig: ["github.repo"],
      },
    ];

    const activeSkills: Skill[] = [
      {
        ...availableSkills[0],
        body: "# Instructions",
      },
    ];

    const prompt = buildSystemPrompt({
      availableSkills,
      activeSkills,
      invocation: null,
    });

    expect(prompt).toContain(
      `<location>${sandboxSkillFile("brief")}</location>`,
    );
    expect(prompt).toContain("<uses_config>github.repo</uses_config>");
    expect(prompt).toContain(
      `<skill name="brief" location="${sandboxSkillFile("brief")}">`,
    );
    expect(prompt).toContain("Uses config keys: github.repo.");
    expect(prompt).toContain(
      `References are relative to ${sandboxSkillDir("brief")}.`,
    );
    expect(prompt).not.toContain("/host/path/skills/brief/SKILL.md");
  });

  it("renders configuration-context with relevant and other keys", () => {
    const prompt = buildSystemPrompt({
      availableSkills: [],
      activeSkills: [],
      invocation: null,
      configuration: {
        "github.repo": "getsentry/junior",
        "jira.project": "PLAT",
      },
      relevantConfigurationKeys: ["github.repo"],
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
      invocation: null,
    });

    expect(prompt).toContain(
      "`slackCanvasUpdate` targets the active artifact-context canvas automatically",
    );
    expect(prompt).toContain("do not ask the user for `canvas_id`");
    expect(prompt).toContain(
      "`slackListAddItems`, `slackListGetItems`, and `slackListUpdateItem` target the active artifact-context list automatically",
    );
    expect(prompt).toContain("do not ask the user for `list_id`");
    expect(prompt).toContain(
      "If the user explicitly asks to post/send/share/say/show/announce/broadcast in the channel (outside this thread), call `slackChannelPostMessage`",
    );
    expect(prompt).toContain(
      "When you create or update a Slack artifact in this turn",
    );
    expect(prompt).toContain("include its link when the tool returned one");
    expect(prompt).toContain(
      "If the user asks to see/share/show a screenshot or file, attach the file with `attachFile` instead of only reporting its path.",
    );
    expect(prompt).toContain(
      "Never claim a screenshot/file is attached unless `attachFile` succeeded in this turn.",
    );
    expect(prompt).toContain(
      "If `attachFile` fails, explain the failure and do not say the file was shared.",
    );
  });

  it("renders runtime-metadata with provided version", () => {
    const prompt = buildSystemPrompt({
      availableSkills: [],
      activeSkills: [],
      invocation: null,
      runtimeMetadata: {
        version: "deadbeef",
      },
    });

    expect(prompt).toContain("<runtime-metadata>");
    expect(prompt).toContain("- version: deadbeef");
  });

  it("renders runtime-metadata with unknown when version is unavailable", () => {
    const prompt = buildSystemPrompt({
      availableSkills: [],
      activeSkills: [],
      invocation: null,
    });

    expect(prompt).toContain("<runtime-metadata>");
    expect(prompt).toContain("- version: unknown");
  });

  it("renders ABOUT.md in a dedicated about section when available", async () => {
    vi.resetModules();
    vi.doMock("node:fs", () => ({
      default: {
        readFileSync: vi.fn((target: string) => {
          if (target.endsWith("/SOUL.md")) {
            return "You are a precise assistant.";
          }
          if (target.endsWith("/ABOUT.md")) {
            return "You help teams coordinate releases.";
          }
          throw new Error(`Unexpected read: ${target}`);
        }),
      },
    }));
    vi.doMock("@/chat/home", async () => {
      const actual = await vi.importActual<typeof import("@/chat/home")>("@/chat/home");
      return {
        ...actual,
        soulPathCandidates: () => ["/mock/app/SOUL.md"],
        aboutPathCandidates: () => ["/mock/app/ABOUT.md"],
      };
    });

    const { buildSystemPrompt: buildPrompt } = await import("@/chat/prompt");
    const prompt = buildPrompt({
      availableSkills: [],
      activeSkills: [],
      invocation: null,
    });

    expect(prompt).toContain("<about>");
    expect(prompt).toContain(
      "Use this as the assistant's product/domain description when relevant.",
    );
    expect(prompt).toContain("You help teams coordinate releases.");
    expect(prompt).toContain("</about>");
  });
});
