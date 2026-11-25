import type { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createApp } from "@/app";
import { JUNIOR_IOS_CLIENT } from "@/api/mcp/oauth/client-metadata";
import { authenticateSignInSession } from "@/chat/sign-in/sessions";
import {
  approveMcpConsent,
  createPkce,
  MCP_TEST_ALLOWED_DOMAINS,
  MCP_TEST_ORIGIN,
  MCP_TEST_REDIRECT_URI,
  MCP_TEST_VIEWER,
  mcpAuthorizeUrl,
  mockMcpDashboardConfig,
  openMcpConsentPage,
} from "../../fixtures/mcp-http";
import { MCP_CLIENT_ID } from "../../msw/handlers/mcp-client-metadata";

mockMcpDashboardConfig();

const [IOS_REDIRECT_URI = ""] = JUNIOR_IOS_CLIENT.redirectUris;

async function exchange(
  app: Hono,
  code: string,
  verifier: string,
): Promise<Response> {
  return await app.request(`${MCP_TEST_ORIGIN}/api/client/sign-in/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, code_verifier: verifier }),
  });
}

describe("client sign-in", () => {
  it("gives the app an MCP code and a 30-day session code from one consent", async () => {
    const app = await createApp({ allowedDomains: MCP_TEST_ALLOWED_DOMAINS });
    const mcp = createPkce();
    const session = createPkce();

    const authorize = await app.request(
      mcpAuthorizeUrl({
        client_id: JUNIOR_IOS_CLIENT.clientId,
        code_challenge: mcp.challenge,
        redirect_uri: IOS_REDIRECT_URI,
        session_code_challenge: session.challenge,
        state: "app-state",
      }),
    );
    const consentUrl = authorize.headers.get("location") ?? "";
    const page = await openMcpConsentPage(app, consentUrl, MCP_TEST_VIEWER);
    expect(page.html).toContain("Use the dashboard API as you for 30 days");
    const callback = new URL(
      (
        await approveMcpConsent(app, {
          consentUrl,
          csrf: page.csrf ?? "",
          email: MCP_TEST_VIEWER,
          referrerPolicy: page.referrerPolicy,
        })
      ).headers.get("location") ?? "",
    );
    expect(callback.searchParams.get("code")).toBeTruthy();
    expect(callback.searchParams.get("state")).toBe("app-state");
    const code = callback.searchParams.get("session_code") ?? "";

    // The session code takes its own verifier, not the MCP one.
    expect((await exchange(app, code, mcp.verifier)).status).toBe(400);
    const issued = await exchange(app, code, session.verifier);
    expect(issued.headers.get("cache-control")).toBe("no-store");
    const body = (await issued.json()) as { expires_at: string; token: string };
    expect(body.token).toMatch(/^jr_ses_/);
    const lifetimeDays =
      (Date.parse(body.expires_at) - Date.now()) / (24 * 60 * 60 * 1000);
    expect(Math.round(lifetimeDays)).toBe(30);
    expect(await authenticateSignInSession(body.token)).toMatchObject({
      email: MCP_TEST_VIEWER,
    });

    // Each code works once.
    expect((await exchange(app, code, session.verifier)).status).toBe(400);

    const signedOut = await app.request(
      `${MCP_TEST_ORIGIN}/api/client/sign-out`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${body.token}` },
      },
    );
    expect(signedOut.status).toBe(204);
    expect(await authenticateSignInSession(body.token)).toBeUndefined();
  });

  it("gives a session only to Junior's own apps", async () => {
    const app = await createApp({ allowedDomains: MCP_TEST_ALLOWED_DOMAINS });
    const authorize = await app.request(
      mcpAuthorizeUrl({
        client_id: MCP_CLIENT_ID,
        code_challenge: createPkce().challenge,
        redirect_uri: MCP_TEST_REDIRECT_URI,
        session_code_challenge: createPkce().challenge,
      }),
    );
    const location = new URL(authorize.headers.get("location") ?? "");
    expect(location.searchParams.get("error")).toBe("invalid_request");
  });
});
