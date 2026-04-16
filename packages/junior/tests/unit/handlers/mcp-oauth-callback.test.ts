import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  waitUntilCallbacks,
  coerceThreadArtifactsStateMock,
  coerceThreadConversationStateMock,
  buildConversationContextMock,
  deleteMcpAuthSessionMock,
  finalizeMcpAuthorizationMock,
  generateAssistantReplyMock,
  getChannelConfigurationServiceByIdMock,
  getPersistedSandboxStateMock,
  getPersistedThreadStateMock,
  logWarnMock,
  markConversationMessageMock,
  markTurnCompletedMock,
  markTurnFailedMock,
  mergeArtifactsStateMock,
  persistThreadStateByIdMock,
  postMessageMock,
  setStatusMock,
  updateConversationStatsMock,
  uploadFilesToThreadMock,
  upsertConversationMessageMock,
} = vi.hoisted(() => ({
  waitUntilCallbacks: [] as Array<() => Promise<unknown> | void>,
  coerceThreadArtifactsStateMock: vi.fn(),
  coerceThreadConversationStateMock: vi.fn(),
  buildConversationContextMock: vi.fn(),
  deleteMcpAuthSessionMock: vi.fn(),
  finalizeMcpAuthorizationMock: vi.fn(),
  generateAssistantReplyMock: vi.fn(),
  getChannelConfigurationServiceByIdMock: vi.fn(),
  getPersistedSandboxStateMock: vi.fn(),
  getPersistedThreadStateMock: vi.fn(),
  logWarnMock: vi.fn(),
  markConversationMessageMock: vi.fn(),
  markTurnCompletedMock: vi.fn(),
  markTurnFailedMock: vi.fn(),
  mergeArtifactsStateMock: vi.fn(),
  persistThreadStateByIdMock: vi.fn(),
  postMessageMock: vi.fn(),
  setStatusMock: vi.fn(),
  updateConversationStatsMock: vi.fn(),
  uploadFilesToThreadMock: vi.fn(),
  upsertConversationMessageMock: vi.fn(),
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

vi.mock("@/chat/config", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/chat/config")>();
  const memoryConfig = original.readChatConfig({
    ...process.env,
    JUNIOR_STATE_ADAPTER: "memory",
  });
  return {
    ...original,
    botConfig: memoryConfig.bot,
    getChatConfig: () => memoryConfig,
  };
});

vi.mock("@/chat/slack/client", () => ({
  SlackActionError: class SlackActionError extends Error {
    code: string;

    constructor(message: string, code: string) {
      super(message);
      this.name = "SlackActionError";
      this.code = code;
    }
  },
  normalizeSlackConversationId: (value: string | undefined) => value,
  withSlackRetries: async (task: () => Promise<unknown>) => await task(),
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
}));

vi.mock("@/chat/slack/outbound", () => ({
  uploadFilesToThread: uploadFilesToThreadMock,
  postSlackMessage: vi.fn(),
}));

vi.mock("@/chat/logging", () => ({
  logException: vi.fn(),
  logWarn: logWarnMock,
}));

vi.mock("@/chat/state/conversation", () => ({
  coerceThreadConversationState: coerceThreadConversationStateMock,
}));

vi.mock("@/chat/runtime/thread-state", () => ({
  getChannelConfigurationServiceById: getChannelConfigurationServiceByIdMock,
  getPersistedSandboxState: getPersistedSandboxStateMock,
  getPersistedThreadState: getPersistedThreadStateMock,
  mergeArtifactsState: mergeArtifactsStateMock,
  persistThreadStateById: persistThreadStateByIdMock,
}));

vi.mock("@/chat/services/conversation-memory", () => ({
  buildConversationContext: buildConversationContextMock,
  generateConversationId: () => "assistant-1",
  markConversationMessage: markConversationMessageMock,
  normalizeConversationText: (text: string) => text.trim(),
  upsertConversationMessage: upsertConversationMessageMock,
  updateConversationStats: updateConversationStatsMock,
}));

vi.mock("@/chat/state/artifacts", () => ({
  coerceThreadArtifactsState: coerceThreadArtifactsStateMock,
}));

vi.mock("@/chat/runtime/turn", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/chat/runtime/turn")>()),
  markTurnCompleted: markTurnCompletedMock,
  markTurnFailed: markTurnFailedMock,
}));

import { GET } from "@/handlers/mcp-oauth-callback";
import type { WaitUntilFn } from "@/handlers/types";

function makeRequest(url: string): Request {
  return new Request(url, { method: "GET" });
}

const testWaitUntil: WaitUntilFn = (task) => {
  waitUntilCallbacks.push(typeof task === "function" ? task : () => task);
};

describe("mcp oauth callback handler", () => {
  beforeEach(() => {
    waitUntilCallbacks.length = 0;
    coerceThreadArtifactsStateMock.mockReset();
    coerceThreadConversationStateMock.mockReset();
    buildConversationContextMock.mockReset();
    deleteMcpAuthSessionMock.mockReset();
    finalizeMcpAuthorizationMock.mockReset();
    generateAssistantReplyMock.mockReset();
    getChannelConfigurationServiceByIdMock.mockReset();
    getPersistedSandboxStateMock.mockReset();
    getPersistedThreadStateMock.mockReset();
    logWarnMock.mockReset();
    markConversationMessageMock.mockReset();
    markTurnCompletedMock.mockReset();
    markTurnFailedMock.mockReset();
    mergeArtifactsStateMock.mockReset();
    persistThreadStateByIdMock.mockReset();
    postMessageMock.mockReset();
    setStatusMock.mockReset();
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
    postMessageMock.mockResolvedValue({ ts: "1700000000.100" });
    setStatusMock.mockResolvedValue(undefined);
    uploadFilesToThreadMock.mockResolvedValue(undefined);
    getPersistedThreadStateMock.mockResolvedValue({
      conversation: {},
      artifacts: {},
    });
    getChannelConfigurationServiceByIdMock.mockReturnValue({
      resolve: vi.fn(async (key: string) =>
        key === "demo.org" ? "acme" : undefined,
      ),
      resolveValues: vi.fn(async () => ({ "demo.org": "acme" })),
    });
    getPersistedSandboxStateMock.mockReturnValue({});
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
    buildConversationContextMock.mockReturnValue(
      "[user] Test User: budget deadline is Friday",
    );
    mergeArtifactsStateMock.mockImplementation((current, patch) => ({
      ...current,
      ...patch,
    }));
    deleteMcpAuthSessionMock.mockResolvedValue(undefined);
    persistThreadStateByIdMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns HTML 400 when the state parameter is missing", async () => {
    const response = await GET(
      makeRequest("https://example.com/api/oauth/callback/mcp/demo?code=abc"),
      "demo",
      testWaitUntil,
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Missing state parameter");
    expect(finalizeMcpAuthorizationMock).not.toHaveBeenCalled();
  });

  it("does not reflect provider error text in the HTML response", async () => {
    const response = await GET(
      makeRequest(
        "https://example.com/api/oauth/callback/mcp/demo?state=state-123&error=%3Cscript%3Ealert(1)%3C%2Fscript%3E",
      ),
      "demo",
      testWaitUntil,
    );

    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain("The provider returned an authorization error.");
    expect(body).not.toContain("<script>alert(1)</script>");
  });

  it("does not reflect callback exception text in the HTML response", async () => {
    finalizeMcpAuthorizationMock.mockRejectedValueOnce(
      new Error("<img src=x onerror=alert(1)>"),
    );

    const response = await GET(
      makeRequest(
        "https://example.com/api/oauth/callback/mcp/demo?code=auth-code&state=state-123",
      ),
      "demo",
      testWaitUntil,
    );

    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toContain(
      "Junior could not finish the authorization callback. Return to Slack and retry the original request.",
    );
    expect(body).not.toContain("<img src=x onerror=alert(1)>");
  });
});
