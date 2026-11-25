import type { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createApp } from "@/app";
import { authenticateSignInSession } from "@/chat/sign-in/sessions";
import {
  createPkce,
  MCP_TEST_ALLOWED_DOMAINS,
  MCP_TEST_ORIGIN,
  MCP_TEST_VIEWER,
  mockMcpDashboardConfig,
  viewerCookie,
} from "../../fixtures/mcp-http";

mockMcpDashboardConfig();

const SIGN_IN_URL = `${MCP_TEST_ORIGIN}/api/ios/sign-in`;

/** Confirm the sign-in page as the viewer and return the app redirect. */
async function confirm(
  app: Hono,
  challenge: string,
  origin = MCP_TEST_ORIGIN,
): Promise<Response> {
  return await app.request(SIGN_IN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: viewerCookie(MCP_TEST_VIEWER),
      origin,
    },
    body: new URLSearchParams({
      code_challenge: challenge,
      state: "app-state",
    }),
  });
}

async function exchange(
  app: Hono,
  code: string,
  verifier: string,
): Promise<Response> {
  return await app.request(`${MCP_TEST_ORIGIN}/api/ios/sign-in/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, code_verifier: verifier }),
  });
}

describe("iOS sign-in", () => {
  it("trades a confirmed code and its verifier for a 30-day session token", async () => {
    const app = await createApp({ allowedDomains: MCP_TEST_ALLOWED_DOMAINS });
    const pkce = createPkce();

    const page = await app.request(
      `${SIGN_IN_URL}?code_challenge=${pkce.challenge}&state=app-state`,
      { headers: { cookie: viewerCookie(MCP_TEST_VIEWER) } },
    );
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(MCP_TEST_VIEWER);
    expect(page.headers.get("content-security-policy")).toContain(
      "form-action 'self' junior-ios:",
    );

    // Another site cannot send a signed-in browser through the page.
    expect(
      (await confirm(app, pkce.challenge, "https://evil.test")).status,
    ).toBe(400);

    const redirect = new URL(
      (await confirm(app, pkce.challenge)).headers.get("location") ?? "",
    );
    expect(`${redirect.protocol}//${redirect.host}${redirect.pathname}`).toBe(
      "junior-ios://session/callback",
    );
    expect(redirect.searchParams.get("state")).toBe("app-state");
    const code = redirect.searchParams.get("code") ?? "";

    expect((await exchange(app, code, createPkce().verifier)).status).toBe(400);
    const issued = await exchange(app, code, pkce.verifier);
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
    expect((await exchange(app, code, pkce.verifier)).status).toBe(400);

    const signedOut = await app.request(`${MCP_TEST_ORIGIN}/api/ios/sign-out`, {
      method: "POST",
      headers: { authorization: `Bearer ${body.token}` },
    });
    expect(signedOut.status).toBe(204);
    expect(await authenticateSignInSession(body.token)).toBeUndefined();
  });
});
