import type { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createApp } from "@/app";
import { JUNIOR_IOS_CLIENT } from "@/api/mcp/oauth/client-metadata";
import {
  authenticateSignInSession,
  createSignInSession,
} from "@/chat/sign-in/sessions";
import {
  createPkce,
  MCP_TEST_ALLOWED_DOMAINS,
  MCP_TEST_ORIGIN,
  MCP_TEST_OTHER_VIEWER,
  MCP_TEST_REDIRECT_URI,
  MCP_TEST_URL,
  MCP_TEST_VIEWER,
  type McpTokenBody,
  mockMcpDashboardConfig,
  requestMcpTokens,
  viewerCookie,
} from "../../fixtures/mcp-http";
import { MCP_CLIENT_ID } from "../../msw/handlers/mcp-client-metadata";

mockMcpDashboardConfig();

const [IOS_REDIRECT_URI = ""] = JUNIOR_IOS_CLIENT.redirectUris;

function authorizeUrl(params: Record<string, string>): string {
  const url = new URL(`${MCP_TEST_ORIGIN}/_junior/client/sign-in/authorize`);
  for (const [name, value] of Object.entries({
    client_id: JUNIOR_IOS_CLIENT.clientId,
    code_challenge_method: "S256",
    redirect_uri: IOS_REDIRECT_URI,
    ...params,
  })) {
    url.searchParams.set(name, value);
  }
  return url.toString();
}

/** Open the confirmation page as one viewer and return its form token. */
async function openSignInPage(
  app: Hono,
  url: string,
  email: string,
): Promise<{ csrf?: string | undefined; html: string; status: number }> {
  const response = await app.request(url, {
    headers: { cookie: viewerCookie(email) },
  });
  const html = await response.text();
  return {
    csrf: html.match(/name="csrf" value="([^"]+)"/)?.[1],
    html,
    status: response.status,
  };
}

async function confirmSignIn(
  app: Hono,
  args: { action?: string; csrf: string; email: string; url: string },
): Promise<Response> {
  return await app.request(args.url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: viewerCookie(args.email),
      origin: MCP_TEST_ORIGIN,
    },
    body: new URLSearchParams({
      action: args.action ?? "approve",
      csrf: args.csrf,
    }),
  });
}

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

async function requestSessionMcpTokens(
  app: Hono,
  sessionToken: string,
): Promise<Response> {
  return await app.request(`${MCP_TEST_ORIGIN}/api/client/mcp-token`, {
    method: "POST",
    headers: { authorization: `Bearer ${sessionToken}` },
  });
}

async function listTools(app: Hono, token: string): Promise<Response> {
  return await app.request(MCP_TEST_URL, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
}

function refresh(app: Hono, refreshToken: string): Promise<Response> {
  return requestMcpTokens(app, {
    client_id: JUNIOR_IOS_CLIENT.clientId,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    resource: MCP_TEST_URL,
  });
}

async function signInApp(app: Hono): Promise<string> {
  const pkce = createPkce();
  const url = authorizeUrl({ code_challenge: pkce.challenge });
  const page = await openSignInPage(app, url, MCP_TEST_VIEWER);
  const confirmed = await confirmSignIn(app, {
    csrf: page.csrf ?? "",
    email: MCP_TEST_VIEWER,
    url,
  });
  const code =
    new URL(confirmed.headers.get("location") ?? "").searchParams.get("code") ??
    "";
  const issued = await exchange(app, code, pkce.verifier);
  return ((await issued.json()) as { token: string }).token;
}

describe("client sign-in", () => {
  it("gives the app a 30-day session after the user confirms", async () => {
    const app = await createApp({ allowedDomains: MCP_TEST_ALLOWED_DOMAINS });
    const pkce = createPkce();
    const url = authorizeUrl({
      code_challenge: pkce.challenge,
      state: "app-state",
    });

    const page = await openSignInPage(app, url, MCP_TEST_VIEWER);
    expect(page.status).toBe(200);
    expect(page.html).toContain(`wants to sign in as ${MCP_TEST_VIEWER}`);

    // Only the user who opened the page can confirm it.
    expect(
      (
        await confirmSignIn(app, {
          csrf: page.csrf ?? "",
          email: MCP_TEST_OTHER_VIEWER,
          url,
        })
      ).status,
    ).toBe(403);
    const confirmed = await confirmSignIn(app, {
      csrf: page.csrf ?? "",
      email: MCP_TEST_VIEWER,
      url,
    });
    const callback = new URL(confirmed.headers.get("location") ?? "");
    expect(`${callback.protocol}//${callback.host}${callback.pathname}`).toBe(
      IOS_REDIRECT_URI,
    );
    expect(callback.searchParams.get("state")).toBe("app-state");
    const code = callback.searchParams.get("code") ?? "";

    expect((await exchange(app, code, createPkce().verifier)).status).toBe(400);
    const issued = await exchange(app, code, pkce.verifier);
    expect(issued.headers.get("cache-control")).toBe("no-store");
    const body = (await issued.json()) as { expires_at: string; token: string };
    expect(body.token).toMatch(/^jr_ses_/);
    const lifetimeDays =
      (Date.parse(body.expires_at) - Date.now()) / (24 * 60 * 60 * 1000);
    expect(Math.round(lifetimeDays)).toBe(30);
    expect(await authenticateSignInSession(body.token)).toMatchObject({
      client: "ios",
      user: { email: MCP_TEST_VIEWER },
    });

    // Each code and each confirmation works once.
    expect((await exchange(app, code, pkce.verifier)).status).toBe(400);
    expect(
      (
        await confirmSignIn(app, {
          csrf: page.csrf ?? "",
          email: MCP_TEST_VIEWER,
          url,
        })
      ).status,
    ).toBe(410);
  });

  it("sends a denied sign-in back to the app without a code", async () => {
    const app = await createApp({ allowedDomains: MCP_TEST_ALLOWED_DOMAINS });
    const url = authorizeUrl({ code_challenge: createPkce().challenge });
    const page = await openSignInPage(app, url, MCP_TEST_VIEWER);
    const denied = await confirmSignIn(app, {
      action: "deny",
      csrf: page.csrf ?? "",
      email: MCP_TEST_VIEWER,
      url,
    });
    const callback = new URL(denied.headers.get("location") ?? "");
    expect(callback.searchParams.get("error")).toBe("access_denied");
    expect(callback.searchParams.get("code")).toBeNull();
  });

  it("signs in only Junior's own apps at their own redirect", async () => {
    const app = await createApp({ allowedDomains: MCP_TEST_ALLOWED_DOMAINS });
    const challenge = createPkce().challenge;
    const requests: Record<string, string>[] = [
      { client_id: MCP_CLIENT_ID, redirect_uri: MCP_TEST_REDIRECT_URI },
      { redirect_uri: "junior-ios://other/callback" },
    ];
    for (const params of requests) {
      const page = await openSignInPage(
        app,
        authorizeUrl({ code_challenge: challenge, ...params }),
        MCP_TEST_VIEWER,
      );
      expect(page.status).toBe(400);
      expect(page.csrf).toBeUndefined();
    }

    // A web session cannot get MCP tokens.
    const web = await createSignInSession({
      client: "web",
      email: MCP_TEST_VIEWER,
      lifetimeMs: 60 * 60 * 1000,
    });
    expect((await requestSessionMcpTokens(app, web.token)).status).toBe(403);
  });

  it("gives the app session MCP tokens that end with the session", async () => {
    const app = await createApp({ allowedDomains: MCP_TEST_ALLOWED_DOMAINS });
    const sessionToken = await signInApp(app);

    expect((await requestSessionMcpTokens(app, "jr_ses_unknown")).status).toBe(
      401,
    );
    const issued = await requestSessionMcpTokens(app, sessionToken);
    expect(issued.headers.get("cache-control")).toBe("no-store");
    const tokens = (await issued.json()) as McpTokenBody;
    expect(tokens).toMatchObject({
      expires_in: 3600,
      scope:
        "conversations:read conversations:manage conversations:write inbox_items:read automations:read",
      token_type: "Bearer",
    });
    expect((await listTools(app, tokens.access_token)).status).toBe(200);
    // The session is not an MCP credential.
    expect((await listTools(app, sessionToken)).status).toBe(401);

    const refreshed = await refresh(app, tokens.refresh_token);
    expect(refreshed.status).toBe(200);
    const rotated = (await refreshed.json()) as McpTokenBody;

    const signedOut = await app.request(
      `${MCP_TEST_ORIGIN}/api/client/sign-out`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${sessionToken}` },
      },
    );
    expect(signedOut.status).toBe(204);
    expect(await authenticateSignInSession(sessionToken)).toBeUndefined();
    expect((await listTools(app, rotated.access_token)).status).toBe(401);
    expect((await refresh(app, rotated.refresh_token)).status).toBe(400);
    expect((await requestSessionMcpTokens(app, sessionToken)).status).toBe(401);
  });

  it("ends the MCP grant no later than the session", async () => {
    const app = await createApp({ allowedDomains: MCP_TEST_ALLOWED_DOMAINS });
    const session = await createSignInSession({
      client: "ios",
      email: MCP_TEST_VIEWER,
      lifetimeMs: 10 * 60 * 1000,
    });
    const issued = await requestSessionMcpTokens(app, session.token);
    const tokens = (await issued.json()) as McpTokenBody;
    expect(tokens.expires_in).toBeGreaterThan(590);
    expect(tokens.expires_in).toBeLessThanOrEqual(600);
  });
});
