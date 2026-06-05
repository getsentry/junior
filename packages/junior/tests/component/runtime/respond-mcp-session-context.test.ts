import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupRespondMcpProgressiveLoadingTest,
  generateAssistantReply,
  getAgentTurnSessionRecord,
  isRetryableTurnError,
  makeDemoMcpTools,
  makeReplyContext,
  respondMcpProgressiveLoadingHarness,
  restoreRespondMcpProgressiveLoadingEnv,
  setupRespondMcpProgressiveLoadingTest,
  upsertAgentTurnSessionRecord,
  type PiMessage,
} from "../../fixtures/respond-mcp-progressive-loading";

const {
  listToolsMock,
  promptMessages,
  promptSeedMessages,
  resumeMessages,
  resumeTurnContextCounts,
} = respondMcpProgressiveLoadingHarness;

function textParts(message: unknown): string[] {
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return [];
  }
  return content
    .map((part) =>
      part &&
      typeof part === "object" &&
      typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : "",
    )
    .filter((text) => text.length > 0);
}

function messageText(message: unknown): string {
  return textParts(message).join("\n");
}

function runtimeContextCount(message: unknown): number {
  return (messageText(message).match(/<runtime-turn-context>/g) ?? []).length;
}

// Component-style runtime coverage: real respond orchestration with explicit
// fake ports for the agent, MCP client, and sandbox executor.
describe("generateAssistantReply MCP session context", () => {
  beforeEach(setupRespondMcpProgressiveLoadingTest);

  afterEach(cleanupRespondMcpProgressiveLoadingTest);
  afterAll(restoreRespondMcpProgressiveLoadingEnv);

  it("restores MCP providers inferred from prior Pi history before building a follow-up turn prompt", async () => {
    listToolsMock.mockReset();
    listToolsMock.mockResolvedValue(makeDemoMcpTools());

    await generateAssistantReply("help me", {
      ...makeReplyContext({
        conversationId: "conversation-restored-provider",
        threadTs: "1712345.0090",
        turnId: "turn-restored-provider",
      }),
      piMessages: [
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
      ] as unknown as PiMessage[],
    });

    expect(messageText(promptMessages[0])).toContain("<active-mcp-catalogs>");
    expect(messageText(promptMessages[0])).toContain(
      "<provider>demo</provider>",
    );
    expect(messageText(promptMessages[0])).toContain(
      "<available_tool_count>1</available_tool_count>",
    );
    expect(listToolsMock).toHaveBeenCalledTimes(1);
  });

  it("adds missing bootstrap context when inferred provider restore pauses before prompt", async () => {
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
    expect(resumeMessages).toHaveLength(1);
    const resumedUserMessage = resumeMessages[0]?.at(-1);
    expect(resumedUserMessage).toMatchObject({ role: "user" });
    expect(runtimeContextCount(resumedUserMessage)).toBe(1);
    expect(textParts(resumedUserMessage).at(-1)).toBe("current follow-up");
    expect(resumeTurnContextCounts).toEqual([1]);
  });

  it("injects session context when persisted Pi history has no runtime context", async () => {
    listToolsMock.mockReset();
    listToolsMock.mockResolvedValue(makeDemoMcpTools());
    const priorMessages: PiMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "prior question" }],
        timestamp: 1,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "prior answer" }],
        timestamp: 2,
      },
    ] as PiMessage[];

    await generateAssistantReply("help me", {
      ...makeReplyContext({
        conversationId: "conversation-history",
        threadTs: "1712345.0003",
        turnId: "turn-history",
      }),
      conversationContext: "duplicated prior transcript",
      piMessages: priorMessages,
    });

    expect(promptSeedMessages[0]).toEqual(priorMessages);
    expect(JSON.stringify(promptMessages[0])).not.toContain(
      "duplicated prior transcript",
    );
    expect(JSON.stringify(promptMessages[0])).not.toContain(
      "<thread-background>",
    );
    expect(runtimeContextCount(promptMessages[0])).toBe(1);
  });

  it("injects session context for crash retries loaded from stripped running history", async () => {
    listToolsMock.mockReset();
    listToolsMock.mockResolvedValue(makeDemoMcpTools());
    const storedRunningMessages: PiMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "<runtime-turn-context>\nstale bootstrap\n</runtime-turn-context>",
          },
          { type: "text", text: "prior interrupted request" },
        ],
        timestamp: 1,
      },
    ] as PiMessage[];
    const strippedHistory: PiMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "prior interrupted request" }],
        timestamp: 1,
      },
    ] as PiMessage[];
    await upsertAgentTurnSessionRecord({
      conversationId: "conversation-crash-retry",
      sessionId: "turn-crash-retry",
      sliceId: 1,
      state: "running",
      piMessages: storedRunningMessages,
    });

    await generateAssistantReply("continue after crash", {
      ...makeReplyContext({
        conversationId: "conversation-crash-retry",
        threadTs: "1712345.00032",
        turnId: "turn-crash-retry",
      }),
      piMessages: strippedHistory,
    });

    expect(promptSeedMessages[0]).toEqual(strippedHistory);
    expect(runtimeContextCount(promptMessages[0])).toBe(1);
    expect(JSON.stringify(promptMessages[0])).not.toContain("stale bootstrap");
  });

  it("does not duplicate session context when persisted Pi history already has it", async () => {
    listToolsMock.mockReset();
    listToolsMock.mockResolvedValue(makeDemoMcpTools());
    const priorMessages: PiMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "<runtime-turn-context>\nexisting bootstrap\n</runtime-turn-context>",
          },
          { type: "text", text: "prior question" },
        ],
        timestamp: 1,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "prior answer" }],
        timestamp: 2,
      },
    ] as PiMessage[];

    await generateAssistantReply("help me", {
      ...makeReplyContext({
        conversationId: "conversation-history-with-context",
        threadTs: "1712345.00031",
        turnId: "turn-history-with-context",
      }),
      piMessages: priorMessages,
    });

    expect(promptSeedMessages[0]).toEqual(priorMessages);
    expect(runtimeContextCount(promptMessages[0])).toBe(0);
  });
});
