import { describe, expect, it } from "vitest";
import { buildSystemPrompt, buildTurnContextPrompt } from "@/chat/prompt";

describe("prompt builders", () => {
  it("returns a byte-stable static system prompt", () => {
    const systemPrompt = buildSystemPrompt();

    expect(buildSystemPrompt.length).toBe(0);
    expect(buildSystemPrompt()).toBe(systemPrompt);
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
