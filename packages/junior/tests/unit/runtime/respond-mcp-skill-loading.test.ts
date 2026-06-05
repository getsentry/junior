import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupRespondMcpProgressiveLoadingTest,
  generateAssistantReply,
  getAgentTurnSessionRecord,
  isRetryableTurnError,
  makeDemoMcpTools,
  makeReplyContext,
  respondMcpProgressiveLoadingHarness,
  setupRespondMcpProgressiveLoadingTest,
} from "../../fixtures/respond-mcp-progressive-loading";

const {
  agentInitialSystemPrompts,
  agentInitialToolNames,
  callToolMock,
  clientOptions,
  continueCallCount,
  deliverPrivateMessageMock,
  listToolsMock,
  loadSkillExecutionErrorCount,
  promptCallCount,
  resumeTurnContextCounts,
  searchMcpToolNames,
  turnContextInputs,
} = respondMcpProgressiveLoadingHarness;

// These suites validate local progressive-loading logic through a mocked
// agent/runtime seam; they are not integration coverage.
describe("generateAssistantReply MCP skill loading", () => {
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
});
