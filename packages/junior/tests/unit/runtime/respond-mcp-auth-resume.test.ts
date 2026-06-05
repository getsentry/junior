import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupRespondMcpProgressiveLoadingTest,
  generateAssistantReply,
  getAgentTurnSessionRecord,
  isRetryableTurnError,
  makeDemoMcpTool,
  makeReplyContext,
  respondMcpProgressiveLoadingHarness,
  setupRespondMcpProgressiveLoadingTest,
  upsertAgentTurnSessionRecord,
  type PiMessage,
} from "../../fixtures/respond-mcp-progressive-loading";

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

// These suites validate local progressive-loading logic through a mocked
// agent/runtime seam; they are not integration coverage.
describe("generateAssistantReply MCP auth resume", () => {
  beforeEach(setupRespondMcpProgressiveLoadingTest);

  afterEach(cleanupRespondMcpProgressiveLoadingTest);

  it("parks for auth when MCP auth is requested during a tool call", async () => {
    listToolsMock.mockReset();
    listToolsMock.mockImplementation(
      async (
        plugin: { manifest: { name: string } },
        options: {
          authProvider?: {
            redirectToAuthorization?: (authorizationUrl: URL) => Promise<void>;
          };
        },
      ) => {
        await options.authProvider?.redirectToAuthorization?.(
          new URL(`https://auth.example.com/${plugin.manifest.name}`),
        );
        return [makeDemoMcpTool("ping")];
      },
    );
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

  it("does not return auth resume when auth session record persistence fails", async () => {
    const turnSessionStore = await import("@/chat/state/turn-session");
    const originalUpsert = turnSessionStore.upsertAgentTurnSessionRecord;
    const sessionRecordSpy = vi
      .spyOn(turnSessionStore, "upsertAgentTurnSessionRecord")
      .mockImplementation(async (args) => {
        if (args.state === "awaiting_resume" && args.resumeReason === "auth") {
          throw new Error("state adapter unavailable");
        }
        return await originalUpsert(args);
      });

    const context = {
      credentialContext: {
        actor: { type: "user" as const, userId: "U123" },
      },
      requester: { userId: "U123" },
      correlation: {
        conversationId: "conversation-3",
        turnId: "turn-3",
        channelId: "C123",
        threadTs: "1712345.0003",
      },
    };

    const reply = await generateAssistantReply("help me", context);

    expect(isRetryableTurnError(reply, "mcp_auth_resume")).toBe(false);
    expect(reply.diagnostics.outcome).toBe("provider_error");
    expect(sessionRecordSpy).toHaveBeenCalled();
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

    const firstError = await generateAssistantReply("help me", {
      credentialContext: {
        actor: { type: "user", userId: "U123" },
      },
      requester: { userId: "U123" },
      correlation: {
        conversationId: "conversation-5",
        turnId: "turn-5",
        channelId: "C123",
        threadTs: "1712345.0005",
      },
    }).catch((error) => error);

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

    const firstError = await generateAssistantReply("help me", {
      credentialContext: {
        actor: { type: "user", userId: "U123" },
      },
      requester: { userId: "U123" },
      correlation: {
        conversationId: "conversation-6",
        turnId: "turn-6",
        channelId: "C123",
        threadTs: "1712345.0006",
      },
    }).catch((error) => error);

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
