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
        conversationId: "conversation-alpha",
        traceId: "trace-alpha",
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
        conversationId: "conversation-beta",
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
    expect(firstTurnContext).toContain(
      "- gen_ai.conversation.id: conversation-alpha",
    );
    expect(firstTurnContext).toContain("- trace_id: trace-alpha");
    expect(firstTurnContext).not.toContain("- model:");
    expect(firstTurnContext).not.toContain("- fast_model:");
    expect(firstTurnContext).not.toContain("- channel:");
    expect(firstTurnContext).not.toContain("- slack_capabilities:");
    expect(firstTurnContext).not.toContain("- thinking:");
    expect(firstTurnContext).not.toContain("- sandbox_workspace:");
    expect(firstSystemPrompt).not.toContain("trace-alpha");
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
    expect(turnContext).not.toContain("<context>");
    expect(turnContext).not.toContain("<capabilities>");
    expect(turnContext).not.toContain("<runtime>");
  });

  it("puts tool guidance in turn context, not the static system prompt", () => {
    const systemPrompt = buildSystemPrompt();
    const turnContext = buildTurnContextPrompt({
      availableSkills: [],
      activeSkills: [],
      activeMcpCatalogs: [],
      invocation: null,
      toolGuidance: [
        {
          name: "editFile",
          promptSnippet: "exact edits",
          promptGuidelines: ["unique oldText"],
        },
      ],
      turnState: "fresh",
    });

    expect(systemPrompt).not.toContain("<tool-guidance>");
    expect(turnContext).toContain("<tool-guidance>");
    expect(turnContext).toContain('name="editFile"');
    expect(turnContext).toContain("- exact edits");
    expect(turnContext).toContain("- unique oldText");
  });
});
