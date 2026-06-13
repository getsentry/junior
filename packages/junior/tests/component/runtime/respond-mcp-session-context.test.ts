import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupRespondMcpProgressiveLoadingTest,
  generateAssistantReply,
  getAgentTurnSessionRecord,
  isRetryableTurnError,
  makeReplyContext,
  restoreRespondMcpProgressiveLoadingEnv,
  setupRespondMcpProgressiveLoadingTest,
  type PiMessage,
} from "../../fixtures/respond/mcp-progressive-loading";

// Component-style runtime coverage: real respond orchestration with explicit
// fake ports for the agent, MCP client, and sandbox executor.
describe("generateAssistantReply MCP session context", () => {
  beforeEach(setupRespondMcpProgressiveLoadingTest);

  afterEach(cleanupRespondMcpProgressiveLoadingTest);
  afterAll(restoreRespondMcpProgressiveLoadingEnv);

  it("preserves prior MCP history and current follow-up across auth resume", async () => {
    const priorMessages = [
      {
        role: "user",
        content: [{ type: "text", text: "prior question" }],
        timestamp: 1,
      },
      {
        role: "toolResult",
        toolName: "callMcpTool",
        isError: false,
        content: [{ type: "text", text: "pong" }],
        input: {
          tool_name: "mcp__demo__ping",
          arguments: { query: "prior" },
        },
      },
    ] as unknown as PiMessage[];

    const firstError = await generateAssistantReply("current follow-up", {
      ...makeReplyContext({
        conversationId: "conversation-restore-auth",
        threadTs: "1712345.0091",
        turnId: "turn-restore-auth",
      }),
      piMessages: priorMessages,
    }).catch((error) => error);

    expect(isRetryableTurnError(firstError, "mcp_auth_resume")).toBe(true);

    const pausedSessionRecord = await getAgentTurnSessionRecord(
      "conversation-restore-auth",
      "turn-restore-auth",
    );
    expect(pausedSessionRecord).toMatchObject({
      state: "awaiting_resume",
      resumeReason: "auth",
    });
    expect(pausedSessionRecord?.piMessages).toHaveLength(3);
    expect(pausedSessionRecord?.piMessages[0]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "prior question" }],
    });
    expect(pausedSessionRecord?.piMessages.at(-1)).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "current follow-up" }],
    });

    const reply = await generateAssistantReply("current follow-up", {
      ...makeReplyContext({
        conversationId: "conversation-restore-auth",
        threadTs: "1712345.0091",
        turnId: "turn-restore-auth",
      }),
      piMessages: priorMessages,
    });

    expect(reply.text).toBe("resumed reply");
    const completedSessionRecord = await getAgentTurnSessionRecord(
      "conversation-restore-auth",
      "turn-restore-auth",
    );
    expect(completedSessionRecord).toMatchObject({
      state: "completed",
    });
  });
});
