import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupRespondMcpProgressiveLoadingTest,
  generateAssistantReply,
  getAgentTurnSessionRecord,
  isRetryableTurnError,
  makeDemoMcpTool,
  makeReplyContext,
  respondMcpProgressiveLoadingHarness,
  restoreRespondMcpProgressiveLoadingEnv,
  setupRespondMcpProgressiveLoadingTest,
  upsertAgentTurnSessionRecord,
  type PiMessage,
} from "../../fixtures/respond/mcp-progressive-loading";

const {
  DEMO_SKILL,
  callToolMock,
  completeEmptyAssistantOnAbort,
  continueStopsOnAbort,
  deliverPrivateMessageMock,
  listToolsMock,
  omitFinalAssistantAfterTool,
  pushPreToolAssistantMessage,
  recordToolResultMessage,
} = respondMcpProgressiveLoadingHarness;

// Component-style runtime coverage: real respond orchestration with explicit
// fake ports for the agent, MCP client, and sandbox executor.
describe("generateAssistantReply MCP auth resume", () => {
  beforeEach(setupRespondMcpProgressiveLoadingTest);

  afterEach(cleanupRespondMcpProgressiveLoadingTest);
  afterAll(restoreRespondMcpProgressiveLoadingEnv);

  it("parks for auth when MCP auth is requested during a tool call", async () => {
    listToolsMock.mockReset();
    listToolsMock.mockImplementation(async (plugin, options) => {
      await options.authProvider?.redirectToAuthorization?.(
        new URL(`https://auth.example.com/${plugin.manifest.name}`),
      );
      return [makeDemoMcpTool("ping")];
    });
    callToolMock.mockImplementationOnce(async (plugin) => {
      const { McpAuthorizationRequiredError } =
        await import("@/chat/mcp/client");
      throw new McpAuthorizationRequiredError(
        plugin.manifest.name,
        "Auth required",
      );
    });

    const context = makeReplyContext({
      conversationId: "conversation-4",
      threadTs: "1712345.0004",
      turnId: "turn-4",
    });

    const firstError = await generateAssistantReply("help me", context).catch(
      (error) => error,
    );

    expect(isRetryableTurnError(firstError, "mcp_auth_resume")).toBe(true);
    expect(deliverPrivateMessageMock).toHaveBeenCalledTimes(1);

    const pausedSessionRecord = await getAgentTurnSessionRecord(
      "conversation-4",
      "turn-4",
    );
    expect(pausedSessionRecord).toMatchObject({
      state: "awaiting_resume",
      resumeReason: "auth",
    });

    const reply = await generateAssistantReply("help me", context);

    expect(reply.text).toBe("resumed reply");

    const resumedSessionRecord = await getAgentTurnSessionRecord(
      "conversation-4",
      "turn-4",
    );
    expect(resumedSessionRecord).toMatchObject({
      state: "completed",
    });
  });

  it("does not leak provisional pre-tool assistant text as the final reply", async () => {
    pushPreToolAssistantMessage.value = true;
    recordToolResultMessage.value = true;
    omitFinalAssistantAfterTool.value = true;
    listToolsMock.mockReset();
    listToolsMock.mockResolvedValue([makeDemoMcpTool("ping")]);

    const reply = await generateAssistantReply(
      "help me",
      makeReplyContext({
        conversationId: "conversation-5",
        threadTs: "1712345.0005",
        turnId: "turn-5",
      }),
    );

    expect(reply.text).toBe("");
    expect(reply.diagnostics.outcome).toBe("execution_failure");
    expect(reply.diagnostics.usedPrimaryText).toBe(false);
  });

  it("falls back to the latest stored record when auth pause captures no messages", async () => {
    continueStopsOnAbort.value = true;

    const priorMessages: PiMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "help me" }],
        timestamp: 1,
      },
      {
        role: "toolResult",
        toolCallId: "tool-call-1",
        toolName: "loadSkill",
        isError: false,
        details: {
          ok: true,
          skill_name: DEMO_SKILL.name,
          mcp_provider: "demo",
        },
        content: [{ type: "text", text: "loaded" }],
        timestamp: 2,
      } as PiMessage,
      {
        role: "assistant",
        content: [{ type: "text", text: "working on it" }],
        api: "responses",
        provider: "openai",
        model: "gpt-5.3",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        timestamp: 3,
        stopReason: "toolUse",
      },
    ];
    const expectedResumeMessages = priorMessages.slice(0, 2);
    await upsertAgentTurnSessionRecord({
      conversationId: "conversation-5",
      sessionId: "turn-5",
      sliceId: 1,
      state: "awaiting_resume",
      piMessages: priorMessages,
      resumeReason: "auth",
    });

    callToolMock.mockImplementationOnce(async (plugin) => {
      const { McpAuthorizationRequiredError } =
        await import("@/chat/mcp/client");
      throw new McpAuthorizationRequiredError(
        plugin.manifest.name,
        "Auth required",
      );
    });

    const firstError = await generateAssistantReply(
      "help me",
      makeReplyContext({
        conversationId: "conversation-5",
        threadTs: "1712345.0005",
        turnId: "turn-5",
      }),
    ).catch((error) => error);

    expect(isRetryableTurnError(firstError, "mcp_auth_resume")).toBe(true);

    const resumedSessionRecord = await getAgentTurnSessionRecord(
      "conversation-5",
      "turn-5",
    );
    expect(resumedSessionRecord).toMatchObject({
      state: "awaiting_resume",
      sliceId: 2,
      resumedFromSliceId: 1,
      piMessages: expectedResumeMessages,
      resumeReason: "auth",
    });
  });

  it("still parks for auth when abort leaves an empty completed assistant frame", async () => {
    completeEmptyAssistantOnAbort.value = true;

    const firstError = await generateAssistantReply(
      "help me",
      makeReplyContext({
        conversationId: "conversation-6",
        threadTs: "1712345.0006",
        turnId: "turn-6",
      }),
    ).catch((error) => error);

    expect(isRetryableTurnError(firstError, "mcp_auth_resume")).toBe(true);

    const pausedSessionRecord = await getAgentTurnSessionRecord(
      "conversation-6",
      "turn-6",
    );
    expect(pausedSessionRecord).toMatchObject({
      state: "awaiting_resume",
      resumeReason: "auth",
    });
    expect(pausedSessionRecord?.piMessages.at(-1)).toMatchObject({
      role: "toolResult",
      toolName: "loadSkill",
    });
  });
});
