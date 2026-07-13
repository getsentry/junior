import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  deleteMcpAuthSessionMock,
  finalizeMcpAuthorizationMock,
  getMcpAuthSessionMock,
  getPersistedThreadStateMock,
} = vi.hoisted(() => ({
  deleteMcpAuthSessionMock: vi.fn(),
  finalizeMcpAuthorizationMock: vi.fn(),
  getMcpAuthSessionMock: vi.fn(),
  getPersistedThreadStateMock: vi.fn(),
}));

vi.mock("@/chat/mcp/oauth", () => ({
  finalizeMcpAuthorization: finalizeMcpAuthorizationMock,
}));

vi.mock("@/chat/mcp/auth-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/chat/mcp/auth-store")>()),
  deleteMcpAuthSession: deleteMcpAuthSessionMock,
  getMcpAuthSession: getMcpAuthSessionMock,
}));

vi.mock("@/chat/runtime/thread-state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/chat/runtime/thread-state")>()),
  getPersistedThreadState: getPersistedThreadStateMock,
}));

import { GET } from "@/handlers/mcp-oauth-callback";
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
    getPersistedThreadStateMock.mockReset();
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

  it("does not reflect callback exception text in the HTML response", async () => {
    finalizeMcpAuthorizationMock.mockRejectedValueOnce(
      new Error("<img src=x onerror=alert(1)>"),
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
      "Junior could not finish the authorization callback. Return to Slack and retry the original request.",
    );
    expect(body).not.toContain("<img src=x onerror=alert(1)>");
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
});
