import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  deleteMcpAuthSessionMock,
  finalizeMcpAuthorizationMock,
  getMcpAuthSessionMock,
  getMcpStoredOAuthCredentialsMock,
  getPersistedThreadStateMock,
  logExceptionMock,
  putMcpStoredOAuthCredentialsMock,
} = vi.hoisted(() => ({
  deleteMcpAuthSessionMock: vi.fn(),
  finalizeMcpAuthorizationMock: vi.fn(),
  getMcpAuthSessionMock: vi.fn(),
  getMcpStoredOAuthCredentialsMock: vi.fn(),
  getPersistedThreadStateMock: vi.fn(),
  logExceptionMock: vi.fn(),
  putMcpStoredOAuthCredentialsMock: vi.fn(),
}));

vi.mock("@/chat/logging", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/chat/logging")>()),
  logException: logExceptionMock,
}));

vi.mock("@/chat/mcp/oauth", () => ({
  finalizeMcpAuthorization: finalizeMcpAuthorizationMock,
}));

vi.mock("@/chat/mcp/auth-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/chat/mcp/auth-store")>()),
  deleteMcpAuthSession: deleteMcpAuthSessionMock,
  getMcpAuthSession: getMcpAuthSessionMock,
  getMcpStoredOAuthCredentials: getMcpStoredOAuthCredentialsMock,
  putMcpStoredOAuthCredentials: putMcpStoredOAuthCredentialsMock,
}));

vi.mock("@/chat/runtime/thread-state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/chat/runtime/thread-state")>()),
  getPersistedThreadState: getPersistedThreadStateMock,
}));

vi.mock("@/chat/conversations/projection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/chat/conversations/projection")>()),
  recordAuthenticationLinked: vi.fn(async () => undefined),
}));

vi.mock("@/chat/oauth-flow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/chat/oauth-flow")>()),
  formatProviderLabel: (provider: string) => provider,
}));

import { GET } from "@/handlers/mcp-oauth-callback";
import { botConfig } from "@/chat/config";
import { McpProviderError } from "@/chat/mcp/errors";
import {
  createWaitUntilCollector,
  type WaitUntilCollector,
} from "../../fixtures/wait-until";
import { neverRunAgentRunner } from "../../fixtures/agent-runner";

let waitUntil: WaitUntilCollector;

function makeRequest(url: string): Request {
  return new Request(url, { method: "GET" });
}

const testAgentRunner = neverRunAgentRunner();

describe("mcp oauth callback handler", () => {
  beforeEach(() => {
    deleteMcpAuthSessionMock.mockReset();
    finalizeMcpAuthorizationMock.mockReset();
    getMcpAuthSessionMock.mockReset();
    getMcpStoredOAuthCredentialsMock.mockReset();
    getPersistedThreadStateMock.mockReset();
    logExceptionMock.mockReset();
    putMcpStoredOAuthCredentialsMock.mockReset();
    getMcpStoredOAuthCredentialsMock.mockResolvedValue(undefined);
    putMcpStoredOAuthCredentialsMock.mockResolvedValue(undefined);
    getMcpAuthSessionMock.mockResolvedValue({
      schemaVersion: 2,
      authSessionId: "state-123",
      provider: "demo",
      userId: "U123",
      conversationId: "slack:C123:1700000000.001",
      sessionId: "turn-1",
      userMessage: "use MCP",
      channelId: "C123",
      threadTs: "1700000000.001",
      createdAtMs: 1,
      updatedAtMs: 1,
    });
    getPersistedThreadStateMock.mockResolvedValue({
      conversation: {
        processing: {
          pendingAuth: {
            authSessionId: "state-123",
            kind: "mcp",
            provider: "demo",
            actorId: "U123",
            sessionId: "turn-1",
            linkSentAtMs: 1,
          },
        },
      },
    });
    waitUntil = createWaitUntilCollector();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns HTML 400 when the state parameter is missing", async () => {
    const response = await GET(
      makeRequest("https://example.com/api/oauth/callback/mcp/demo?code=abc"),
      "demo",
      waitUntil.fn,
      { agentRunner: testAgentRunner },
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(await response.text()).toContain("Missing state parameter");
    expect(finalizeMcpAuthorizationMock).not.toHaveBeenCalled();
    expect(waitUntil.pendingCount()).toBe(0);
  });

  it("does not reflect provider error text in the HTML response", async () => {
    const response = await GET(
      makeRequest(
        "https://example.com/api/oauth/callback/mcp/demo?state=state-123&error=%3Cscript%3Ealert(1)%3C%2Fscript%3E",
      ),
      "demo",
      waitUntil.fn,
      { agentRunner: testAgentRunner },
    );

    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain("The provider returned an authorization error.");
    expect(body).not.toContain("<script>alert(1)</script>");
    expect(waitUntil.pendingCount()).toBe(0);
  });

  it("clears stale DCR client and discovery state on provider error callbacks", async () => {
    getMcpStoredOAuthCredentialsMock.mockResolvedValue({
      clientInformation: { client_id: "stale-client" },
      discoveryState: { authorizationServerUrl: "https://old.example.com" },
      tokens: {
        access_token: "keep-me",
        token_type: "Bearer",
      },
    });

    const response = await GET(
      makeRequest(
        "https://example.com/api/oauth/callback/mcp/demo?state=state-123&error=access_denied",
      ),
      "demo",
      waitUntil.fn,
      { agentRunner: testAgentRunner },
    );

    expect(response.status).toBe(400);
    expect(putMcpStoredOAuthCredentialsMock).toHaveBeenCalledWith("U123", "demo", {
      tokens: {
        access_token: "keep-me",
        token_type: "Bearer",
      },
    });
    expect(deleteMcpAuthSessionMock).toHaveBeenCalledWith("state-123");
    expect(finalizeMcpAuthorizationMock).not.toHaveBeenCalled();
    expect(waitUntil.pendingCount()).toBe(0);
  });

  it("logs safe metadata for callback provider failures", async () => {
    finalizeMcpAuthorizationMock.mockRejectedValueOnce(
      new McpProviderError({
        phase: "oauth_callback",
        provider: "demo",
        resourceHost: "mcp.example.com",
        status: 502,
      }),
    );

    const response = await GET(
      makeRequest(
        "https://example.com/api/oauth/callback/mcp/demo?code=auth-code&state=state-123",
      ),
      "demo",
      waitUntil.fn,
      { agentRunner: testAgentRunner },
    );

    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toContain(
      `${botConfig.userName} could not finish the authorization callback. Return to ${botConfig.userName} and retry the original request.`,
    );
    expect(logExceptionMock).toHaveBeenCalledWith(
      expect.any(McpProviderError),
      "mcp.oauth_callback.failed",
      expect.objectContaining({
        "app.credential.provider": "demo",
        "app.mcp.error.phase": "oauth_callback",
        "http.response.status_code": 502,
        "server.address": "mcp.example.com",
      }),
    );
    expect(waitUntil.pendingCount()).toBe(0);
  });

  it("expires callbacks that do not match the current pending attempt", async () => {
    getPersistedThreadStateMock.mockResolvedValue({
      conversation: {
        processing: {
          pendingAuth: {
            authSessionId: "newer-state",
            kind: "mcp",
            provider: "demo",
            actorId: "U123",
            sessionId: "turn-1",
            linkSentAtMs: 1,
          },
        },
      },
    });

    const response = await GET(
      makeRequest(
        "https://example.com/api/oauth/callback/mcp/demo?code=auth-code&state=state-123",
      ),
      "demo",
      waitUntil.fn,
      { agentRunner: testAgentRunner },
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain(
      "This authorization link is no longer active.",
    );
    expect(finalizeMcpAuthorizationMock).not.toHaveBeenCalled();
    expect(deleteMcpAuthSessionMock).toHaveBeenCalledWith("state-123");
  });

  it("rechecks the exact attempt inside shared credential mutations", async () => {
    const mutation = vi.fn();
    getPersistedThreadStateMock
      .mockResolvedValueOnce({
        conversation: {
          processing: {
            pendingAuth: {
              authSessionId: "state-123",
              kind: "mcp",
              provider: "demo",
              actorId: "U123",
              sessionId: "turn-1",
              linkSentAtMs: 1,
            },
          },
        },
      })
      .mockResolvedValueOnce({
        conversation: {
          processing: {
            pendingAuth: {
              authSessionId: "newer-state",
              kind: "mcp",
              provider: "demo",
              actorId: "U123",
              sessionId: "turn-1",
              linkSentAtMs: 2,
            },
          },
        },
      });
    finalizeMcpAuthorizationMock.mockImplementationOnce(
      async (_provider, _state, _code, runCredentialMutation) => {
        await runCredentialMutation(mutation);
      },
    );

    const response = await GET(
      makeRequest(
        "https://example.com/api/oauth/callback/mcp/demo?code=auth-code&state=state-123",
      ),
      "demo",
      waitUntil.fn,
      { agentRunner: testAgentRunner },
    );

    expect(response.status).toBe(400);
    expect(mutation).not.toHaveBeenCalled();
    expect(deleteMcpAuthSessionMock).toHaveBeenCalledWith("state-123");
  });

  it("returns local close guidance after successful local MCP authorization", async () => {
    const localSession = {
      schemaVersion: 2,
      authSessionId: "state-123",
      provider: "demo",
      userId: "U123",
      conversationId: "local:thread",
      destination: { platform: "local", threadId: "local:thread" },
      sessionId: "turn-1",
      userMessage: "use MCP",
      createdAtMs: 1,
      updatedAtMs: 1,
    };
    getMcpAuthSessionMock.mockResolvedValue(localSession);
    finalizeMcpAuthorizationMock.mockResolvedValueOnce(localSession);

    const response = await GET(
      makeRequest(
        "https://example.com/api/oauth/callback/mcp/demo?code=auth-code&state=state-123",
      ),
      "demo",
      waitUntil.fn,
      { agentRunner: testAgentRunner },
    );

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("Your MCP access is connected");
    expect(body).toContain("in the local client");
    expect(body).toContain(
      `You can close this tab and return to ${botConfig.userName}.`,
    );
    expect(body).not.toContain("You can close this tab and return to Slack.");
    expect(waitUntil.pendingCount()).toBe(0);
  });

  it("keeps web success copy when destination is local", async () => {
    const webSession = {
      schemaVersion: 2,
      authSessionId: "state-123",
      provider: "demo",
      userId: "dashboard:alice",
      conversationId: "local:web:alice",
      destination: { platform: "local", conversationId: "local:web:alice" },
      source: {
        kind: "web",
        conversationId: "local:web:alice",
        visibility: "private",
      },
      sessionId: "turn-1",
      userMessage: "use MCP",
      createdAtMs: 1,
      updatedAtMs: 1,
    };
    getMcpAuthSessionMock.mockResolvedValue(webSession);
    finalizeMcpAuthorizationMock.mockResolvedValueOnce(webSession);
    getPersistedThreadStateMock.mockResolvedValue({
      conversation: {
        processing: {
          pendingAuth: {
            authSessionId: "state-123",
            kind: "mcp",
            provider: "demo",
            actorId: "dashboard:alice",
            sessionId: "turn-1",
            linkSentAtMs: 1,
          },
        },
      },
    });

    const response = await GET(
      makeRequest(
        "https://example.com/api/oauth/callback/mcp/demo?code=auth-code&state=state-123",
      ),
      "demo",
      waitUntil.fn,
      { agentRunner: testAgentRunner },
    );

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("Your MCP access is connected");
    expect(body).not.toContain("in the local client");
    expect(body).toContain(
      `You can close this tab and return to ${botConfig.userName}.`,
    );
  });
});
