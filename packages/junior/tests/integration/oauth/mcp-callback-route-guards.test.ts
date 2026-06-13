import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EVAL_MCP_AUTH_CODE,
  EVAL_MCP_AUTH_PROVIDER,
  createMcpOauthCallbackRouteFixture,
} from "../../fixtures/mcp/oauth-callback-route";

let testbed: Awaited<ReturnType<typeof createMcpOauthCallbackRouteFixture>>;

describe("mcp oauth callback route guards", () => {
  beforeEach(async () => {
    testbed = await createMcpOauthCallbackRouteFixture();
  }, 45_000);

  afterEach(async () => {
    await testbed.cleanup();
  }, 45_000);

  it("returns HTML 400 when the state parameter is missing", async () => {
    const response = await testbed.runCallbackUrl({
      url: `https://junior.example.com/api/oauth/callback/mcp/${EVAL_MCP_AUTH_PROVIDER}?code=${EVAL_MCP_AUTH_CODE}`,
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Missing state parameter");
  });

  it("does not reflect provider error text in the HTML response", async () => {
    const response = await testbed.runCallbackUrl({
      url: `https://junior.example.com/api/oauth/callback/mcp/${EVAL_MCP_AUTH_PROVIDER}?state=state-123&error=%3Cscript%3Ealert(1)%3C%2Fscript%3E`,
    });

    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain("The provider returned an authorization error.");
    expect(body).not.toContain("<script>alert(1)</script>");
  });

  it("returns HTML 400 when the code parameter is missing", async () => {
    const response = await testbed.runCallbackUrl({
      url: `https://junior.example.com/api/oauth/callback/mcp/${EVAL_MCP_AUTH_PROVIDER}?state=state-123`,
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Missing code parameter");
  });

  it("does not reflect callback exception text in the HTML response", async () => {
    const response = await testbed.runRoute({
      provider: EVAL_MCP_AUTH_PROVIDER,
      state: "<img src=x onerror=alert(1)>",
      code: EVAL_MCP_AUTH_CODE,
    });

    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toContain(
      "Junior could not finish the authorization callback. Return to Slack and retry the original request.",
    );
    expect(body).not.toContain("<img src=x onerror=alert(1)>");
  });
});
