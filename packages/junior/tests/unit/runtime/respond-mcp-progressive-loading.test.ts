import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupRespondMcpProgressiveLoadingTest,
  generateAssistantReply,
  getAgentTurnSessionRecord,
  isRetryableTurnError,
  makeDemoMcpTool,
  makeDemoMcpTools,
  makeReplyContext,
  respondMcpProgressiveLoadingHarness,
  setupRespondMcpProgressiveLoadingTest,
  type PiMessage,
  upsertAgentTurnSessionRecord,
} from "../../fixtures/respond-mcp-progressive-loading";

const {
  DEMO_SKILL,
  agentInitialSystemPrompts,
  agentInitialToolNames,
  callToolMock,
  clientOptions,
  completeEmptyAssistantOnAbort,
  continueCallCount,
  continueStopsOnAbort,
  deliverPrivateMessageMock,
  listToolsMock,
  loadSkillExecutionErrorCount,
  omitFinalAssistantAfterTool,
  promptCallCount,
  promptMessages,
  promptSeedMessages,
  pushPreToolAssistantMessage,
  recordToolResultMessage,
  resumeMessages,
  resumeTurnContextCounts,
  searchMcpToolNames,
  turnContextInputs,
} = respondMcpProgressiveLoadingHarness;

// This suite validates local progressive-loading logic through a mocked
// agent/runtime seam; it is not integration coverage.
describe("generateAssistantReply progressive MCP loading", () => {
  beforeEach(setupRespondMcpProgressiveLoadingTest);

  afterEach(cleanupRespondMcpProgressiveLoadingTest);

  it("persists loaded plugin skills across auth pause and resume", async () => {
    const context = makeReplyContext({
      conversationId: "conversation-1",
      threadTs: "1712345.0001",
      turnId: "turn-1",
    });

    const firstError = await generateAssistantReply("help me", context).catch(
      (error) => error,
    );

    expect(isRetryableTurnError(firstError, "mcp_auth_resume")).toBe(true);
    expect(agentInitialToolNames[0]).toContain("loadSkill");
    expect(agentInitialToolNames[0]).toContain("searchMcpTools");
    expect(agentInitialToolNames[0]).toContain("callMcpTool");
    expect(agentInitialToolNames[0]).not.toContain("searchTools");
    expect(agentInitialToolNames[0]).not.toContain("mcp__demo__ping");

    const pausedSessionRecord = await getAgentTurnSessionRecord(
      "conversation-1",
      "turn-1",
    );
    expect(pausedSessionRecord).toMatchObject({
      state: "awaiting_resume",
      resumeReason: "auth",
    });
    expect(pausedSessionRecord?.piMessages.at(-1)).toMatchObject({
      role: "toolResult",
      toolName: "loadSkill",
    });
    expect(deliverPrivateMessageMock).toHaveBeenCalledTimes(1);
    expect(pendingAuthRecords).toEqual([
      expect.objectContaining({
        kind: "mcp",
        provider: "demo",
        requesterId: "U123",
        sessionId: "turn-1",
      }),
    ]);
    expect(loadSkillExecutionErrorCount.value).toBe(0);

    const reply = await generateAssistantReply("help me", context);

    expect(reply.text).toBe("resumed reply");
    expect(promptCallCount.value).toBe(1);
    expect(continueCallCount.value).toBe(1);
    expect(clientOptions).not.toContainEqual(
      expect.objectContaining({ sessionId: expect.any(String) }),
    );
    expect(agentInitialToolNames[1]).toContain("loadSkill");
    expect(agentInitialToolNames[1]).toContain("searchMcpTools");
    expect(agentInitialToolNames[1]).toContain("callMcpTool");
    expect(agentInitialToolNames[1]).not.toContain("searchTools");
    expect(agentInitialToolNames[1]).not.toContain("mcp__demo__ping");
    expect(agentInitialSystemPrompts).toEqual([
      "System prompt",
      "System prompt",
    ]);
    expect(resumeTurnContextCounts).toEqual([1]);
    expect(turnContextInputs[0]?.includeSessionContext).toBe(true);
    expect(turnContextInputs).toHaveLength(1);
    expect(searchMcpToolNames).toEqual([]);
    expect(callToolMock).toHaveBeenCalledWith(
      expect.objectContaining({
        manifest: expect.objectContaining({ name: "demo" }),
      }),
      "ping",
      { query: "hello" },
    );

    const resumedSessionRecord = await getAgentTurnSessionRecord(
      "conversation-1",
      "turn-1",
    );
    expect(resumedSessionRecord).toMatchObject({
      state: "completed",
    });
  });

  it("searches loadSkill-activated MCP tools in the same turn without replay", async () => {
    listToolsMock.mockReset();
    listToolsMock.mockResolvedValue(makeDemoMcpTools());

    const reply = await generateAssistantReply(
      "help me",
      makeReplyContext({
        conversationId: "conversation-2",
        threadTs: "1712345.0002",
        turnId: "turn-2",
      }),
    );

    expect(reply.text).toBe("resumed reply");
    expect(promptCallCount.value).toBe(1);
    expect(continueCallCount.value).toBe(0);
    expect(agentInitialToolNames[0]).toContain("loadSkill");
    expect(agentInitialToolNames[0]).toContain("searchMcpTools");
    expect(agentInitialToolNames[0]).toContain("callMcpTool");
    expect(agentInitialToolNames[0]).not.toContain("searchTools");
    expect(agentInitialToolNames[0]).not.toContain("mcp__demo__ping");
    expect(agentInitialSystemPrompts).toEqual(["System prompt"]);
    expect(turnContextInputs[0]?.activeMcpCatalogs).toEqual([]);
    expect(searchMcpToolNames).toEqual([["mcp__demo__ping"]]);
    expect(callToolMock).toHaveBeenCalledWith(
      expect.objectContaining({
        manifest: expect.objectContaining({ name: "demo" }),
      }),
      "ping",
      { query: "hello" },
    );

    const sessionRecord = await getAgentTurnSessionRecord(
      "conversation-2",
      "turn-2",
    );
    expect(sessionRecord).toMatchObject({
      state: "completed",
    });
  });

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

    expect(turnContextInputs[0]?.activeMcpCatalogs).toEqual([
      { provider: "demo", available_tool_count: 1 },
    ]);
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
    expect(resumeMessages[0]?.at(-1)).toMatchObject({
      role: "user",
      content: [
        {
          type: "text",
          text: "<runtime-turn-context>\nTurn context\n</runtime-turn-context>",
        },
        { type: "text", text: "current follow-up" },
      ],
    });
    expect(resumeTurnContextCounts).toEqual([1]);
    expect(turnContextInputs).toHaveLength(1);
    expect(turnContextInputs[0]?.includeSessionContext).toBe(true);
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
    expect(JSON.stringify(promptMessages[0])).toContain("Turn context");
    expect(turnContextInputs.at(-1)?.availableSkills).toEqual([
      expect.objectContaining({ name: "demo-skill" }),
    ]);
    expect(turnContextInputs.at(-1)?.includeSessionContext).toBe(true);
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
    expect(turnContextInputs.at(-1)?.includeSessionContext).toBe(true);
    expect(JSON.stringify(promptMessages[0])).toContain("Turn context");
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
    expect(turnContextInputs).toHaveLength(0);
    expect(JSON.stringify(promptMessages[0])).not.toContain(
      "<runtime-turn-context>",
    );
  });

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
      destination: {
        platform: "slack" as const,
        teamId: "T123",
        channelId: "C123",
      },
      requester: TEST_REQUESTER,
      recordPendingAuth: async (pendingAuth: ConversationPendingAuthState) => {
        pendingAuthRecords.push(pendingAuth);
      },
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
      destination: {
        platform: "slack",
        teamId: "T123",
        channelId: "C123",
      },
      requester: TEST_REQUESTER,
      recordPendingAuth: async (pendingAuth: ConversationPendingAuthState) => {
        pendingAuthRecords.push(pendingAuth);
      },
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
      destination: {
        platform: "slack",
        teamId: "T123",
        channelId: "C123",
      },
      requester: TEST_REQUESTER,
      recordPendingAuth: async (pendingAuth: ConversationPendingAuthState) => {
        pendingAuthRecords.push(pendingAuth);
      },
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
