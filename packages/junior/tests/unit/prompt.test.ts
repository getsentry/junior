import { describe, expect, it } from "vitest";
import { buildSystemPrompt, buildTurnContextPrompt } from "@/chat/prompt";

describe("prompt builders", () => {
  it("keeps system instructions independent from per-turn context", () => {
    const firstSystemPrompt = buildSystemPrompt();

    const firstTurnContext = buildTurnContextPrompt({
      availableSkills: [
        {
          name: "alpha",
          description: "Alpha workflow",
          skillPath: "/tmp/skills/alpha",
        },
      ],
      activeSkills: [],
      activeMcpCatalogs: [],
      invocation: null,
      requester: { userId: "U_ALPHA" },
      runtime: {
        channelId: "C_ALPHA",
        modelId: "model-alpha",
        thinkingLevel: "medium",
      },
      turnState: "fresh",
    });

    const secondTurnContext = buildTurnContextPrompt({
      availableSkills: [
        {
          name: "beta",
          description: "Beta workflow",
          skillPath: "/tmp/skills/beta",
        },
      ],
      activeSkills: [],
      activeMcpCatalogs: [
        { provider: "beta-provider", available_tool_count: 2 },
      ],
      invocation: null,
      requester: { userId: "U_BETA" },
      runtime: {
        channelId: "C_BETA",
        modelId: "model-beta",
        thinkingLevel: "high",
      },
      turnState: "resumed",
    });

    expect(buildSystemPrompt.length).toBe(0);
    expect(firstSystemPrompt).toContain("<identity>");
    expect(firstSystemPrompt).toContain("Your Slack username is");
    expect(buildSystemPrompt()).toBe(firstSystemPrompt);
    expect(firstTurnContext).not.toBe(secondTurnContext);
    expect(firstTurnContext).not.toContain("<assistant>");
    expect(firstTurnContext).not.toContain("<thread-participants>");
    expect(firstTurnContext).toContain("<requester>");
    expect(buildSystemPrompt()).toBe(firstSystemPrompt);
  });

  it("omits requester context when requester metadata is unavailable", () => {
    const turnContext = buildTurnContextPrompt({
      availableSkills: [],
      activeSkills: [],
      activeMcpCatalogs: [],
      invocation: null,
      turnState: "fresh",
    });

    expect(turnContext).not.toContain("<requester>");
  });
});
