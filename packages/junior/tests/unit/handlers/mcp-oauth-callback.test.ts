import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { finalizeMcpAuthorizationMock } = vi.hoisted(() => ({
  finalizeMcpAuthorizationMock: vi.fn(),
}));

vi.mock("@/chat/mcp/oauth", () => ({
  finalizeMcpAuthorization: finalizeMcpAuthorizationMock,
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
    finalizeMcpAuthorizationMock.mockReset();
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
});
