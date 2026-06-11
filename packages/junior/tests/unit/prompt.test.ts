import { describe, expect, it } from "vitest";
import { buildSystemPrompt, buildTurnContextPrompt } from "@/chat/prompt";

describe("prompt builders", () => {
  it("returns a byte-stable static system prompt", () => {
    const source = {
      platform: "slack" as const,
      teamId: "T123",
      channelId: "C123",
    };
    const systemPrompt = buildSystemPrompt({ source });

    expect(buildSystemPrompt({ source })).toBe(systemPrompt);
  });

  it("returns a byte-stable local system prompt variant", () => {
    const source = {
      platform: "local" as const,
      conversationId: "local:test:run-test",
    };
    const systemPrompt = buildSystemPrompt({ source });

    expect(buildSystemPrompt({ source })).toBe(systemPrompt);
    expect(systemPrompt).not.toBe(
      buildSystemPrompt({
        source: {
          platform: "slack",
          teamId: "T123",
          channelId: "C123",
        },
      }),
    );
  });

  it("omits empty runtime context sections", () => {
    expect(
      buildTurnContextPrompt({
        availableSkills: [],
        activeMcpCatalogs: [],
        invocation: null,
      }),
    ).toBeNull();
  });

  it("renders Slack conversation facts in runtime context", () => {
    const prompt = buildTurnContextPrompt({
      availableSkills: [],
      activeMcpCatalogs: [],
      invocation: null,
      runtime: {
        conversationId: "slack:C123:1712345.000001",
        slackConversation: {
          type: "private_channel",
          name: "#roadmap & launches",
        },
      },
    });

    expect(prompt).toContain(
      "- gen_ai.conversation.id: slack:C123:1712345.000001",
    );
    expect(prompt).toContain("- slack.conversation.type: private_channel");
    expect(prompt).toContain(
      "- slack.conversation.name: #roadmap &amp; launches",
    );
    expect(prompt).not.toContain("#roadmap & launches");
  });

  it("omits follow-up runtime context once session bootstrap exists", () => {
    expect(
      buildTurnContextPrompt({
        availableSkills: [
          {
            name: "alpha",
            description: "Alpha workflow",
            skillPath: "/tmp/skills/alpha",
          },
        ],
        activeMcpCatalogs: [
          { provider: "alpha-provider", available_tool_count: 2 },
        ],
        artifactState: {
          listColumnMap: {},
          lastCanvasId: "canvas-1",
          lastCanvasUrl: "https://example.com/canvas-1",
        },
        configuration: {
          sentry_project: "junior",
        },
        includeSessionContext: false,
        invocation: null,
        requester: {
          userId: "U_BETA",
          userName: "dcramer",
        },
        runtime: {
          conversationId: "conversation-alpha",
        },
        toolGuidance: [
          {
            name: "editFile",
            promptSnippet: "exact edits",
          },
        ],
      }),
    ).toBeNull();
  });
});
