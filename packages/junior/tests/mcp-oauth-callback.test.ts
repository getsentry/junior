import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  afterCallbacks,
  coerceThreadArtifactsStateMock,
  coerceThreadConversationStateMock,
  deleteMcpAuthSessionMock,
  finalizeMcpAuthorizationMock,
  generateAssistantReplyMock,
  logWarnMock,
  markConversationMessageMock,
  markTurnCompletedMock,
  markTurnFailedMock,
  mergeArtifactsStateMock,
  persistThreadStateMock,
  postMessageMock,
  setStatusMock,
  threadFromJsonMock,
  updateConversationStatsMock,
  uploadFilesToThreadMock,
  upsertConversationMessageMock,
} = vi.hoisted(() => ({
  afterCallbacks: [] as Array<() => Promise<void> | void>,
  coerceThreadArtifactsStateMock: vi.fn(),
  coerceThreadConversationStateMock: vi.fn(),
  deleteMcpAuthSessionMock: vi.fn(),
  finalizeMcpAuthorizationMock: vi.fn(),
  generateAssistantReplyMock: vi.fn(),
  logWarnMock: vi.fn(),
  markConversationMessageMock: vi.fn(),
  markTurnCompletedMock: vi.fn(),
  markTurnFailedMock: vi.fn(),
  mergeArtifactsStateMock: vi.fn(),
  persistThreadStateMock: vi.fn(),
  postMessageMock: vi.fn(),
  setStatusMock: vi.fn(),
  threadFromJsonMock: vi.fn(),
  updateConversationStatsMock: vi.fn(),
  uploadFilesToThreadMock: vi.fn(),
  upsertConversationMessageMock: vi.fn(),
}));

vi.mock("chat", () => ({
  ThreadImpl: {
    fromJSON: threadFromJsonMock,
  },
}));

vi.mock("next/server", () => ({
  after: (callback: () => Promise<void> | void) => {
    afterCallbacks.push(callback);
  },
}));

vi.mock("@/chat/mcp/oauth", () => ({
  finalizeMcpAuthorization: finalizeMcpAuthorizationMock,
}));

vi.mock("@/chat/mcp/auth-store", () => ({
  deleteMcpAuthSession: deleteMcpAuthSessionMock,
}));

vi.mock("@/chat/respond", () => ({
  generateAssistantReply: generateAssistantReplyMock,
}));

vi.mock("@/chat/config", () => ({
  botConfig: {
    userName: "junior",
  },
}));

vi.mock("@/chat/slack-actions/client", () => ({
  getSlackClient: () => ({
    chat: {
      postMessage: postMessageMock,
    },
    assistant: {
      threads: {
        setStatus: setStatusMock,
      },
    },
  }),
  uploadFilesToThread: uploadFilesToThreadMock,
}));

vi.mock("@/chat/observability", () => ({
  logException: vi.fn(),
  logWarn: logWarnMock,
}));

vi.mock("@/chat/conversation-state", () => ({
  coerceThreadConversationState: coerceThreadConversationStateMock,
}));

vi.mock("@/chat/runtime/thread-state", () => ({
  mergeArtifactsState: mergeArtifactsStateMock,
  persistThreadState: persistThreadStateMock,
}));

vi.mock("@/chat/services/conversation-memory", () => ({
  generateConversationId: () => "assistant-1",
  markConversationMessage: markConversationMessageMock,
  normalizeConversationText: (text: string) => text.trim(),
  upsertConversationMessage: upsertConversationMessageMock,
  updateConversationStats: updateConversationStatsMock,
}));

vi.mock("@/chat/slack-actions/types", () => ({
  coerceThreadArtifactsState: coerceThreadArtifactsStateMock,
}));

vi.mock("@/chat/turn/persist", () => ({
  markTurnCompleted: markTurnCompletedMock,
  markTurnFailed: markTurnFailedMock,
}));

import { GET } from "@/handlers/mcp-oauth-callback";

function makeRequest(url: string): Request {
  return new Request(url, { method: "GET" });
}

function makeContext(provider: string) {
  return {
    params: Promise.resolve({ provider }),
  };
}

describe("mcp oauth callback handler", () => {
  beforeEach(() => {
    afterCallbacks.length = 0;
    coerceThreadArtifactsStateMock.mockReset();
    coerceThreadConversationStateMock.mockReset();
    deleteMcpAuthSessionMock.mockReset();
    finalizeMcpAuthorizationMock.mockReset();
    generateAssistantReplyMock.mockReset();
    logWarnMock.mockReset();
    markConversationMessageMock.mockReset();
    markTurnCompletedMock.mockReset();
    markTurnFailedMock.mockReset();
    mergeArtifactsStateMock.mockReset();
    persistThreadStateMock.mockReset();
    postMessageMock.mockReset();
    setStatusMock.mockReset();
    threadFromJsonMock.mockReset();
    updateConversationStatsMock.mockReset();
    uploadFilesToThreadMock.mockReset();
    upsertConversationMessageMock.mockReset();

    finalizeMcpAuthorizationMock.mockResolvedValue({
      authSessionId: "state-123",
      provider: "demo",
      userId: "U123",
      conversationId: "conversation-1",
      sessionId: "turn_msg_1",
      userMessage: "/demo incidents",
      channelId: "C123",
      threadTs: "1712345.0001",
      toolChannelId: "C999",
      configuration: {
        "demo.org": "acme",
      },
      artifactState: {
        assistantContextChannelId: "C999",
        lastCanvasId: "F123",
      },
      createdAtMs: 1,
      updatedAtMs: 1,
    });
    generateAssistantReplyMock.mockResolvedValue({
      text: "resumed MCP reply",
      artifactStatePatch: {
        lastCanvasUrl: "https://example.com/canvas",
      },
      sandboxId: "sandbox-1",
      sandboxDependencyProfileHash: "hash-1",
      diagnostics: {
        outcome: "success",
        toolCalls: [],
      },
    });
    postMessageMock.mockResolvedValue(undefined);
    setStatusMock.mockResolvedValue(undefined);
    uploadFilesToThreadMock.mockResolvedValue(undefined);
    threadFromJsonMock.mockReturnValue({
      state: Promise.resolve({
        conversation: {},
        artifacts: {},
      }),
    });
    coerceThreadConversationStateMock.mockReturnValue({
      backfill: {},
      compactions: [],
      messages: [
        {
          id: "msg.1",
          role: "user",
          text: "/demo incidents",
          createdAtMs: 1,
        },
      ],
      processing: {
        activeTurnId: "turn_msg_1",
      },
      schemaVersion: 1,
      stats: {
        compactedMessageCount: 0,
        estimatedContextTokens: 0,
        totalMessageCount: 1,
        updatedAtMs: 1,
      },
      vision: {
        byFileId: {},
      },
    });
    coerceThreadArtifactsStateMock.mockReturnValue({
      assistantContextChannelId: "C999",
    });
    mergeArtifactsStateMock.mockImplementation((current, patch) => ({
      ...current,
      ...patch,
    }));
    deleteMcpAuthSessionMock.mockResolvedValue(undefined);
    persistThreadStateMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns HTML 400 when the state parameter is missing", async () => {
    const response = await GET(
      makeRequest("https://example.com/api/oauth/callback/mcp/demo?code=abc"),
      makeContext("demo"),
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Missing state parameter");
    expect(finalizeMcpAuthorizationMock).not.toHaveBeenCalled();
  });

  it("escapes querystring error text in the HTML response", async () => {
    const response = await GET(
      makeRequest(
        "https://example.com/api/oauth/callback/mcp/demo?state=state-123&error=%3Cscript%3Ealert(1)%3C%2Fscript%3E",
      ),
      makeContext("demo"),
    );

    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(body).not.toContain("<script>alert(1)</script>");
  });

  it("escapes callback exception text in the HTML response", async () => {
    finalizeMcpAuthorizationMock.mockRejectedValueOnce(
      new Error("<img src=x onerror=alert(1)>"),
    );

    const response = await GET(
      makeRequest(
        "https://example.com/api/oauth/callback/mcp/demo?code=auth-code&state=state-123",
      ),
      makeContext("demo"),
    );

    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(body).not.toContain("<img src=x onerror=alert(1)>");
  });

  it("finalizes MCP auth and resumes the paused request in the stored Slack thread", async () => {
    const response = await GET(
      makeRequest(
        "https://example.com/api/oauth/callback/mcp/demo?code=auth-code&state=state-123",
      ),
      makeContext("demo"),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Authorization complete");
    expect(finalizeMcpAuthorizationMock).toHaveBeenCalledWith(
      "demo",
      "state-123",
      "auth-code",
    );
    expect(afterCallbacks).toHaveLength(1);

    await afterCallbacks[0]!();

    expect(postMessageMock).toHaveBeenNthCalledWith(1, {
      channel: "C123",
      thread_ts: "1712345.0001",
      text: "Your demo MCP access is now connected. Continuing the original request...",
    });
    expect(setStatusMock).toHaveBeenCalledWith({
      channel_id: "C123",
      thread_ts: "1712345.0001",
      status: "Thinking...",
    });
    expect(generateAssistantReplyMock).toHaveBeenCalledWith(
      "/demo incidents",
      expect.objectContaining({
        assistant: { userName: "junior" },
        requester: { userId: "U123" },
        correlation: {
          conversationId: "conversation-1",
          turnId: "turn_msg_1",
          channelId: "C123",
          threadTs: "1712345.0001",
          requesterId: "U123",
        },
        toolChannelId: "C999",
        artifactState: {
          assistantContextChannelId: "C999",
          lastCanvasId: "F123",
        },
        configuration: {
          "demo.org": "acme",
        },
      }),
    );

    const resumeContext = generateAssistantReplyMock.mock.calls[0]?.[1] as {
      channelConfiguration?: {
        resolve: (key: string) => Promise<unknown>;
      };
    };
    expect(await resumeContext.channelConfiguration?.resolve("demo.org")).toBe(
      "acme",
    );
    expect(postMessageMock).toHaveBeenNthCalledWith(2, {
      channel: "C123",
      thread_ts: "1712345.0001",
      text: "resumed MCP reply",
    });
    expect(uploadFilesToThreadMock).not.toHaveBeenCalled();
    expect(deleteMcpAuthSessionMock).toHaveBeenCalledWith("state-123");
    expect(markConversationMessageMock).toHaveBeenCalledWith(
      expect.anything(),
      "msg.1",
      { replied: true, skippedReason: undefined },
    );
    expect(markTurnCompletedMock).toHaveBeenCalledTimes(1);
    expect(persistThreadStateMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        artifacts: {
          assistantContextChannelId: "C999",
          lastCanvasUrl: "https://example.com/canvas",
        },
        sandboxId: "sandbox-1",
        sandboxDependencyProfileHash: "hash-1",
      }),
    );
  });

  it("respects the resumed reply delivery plan and uploads files to the thread", async () => {
    generateAssistantReplyMock.mockResolvedValueOnce({
      text: "",
      files: [
        {
          data: Buffer.from("hello"),
          filename: "resume.txt",
        },
      ],
      deliveryPlan: {
        mode: "thread",
        ack: "none",
        postThreadText: true,
        attachFiles: "inline",
      },
      diagnostics: {
        outcome: "success",
        toolCalls: [],
      },
    });

    const response = await GET(
      makeRequest(
        "https://example.com/api/oauth/callback/mcp/demo?code=auth-code&state=state-123",
      ),
      makeContext("demo"),
    );

    expect(response.status).toBe(200);
    await afterCallbacks[0]!();

    expect(postMessageMock).toHaveBeenCalledTimes(1);
    expect(uploadFilesToThreadMock).toHaveBeenCalledWith({
      channelId: "C123",
      threadTs: "1712345.0001",
      files: [
        {
          data: Buffer.from("hello"),
          filename: "resume.txt",
        },
      ],
    });
  });

  it("uploads resumed reply files even when thread text delivery is suppressed", async () => {
    generateAssistantReplyMock.mockResolvedValueOnce({
      text: "👍",
      files: [
        {
          data: Buffer.from("hello"),
          filename: "resume.txt",
        },
      ],
      deliveryPlan: {
        mode: "thread",
        ack: "reaction",
        postThreadText: false,
        attachFiles: "inline",
      },
      diagnostics: {
        outcome: "success",
        toolCalls: [],
      },
    });

    const response = await GET(
      makeRequest(
        "https://example.com/api/oauth/callback/mcp/demo?code=auth-code&state=state-123",
      ),
      makeContext("demo"),
    );

    expect(response.status).toBe(200);
    await afterCallbacks[0]!();

    expect(postMessageMock).toHaveBeenCalledTimes(1);
    expect(uploadFilesToThreadMock).toHaveBeenCalledWith({
      channelId: "C123",
      threadTs: "1712345.0001",
      files: [
        {
          data: Buffer.from("hello"),
          filename: "resume.txt",
        },
      ],
    });
  });

  it("marks the resumed turn failed in thread state when continuation errors", async () => {
    generateAssistantReplyMock.mockRejectedValueOnce(
      new Error("resume failed"),
    );

    const response = await GET(
      makeRequest(
        "https://example.com/api/oauth/callback/mcp/demo?code=auth-code&state=state-123",
      ),
      makeContext("demo"),
    );

    expect(response.status).toBe(200);
    await afterCallbacks[0]!();

    expect(markTurnFailedMock).toHaveBeenCalledTimes(1);
    expect(persistThreadStateMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        conversation: expect.anything(),
      }),
    );
    expect(postMessageMock).toHaveBeenNthCalledWith(2, {
      channel: "C123",
      thread_ts: "1712345.0001",
      text: "MCP authorization completed, but resuming the request failed. Please retry the original command.",
    });
  });

  it("re-parks the resumed turn when another MCP auth challenge is required", async () => {
    const { RetryableTurnError } = await import("@/chat/turn/errors");
    generateAssistantReplyMock.mockRejectedValueOnce(
      new RetryableTurnError("mcp_auth_resume", "auth required again"),
    );

    const response = await GET(
      makeRequest(
        "https://example.com/api/oauth/callback/mcp/demo?code=auth-code&state=state-123",
      ),
      makeContext("demo"),
    );

    expect(response.status).toBe(200);
    await afterCallbacks[0]!();

    expect(logWarnMock).toHaveBeenCalledWith(
      "mcp_oauth_callback_resume_reparked_for_auth",
      {},
      { "app.credential.provider": "demo" },
      "Resumed MCP turn requested another authorization flow",
    );
    expect(markTurnFailedMock).not.toHaveBeenCalled();
    expect(postMessageMock).toHaveBeenCalledTimes(1);
  });
});
