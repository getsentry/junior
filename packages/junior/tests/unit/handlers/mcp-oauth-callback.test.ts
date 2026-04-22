import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WaitUntilFn } from "@/handlers/types";

const { finalizeMcpAuthorizationMock } = vi.hoisted(() => ({
  finalizeMcpAuthorizationMock: vi.fn(),
}));

vi.mock("@/chat/mcp/oauth", () => ({
  finalizeMcpAuthorization: finalizeMcpAuthorizationMock,
}));

import { GET } from "@/handlers/mcp-oauth-callback";

const waitUntilCallbacks: Array<() => Promise<unknown> | void> = [];

function makeRequest(url: string): Request {
  return new Request(url, { method: "GET" });
}

const testWaitUntil: WaitUntilFn = (task) => {
  waitUntilCallbacks.push(typeof task === "function" ? task : () => task);
};

describe("mcp oauth callback handler", () => {
  beforeEach(() => {
    finalizeMcpAuthorizationMock.mockReset();
    waitUntilCallbacks.length = 0;
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
    expect(waitUntilCallbacks).toHaveLength(0);
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
    expect(waitUntilCallbacks).toHaveLength(0);
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
    expect(waitUntilCallbacks).toHaveLength(0);
  });
});
