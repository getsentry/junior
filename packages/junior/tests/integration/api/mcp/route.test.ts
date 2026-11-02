import { createHash, randomBytes } from "node:crypto";
import type { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "@/app";
import { appendConversationBrief } from "@/chat/briefs/store";
import { getConversationEventStore, getDb, getSqlExecutor } from "@/chat/db";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import { insertReviewItem } from "@/chat/review-items/store";
import { juniorConversationParticipants } from "@/db/schema";
import { createPersonalToken } from "@/personal-tokens/store";
import {
  MCP_TEST_ORIGIN,
  MCP_TEST_URL,
  mockMcpDashboardConfig,
  viewerCookie,
  withMcpClient,
} from "../../../fixtures/mcp-http";
import { conversationBriefFixture } from "../../../fixtures/conversation-brief";
import {
  MCP_CLIENT_ID,
  MCP_CLIENT_NAME,
  MCP_MISMATCHED_CLIENT_ID,
} from "../../../msw/handlers/mcp-client-metadata";

const ALLOWED_DOMAINS = ["example.com"];
const VIEWER = "mcp-viewer@example.com";
const OTHER_VIEWER = "mcp-other@example.com";
// Claude Code listens on a random loopback port.
const REDIRECT_URI = "http://127.0.0.1:53682/callback";
const ALL_SCOPES =
  "conversations:read conversations:manage review_items:read automations:read";

type TokenBody = {
  access_token: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
  token_type: string;
};

mockMcpDashboardConfig();

/** Create one RFC 7636 PKCE verifier and its S256 challenge. */
function createPkce(): { challenge: string; verifier: string } {
  const verifier = randomBytes(32).toString("base64url");
  return {
    challenge: createHash("sha256").update(verifier).digest("base64url"),
    verifier,
  };
}

/** Build an authorization request URL with valid defaults. */
function authorizeUrl(params: Record<string, string>): string {
  const url = new URL(`${MCP_TEST_ORIGIN}/api/mcp/oauth/authorize`);
  for (const [name, value] of Object.entries({
    response_type: "code",
    code_challenge_method: "S256",
    scope: "conversations:read",
    resource: MCP_TEST_URL,
    ...params,
  })) {
    url.searchParams.set(name, value);
  }
  return url.toString();
}

/** Open the consent page as one viewer and return its form token. */
async function openConsentPage(
  app: Hono,
  consentUrl: string,
  email: string,
): Promise<{ csrf?: string; html: string; status: number }> {
  const response = await app.request(consentUrl, {
    headers: { cookie: viewerCookie(email) },
  });
  const html = await response.text();
  return {
    csrf: html.match(/name="csrf" value="([^"]+)"/)?.[1],
    html,
    status: response.status,
  };
}

/** Approve consent as the viewer who opened the page. */
async function approveConsent(
  app: Hono,
  args: { consentUrl: string; csrf: string; email: string },
): Promise<Response> {
  return await app.request(args.consentUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: viewerCookie(args.email),
      origin: MCP_TEST_ORIGIN,
    },
    body: new URLSearchParams({ action: "approve", csrf: args.csrf }),
  });
}

/** POST one form-encoded request to the MCP token endpoint. */
async function requestTokens(
  app: Hono,
  params: Record<string, string>,
): Promise<Response> {
  return await app.request(`${MCP_TEST_ORIGIN}/api/mcp/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
}

/** Send a raw `tools/list` request with one bearer token. */
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

/** Store one root Conversation that the named viewer takes part in. */
async function seedConversation(args: {
  conversationId: string;
  email: string;
  title: string;
}): Promise<void> {
  const sql = getSqlExecutor();
  await createSqlStore(sql).recordActivity({
    conversationId: args.conversationId,
    destination: { channelId: "C123", platform: "slack", teamId: "T123" },
    nowMs: Date.now(),
    title: args.title,
    visibility: "public",
  });
  const viewer = await resolveViewerUser(args.email);
  if (!viewer) throw new Error(`missing viewer for ${args.email}`);
  await sql.db().insert(juniorConversationParticipants).values({
    lastMessageAt: new Date(),
    rootConversationId: args.conversationId,
    userId: viewer.id,
  });
}

/** Approve the test client as one viewer and return its code and verifier. */
async function approveClient(
  app: Hono,
  email: string,
  scope = "conversations:read",
): Promise<{ code: string; consentHtml: string; verifier: string }> {
  const pkce = createPkce();
  const authorize = await app.request(
    authorizeUrl({
      client_id: MCP_CLIENT_ID,
      code_challenge: pkce.challenge,
      redirect_uri: REDIRECT_URI,
      scope,
    }),
  );
  const consentUrl = authorize.headers.get("location") ?? "";
  const page = await openConsentPage(app, consentUrl, email);
  const approved = await approveConsent(app, {
    consentUrl,
    csrf: page.csrf ?? "",
    email,
  });
  const code = new URL(approved.headers.get("location") ?? "").searchParams.get(
    "code",
  );
  if (!code) throw new Error("MCP consent returned no code");
  return { code, consentHtml: page.html, verifier: pkce.verifier };
}

/** Connect the test client as one viewer and return its access token. */
async function connect(app: Hono, email: string, scope = ALL_SCOPES) {
  const response = await exchangeCode(
    app,
    await approveClient(app, email, scope),
  );
  return ((await response.json()) as TokenBody).access_token;
}

/** Call one tool with the official MCP SDK client. */
async function callTool(
  app: Hono,
  token: string,
  name: string,
  args: Record<string, unknown> = {},
) {
  return await withMcpClient(app, token, (client) =>
    client.callTool({ name, arguments: args }),
  );
}

function exchangeCode(
  app: Hono,
  args: { code: string; verifier: string },
): Promise<Response> {
  return requestTokens(app, {
    client_id: MCP_CLIENT_ID,
    code: args.code,
    code_verifier: args.verifier,
    grant_type: "authorization_code",
    redirect_uri: REDIRECT_URI,
    resource: MCP_TEST_URL,
  });
}

function refresh(app: Hono, refreshToken: string): Promise<Response> {
  return requestTokens(app, {
    client_id: MCP_CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    resource: MCP_TEST_URL,
  });
}

describe("remote MCP HTTP", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("connects a CIMD client and lists only the signed-in user's Conversations", async () => {
    const app = await createApp({ allowedDomains: ALLOWED_DOMAINS });
    const pkce = createPkce();
    await seedConversation({
      conversationId: "slack:C123:1700000000.000100",
      email: VIEWER,
      title: "Viewer launch plan",
    });
    await seedConversation({
      conversationId: "slack:C123:1700000000.000200",
      email: OTHER_VIEWER,
      title: "Other person's roadmap",
    });

    const challenge = await app.request(MCP_TEST_URL, { method: "POST" });
    const resourceMetadataURL = challenge.headers
      .get("www-authenticate")
      ?.match(/resource_metadata="([^"]+)"/)?.[1];
    const resource = await app.request(resourceMetadataURL ?? "");
    const resourceMetadata = (await resource.json()) as {
      authorization_servers: string[];
    };
    const server = await app.request(
      `${resourceMetadata.authorization_servers[0]}/.well-known/oauth-authorization-server`,
    );
    const serverMetadata = (await server.json()) as {
      authorization_endpoint: string;
    };

    const authorize = await app.request(
      `${serverMetadata.authorization_endpoint}?${new URL(
        authorizeUrl({
          client_id: MCP_CLIENT_ID,
          code_challenge: pkce.challenge,
          redirect_uri: REDIRECT_URI,
          state: "client-state",
        }),
      ).searchParams.toString()}`,
    );
    const consentUrl = authorize.headers.get("location") ?? "";
    const page = await openConsentPage(app, consentUrl, VIEWER);
    const otherPage = await openConsentPage(app, consentUrl, OTHER_VIEWER);
    const approved = await approveConsent(app, {
      consentUrl,
      csrf: page.csrf ?? "",
      email: VIEWER,
    });
    const callback = new URL(approved.headers.get("location") ?? "");
    const issued = await exchangeCode(app, {
      code: callback.searchParams.get("code") ?? "",
      verifier: pkce.verifier,
    });
    const tokens = (await issued.json()) as TokenBody;
    const listed = await withMcpClient(app, tokens.access_token, (client) =>
      client.callTool({ name: "searchConversations", arguments: {} }),
    );
    const rotated = await refresh(app, tokens.refresh_token);
    const rotatedTokens = (await rotated.json()) as TokenBody;
    const rotatedSearch = await withMcpClient(
      app,
      rotatedTokens.access_token,
      (client) =>
        client.callTool({
          name: "searchConversations",
          arguments: { q: "roadmap" },
        }),
    );

    expect(challenge.status).toBe(401);
    expect(resourceMetadata).toEqual({
      resource: MCP_TEST_URL,
      authorization_servers: [MCP_TEST_ORIGIN],
      bearer_methods_supported: ["header"],
      scopes_supported: ALL_SCOPES.split(" "),
    });
    expect(serverMetadata).toEqual({
      issuer: MCP_TEST_ORIGIN,
      authorization_endpoint: `${MCP_TEST_ORIGIN}/api/mcp/oauth/authorize`,
      token_endpoint: `${MCP_TEST_ORIGIN}/api/mcp/oauth/token`,
      scopes_supported: ALL_SCOPES.split(" "),
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: true,
    });
    expect(page.status).toBe(200);
    expect(page.html).toContain(`Connect ${MCP_CLIENT_NAME}`);
    expect(page.html).toContain("mcp-client.example.test");
    expect(otherPage.status).toBe(403);
    expect(`${callback.origin}${callback.pathname}`).toBe(REDIRECT_URI);
    expect(callback.searchParams.get("state")).toBe("client-state");
    expect(callback.searchParams.get("iss")).toBe(MCP_TEST_ORIGIN);
    expect(issued.status).toBe(200);
    expect(issued.headers.get("cache-control")).toBe("no-store");
    expect(tokens).toEqual({
      access_token: expect.stringMatching(/^jr_mcp_at_/),
      expires_in: 3600,
      refresh_token: expect.stringMatching(/^jr_mcp_rt_/),
      scope: "conversations:read",
      token_type: "Bearer",
    });
    expect(listed).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify(listed.structuredContent),
        },
      ],
      structuredContent: {
        conversations: [
          {
            conversationId: "slack:C123:1700000000.000100",
            title: "Viewer launch plan",
            status: "completed",
            surface: "slack",
            startedAt: expect.any(String),
            lastSeenAt: expect.any(String),
            url: `${MCP_TEST_ORIGIN}/conversations/${encodeURIComponent("slack:C123:1700000000.000100")}`,
          },
        ],
      },
    });
    expect(rotated.status).toBe(200);
    expect(rotatedTokens.refresh_token).not.toBe(tokens.refresh_token);
    expect(rotatedSearch).toMatchObject({
      structuredContent: { conversations: [] },
    });
  });

  it("rejects a personal token and a token for a domain that is no longer allowed", async () => {
    const app = await createApp({ allowedDomains: ALLOWED_DOMAINS });
    const personal = await createPersonalToken({
      email: VIEWER,
      name: "MCP rejected token",
    });
    const tokens = (await (
      await exchangeCode(app, await approveClient(app, VIEWER))
    ).json()) as TokenBody;

    const response = await listTools(app, personal.token);
    const removedDomain = await listTools(
      await createApp({ allowedDomains: ["other.example"] }),
      tokens.access_token,
    );

    expect(removedDomain.status).toBe(401);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer error="invalid_token", resource_metadata="${MCP_TEST_ORIGIN}/.well-known/oauth-protected-resource/api/mcp", scope="${ALL_SCOPES}"`,
    );
  });

  it("ends a grant 30 days after consent even when it is refreshed", async () => {
    const app = await createApp({ allowedDomains: ALLOWED_DOMAINS });
    const day = 24 * 60 * 60 * 1000;
    const startMs = Date.now();
    const tokens = (await (
      await exchangeCode(app, await approveClient(app, VIEWER))
    ).json()) as TokenBody;

    vi.useFakeTimers({ now: startMs + 29 * day, toFake: ["Date"] });
    const refreshed = (await (
      await refresh(app, tokens.refresh_token)
    ).json()) as TokenBody;
    vi.setSystemTime(startMs + 31 * day);
    const afterEnd = await refresh(app, refreshed.refresh_token);

    expect(refreshed.refresh_token).toMatch(/^jr_mcp_rt_/);
    expect(afterEnd.status).toBe(400);
    await expect(afterEnd.json()).resolves.toMatchObject({
      error: "invalid_grant",
    });
  });

  it("revokes the grant when a code or a rotated refresh token is reused", async () => {
    const app = await createApp({ allowedDomains: ALLOWED_DOMAINS });
    const approval = await approveClient(app, VIEWER);
    const first = (await (
      await exchangeCode(app, approval)
    ).json()) as TokenBody;
    const reusedCode = await exchangeCode(app, approval);
    const afterCodeReuse = await refresh(app, first.refresh_token);

    const second = (await (
      await exchangeCode(app, await approveClient(app, VIEWER))
    ).json()) as TokenBody;
    const rotatedOnce = (await (
      await refresh(app, second.refresh_token)
    ).json()) as TokenBody;
    // A concurrent refresh by another client process loses without logout.
    const racedRefresh = await refresh(app, second.refresh_token);
    const rotated = (await (
      await refresh(app, rotatedOnce.refresh_token)
    ).json()) as TokenBody;
    vi.useFakeTimers({ now: Date.now() + 61_000, toFake: ["Date"] });
    const reusedRefresh = await refresh(app, rotatedOnce.refresh_token);
    const afterRefreshReuse = await refresh(app, rotated.refresh_token);
    const revokedAccess = await listTools(app, rotated.access_token);

    expect(reusedCode.status).toBe(400);
    await expect(reusedCode.json()).resolves.toMatchObject({
      error: "invalid_grant",
    });
    expect(afterCodeReuse.status).toBe(400);
    expect(racedRefresh.status).toBe(400);
    expect(rotated.access_token).toMatch(/^jr_mcp_at_/);
    expect(reusedRefresh.status).toBe(400);
    await expect(reusedRefresh.json()).resolves.toMatchObject({
      error: "invalid_grant",
    });
    expect(afterRefreshReuse.status).toBe(400);
    expect(revokedAccess.status).toBe(401);
  });

  it.each([
    ["a private IP client ID", "https://10.0.0.5/client.json", REDIRECT_URI],
    [
      "a document for another client ID",
      MCP_MISMATCHED_CLIENT_ID,
      REDIRECT_URI,
    ],
    ["an unregistered redirect URI", MCP_CLIENT_ID, "https://evil.example/cb"],
  ])(
    "shows an error without redirecting for %s",
    async (_, clientId, redirectUri) => {
      const app = await createApp({ allowedDomains: ALLOWED_DOMAINS });

      const response = await app.request(
        authorizeUrl({
          client_id: clientId,
          code_challenge: createPkce().challenge,
          redirect_uri: redirectUri,
        }),
      );

      expect(response.status).toBe(400);
      expect(response.headers.get("location")).toBeNull();
      await expect(response.text()).resolves.toContain(
        "This app cannot connect",
      );
    },
  );

  it("shows the requested scopes and lists only their tools", async () => {
    const app = await createApp({ allowedDomains: ALLOWED_DOMAINS });
    // An empty scope asks for every scope.
    const everyScope = await approveClient(app, VIEWER, "");
    const everyTokens = (await (
      await exchangeCode(app, everyScope)
    ).json()) as TokenBody;
    const readOnly = await connect(app, VIEWER, "conversations:read");
    const toolNames = async (token: string) =>
      (await withMcpClient(app, token, (client) => client.listTools())).tools
        .map((tool) => tool.name)
        .sort();
    const invalidScope = await app.request(
      authorizeUrl({
        client_id: MCP_CLIENT_ID,
        code_challenge: createPkce().challenge,
        redirect_uri: REDIRECT_URI,
        scope: "conversations:write",
      }),
    );
    const widenedRefresh = await requestTokens(app, {
      client_id: MCP_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: everyTokens.refresh_token,
      resource: MCP_TEST_URL,
      scope: "conversations:read",
    });

    for (const scope of ALL_SCOPES.split(" ")) {
      expect(everyScope.consentHtml).toContain(scope);
    }
    expect(everyTokens.scope).toBe(ALL_SCOPES);
    expect(await toolNames(everyTokens.access_token)).toEqual([
      "archiveConversation",
      "getAutomation",
      "getConversation",
      "getReviewItem",
      "listConversationMessages",
      "searchAutomations",
      "searchConversations",
      "searchReviewItems",
      "stopConversation",
    ]);
    expect(await toolNames(readOnly)).toEqual([
      "getConversation",
      "listConversationMessages",
      "searchConversations",
    ]);
    expect(
      new URL(invalidScope.headers.get("location") ?? "").searchParams.get(
        "error",
      ),
    ).toBe("invalid_scope");
    await expect(widenedRefresh.json()).resolves.toMatchObject({
      error: "invalid_scope",
    });
  });

  it("reads a participant's Conversation in pieces and hides other Conversations", async () => {
    const app = await createApp({ allowedDomains: ALLOWED_DOMAINS });
    const conversationId = "slack:C123:1700000000.000300";
    const otherConversationId = "slack:C123:1700000000.000400";
    await seedConversation({
      conversationId,
      email: VIEWER,
      title: "Viewer incident",
    });
    await seedConversation({
      conversationId: otherConversationId,
      email: OTHER_VIEWER,
      title: "Other incident",
    });
    await getConversationEventStore().append(
      conversationId,
      (
        [
          { role: "user", text: "What broke?" },
          { role: "assistant", text: "The relay deploy broke ingestion." },
          { role: "user", text: "Roll it back." },
          { role: "assistant", text: "The rollback is done." },
        ] as const
      ).map(({ role, text }, index) => ({
        data: {
          type: "message" as const,
          messageId: `message-${index}`,
          role,
          text,
        },
        createdAtMs: Date.now() + index,
      })),
    );
    await appendConversationBrief(getDb(), {
      content: conversationBriefFixture({ summary: "Relay was rolled back." }),
      conversationId,
      modelId: "test-model",
      searchText: "relay rollback",
      throughSeq: 0,
      turnId: "brief-turn",
    });
    const token = await connect(app, VIEWER);

    const conversation = await callTool(app, token, "getConversation", {
      conversationId,
    });
    const newest = await callTool(app, token, "listConversationMessages", {
      conversationId,
      limit: 3,
    });
    const older = await callTool(app, token, "listConversationMessages", {
      before: (newest.structuredContent as { nextCursor: string }).nextCursor,
      conversationId,
    });
    const hidden = await callTool(app, token, "getConversation", {
      conversationId: otherConversationId,
    });
    const stopped = await callTool(app, token, "stopConversation", {
      conversationId,
    });
    const archived = await callTool(app, token, "archiveConversation", {
      conversationId,
      lastSeenAt: (
        conversation.structuredContent as {
          conversation: { lastSeenAt: string };
        }
      ).conversation.lastSeenAt,
    });

    expect(conversation.structuredContent).toMatchObject({
      conversation: { conversationId, title: "Viewer incident" },
      brief: {
        summary: "Relay was rolled back.",
        updatedAt: expect.any(String),
      },
      lastReply: { role: "assistant", text: "The rollback is done." },
    });
    expect(conversation.structuredContent).not.toHaveProperty("brief.record");
    expect(
      (newest.structuredContent as { messages: { text: string }[] }).messages,
    ).toEqual([
      expect.objectContaining({ text: "The relay deploy broke ingestion." }),
      expect.objectContaining({ text: "Roll it back." }),
      expect.objectContaining({ text: "The rollback is done." }),
    ]);
    expect(older.structuredContent).toEqual({
      messages: [
        expect.objectContaining({ role: "user", text: "What broke?" }),
      ],
    });
    expect(hidden).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "Conversation not found." }],
    });
    expect(stopped.structuredContent).toEqual({
      status: "no_work",
      droppedMessages: 0,
    });
    expect(archived.structuredContent).toEqual({
      archivedAt: expect.any(String),
    });
  });

  it("lists the viewer's Review items and reads Automations", async () => {
    const app = await createApp({ allowedDomains: ALLOWED_DOMAINS });
    await seedConversation({
      conversationId: "slack:C123:1700000000.000500",
      email: VIEWER,
      title: "Release review",
    });
    const viewer = await resolveViewerUser(VIEWER);
    const other = await resolveViewerUser(OTHER_VIEWER);
    const addItem = async (userId: string, title: string) =>
      (await insertReviewItem(getDb(), {
        addedByConversationId: "slack:C123:1700000000.000500",
        assignedToEveryone: false,
        assigneeUserIds: [userId],
        body: "Pick one.",
        conversationIds: ["slack:C123:1700000000.000500"],
        dedupeKey: title,
        kind: "action",
        nowMs: Date.now(),
        request: {
          question: "Ship it?",
          fields: [
            {
              id: "decision",
              kind: "choice",
              label: "Decision",
              options: [{ label: "Ship" }, { label: "Wait" }],
            },
          ],
        },
        title,
        visibility: "private",
      }))!;
    const mine = await addItem(viewer!.id, "Approve the release");
    const theirs = await addItem(other!.id, "Approve the budget");
    const token = await connect(app, VIEWER);

    const listed = await callTool(app, token, "searchReviewItems");
    const hidden = await callTool(app, token, "getReviewItem", {
      id: theirs.id,
    });
    const automations = await callTool(app, token, "searchAutomations");
    const missingAutomation = await callTool(app, token, "getAutomation", {
      id: "missing",
    });

    expect(listed.structuredContent).toEqual({
      items: [
        expect.objectContaining({
          id: mine.id,
          canAct: true,
          question: "Ship it?",
          status: "open",
          title: "Approve the release",
        }),
      ],
      truncated: false,
    });
    expect(hidden).toMatchObject({ isError: true });
    expect(automations.structuredContent).toEqual({
      automations: [],
      total: 0,
    });
    expect(missingAutomation).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "Automation not found." }],
    });
  });

  it("does not mount when dashboard sign-in is not required", async () => {
    const app = await createApp({
      dashboard: { authRequired: false, baseURL: MCP_TEST_ORIGIN },
    });

    const response = await app.request(MCP_TEST_URL, { method: "POST" });
    const metadata = await app.request(
      `${MCP_TEST_ORIGIN}/.well-known/oauth-authorization-server`,
    );
    const consent = await app.request(
      `${MCP_TEST_ORIGIN}/_junior/mcp/authorize/${"a".repeat(43)}`,
    );

    expect(response.status).toBe(404);
    expect(metadata.status).toBe(404);
    expect(consent.status).toBe(404);
  });
});
