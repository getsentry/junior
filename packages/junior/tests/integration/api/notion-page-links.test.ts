import { notionPlugin } from "@sentry/junior-notion";
import type { User } from "@sentry/junior-plugin-api";
import { Hono } from "hono";
import { http, HttpResponse } from "msw";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createJuniorApi } from "@/api";
import { createApp } from "@/app";
import type { JuniorApiEnv } from "@/api/route";
import { objectLinksReportSchema } from "@/api/schema";
import { closeDb } from "@/chat/db";
import {
  getMcpStoredOAuthCredentials,
  putMcpStoredOAuthCredentials,
} from "@/chat/mcp/auth-store";
import { PluginMcpClient } from "@/chat/mcp/client";
import { createMcpOAuthClientProvider } from "@/chat/mcp/oauth";
import { pluginCatalogRuntime } from "@/chat/plugins/catalog-runtime";
import { defineJuniorPlugins } from "@/plugins";
import { testViewer } from "../../fixtures/user";
import { mswServer } from "../../msw/server";

const MCP_ORIGIN = "https://mcp.notion.com";
const MCP_URL = `${MCP_ORIGIN}/mcp`;
const RESOURCE_METADATA_URL = `${MCP_ORIGIN}/.well-known/oauth-protected-resource/mcp`;
const COVER_URL = "https://images.example.com/launch-cover.png";
const COVER = await sharp({
  create: { width: 1200, height: 630, channels: 3, background: "#7553ff" },
})
  .png()
  .toBuffer();

const LAUNCH_ID = "2f1c0a9e8b7d4c3fa1b2c3d4e5f60718";
const RETRO_ID = "7a6b5c4d3e2f41a0b9c8d7e6f5a4b3c2";
const LAUNCH_URL = `https://www.notion.so/acme/Launch-plan-${LAUNCH_ID}`;
const RETRO_URL = `https://app.notion.com/p/${RETRO_ID}`;
const PUBLIC_URL =
  "https://acme.notion.site/Public-roadmap-0b1c2d3e4f5a46b7c8d9e0f1a2b3c4d5";

/** `notion-fetch` results, in the shape that Notion's MCP server returns. */
const PAGES: Record<string, Record<string, unknown>> = {
  [LAUNCH_ID]: {
    metadata: { type: "page" },
    title: "🚀 Launch plan",
    url: `https://app.notion.com/p/${LAUNCH_ID}`,
    text: [
      `<page url="https://app.notion.com/p/${LAUNCH_ID}">`,
      "<properties>",
      '{"title":"Launch plan"}',
      "</properties>",
      "<content>",
      "<p />",
      "## Goals",
      "",
      'Ship the **new onboarding** flow <span color="blue">to</span> [all teams](https://example.com) by June.',
      "</content>",
      "</page>",
    ].join("\n"),
    cover: { type: "external", external: { url: COVER_URL } },
    icon: { type: "emoji", emoji: "🚀" },
    page_last_edited_at: "2026-07-01T10:00:00.000Z",
  },
  [RETRO_ID]: {
    metadata: { type: "page" },
    title: "Retro notes",
    url: RETRO_URL,
    text: "<content>\nWhat went well this sprint.\n</content>",
    cover: null,
    icon: null,
    page_last_edited_at: "2026-06-20T08:30:00.000Z",
  },
};

/**
 * Fake Notion's hosted MCP server and its OAuth server. Each access token
 * reads only the pages of its person in `access`. Like Notion, a refresh
 * rotates the refresh token, and a retired refresh token revokes the grant.
 */
function fakeNotionMcp(access: Record<string, string[]>) {
  const calls: string[] = [];
  const refreshes: string[] = [];
  const tokens = new Map<string, string>();
  const refreshTokens = new Map<string, string>();
  const retired = new Set<string>();
  let expiredReads = 0;
  let releaseExpiredReads = () => {};
  const bothExpired = new Promise<void>((resolve) => {
    releaseExpiredReads = resolve;
  });
  let issued = 0;

  const unauthorized = () =>
    new HttpResponse(null, {
      status: 401,
      headers: {
        "WWW-Authenticate": `Bearer error="invalid_token", resource_metadata="${RESOURCE_METADATA_URL}"`,
      },
    });

  mswServer.use(
    http.get(RESOURCE_METADATA_URL, () =>
      HttpResponse.json({
        resource: MCP_URL,
        authorization_servers: [MCP_ORIGIN],
      }),
    ),
    http.get(`${MCP_ORIGIN}/.well-known/oauth-authorization-server`, () =>
      HttpResponse.json({
        issuer: MCP_ORIGIN,
        authorization_endpoint: `${MCP_ORIGIN}/authorize`,
        token_endpoint: `${MCP_ORIGIN}/token`,
        registration_endpoint: `${MCP_ORIGIN}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      }),
    ),
    http.post(`${MCP_ORIGIN}/token`, async ({ request }) => {
      const form = new URLSearchParams(await request.text());
      const sent = form.get("refresh_token") ?? "";
      refreshes.push(sent);
      const person = refreshTokens.get(sent);
      if (!person) {
        if (retired.has(sent)) {
          // A retired refresh token revokes every token of the grant.
          for (const [token, owner] of [...tokens, ...refreshTokens]) {
            if (sent.startsWith(owner)) {
              tokens.delete(token);
              refreshTokens.delete(token);
            }
          }
        }
        return HttpResponse.json({ error: "invalid_grant" }, { status: 400 });
      }
      refreshTokens.delete(sent);
      retired.add(sent);
      issued += 1;
      const accessToken = `${person}-access-${issued}`;
      const refreshToken = `${person}-refresh-${issued}`;
      tokens.set(accessToken, person);
      refreshTokens.set(refreshToken, person);
      return HttpResponse.json({
        access_token: accessToken,
        token_type: "bearer",
        expires_in: 3600,
        refresh_token: refreshToken,
      });
    }),
    http.get(MCP_URL, () => new HttpResponse(null, { status: 405 })),
    http.post(MCP_URL, async ({ request }) => {
      const token = (request.headers.get("authorization") ?? "").replace(
        /^Bearer /,
        "",
      );
      const person = tokens.get(token);
      if (!person) {
        if (token.includes("-expired")) {
          // Injected fault: two reads find the expired access token at the
          // same time, so both try to refresh it.
          expiredReads += 1;
          if (expiredReads === 2) releaseExpiredReads();
          await Promise.race([
            bothExpired,
            new Promise((resolve) => setTimeout(resolve, 2_000)),
          ]);
        }
        return unauthorized();
      }
      const message = (await request.json()) as {
        id?: number;
        method: string;
        params?: {
          arguments?: { id?: string };
          name?: string;
          protocolVersion?: string;
        };
      };
      const result = (value: unknown) =>
        HttpResponse.json({ jsonrpc: "2.0", id: message.id, result: value });
      switch (message.method) {
        case "initialize":
          return result({
            protocolVersion: message.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "notion-mcp", version: "1.0.0" },
          });
        case "tools/list":
          return result({
            tools: [
              {
                name: "notion-fetch",
                inputSchema: { type: "object" },
                annotations: { readOnlyHint: true },
              },
              {
                name: "notion-update-page",
                inputSchema: { type: "object" },
                annotations: { readOnlyHint: false },
              },
            ],
          });
        case "tools/call": {
          const id = message.params?.arguments?.id ?? "";
          calls.push(`${person} ${message.params?.name} ${id}`);
          const page = PAGES[id];
          if (!page || !access[person]?.includes(id)) {
            return result({
              isError: true,
              content: [
                {
                  type: "text",
                  text: `Could not find page with ID: ${id}. Check that you have access.`,
                },
              ],
            });
          }
          return result({
            content: [{ type: "text", text: JSON.stringify(page) }],
          });
        }
        default:
          return new HttpResponse(null, { status: 202 });
      }
    }),
    http.get(COVER_URL, () =>
      HttpResponse.arrayBuffer(new Uint8Array(COVER).buffer, {
        headers: { "content-type": "image/png" },
      }),
    ),
    // What Notion shows signed out: nothing for a private page, and Open
    // Graph tags for a published one.
    http.get(LAUNCH_URL, () => new HttpResponse(null, { status: 404 })),
    http.get(
      PUBLIC_URL,
      () =>
        new HttpResponse(
          '<!doctype html><html><head><meta property="og:title" content="Public roadmap"><meta property="og:site_name" content="Notion"></head></html>',
          { headers: { "content-type": "text/html" } },
        ),
    ),
  );

  /** Store a login for one person, as a finished Notion sign-in does. */
  async function connect(viewer: User, person: string, expired = false) {
    issued += 1;
    const accessToken = `${person}-${expired ? "expired" : "access"}-${issued}`;
    const refreshToken = `${person}-refresh-${issued}`;
    if (!expired) tokens.set(accessToken, person);
    refreshTokens.set(refreshToken, person);
    await putMcpStoredOAuthCredentials(viewer.id, "notion", {
      clientInformation: { client_id: "junior-notion-client" },
      tokens: {
        access_token: accessToken,
        token_type: "bearer",
        refresh_token: refreshToken,
      },
    });
  }

  return { calls, connect, refreshes };
}

function signedInApi(viewer: User) {
  const app = new Hono<JuniorApiEnv>();
  app.use("*", async (context, next) => {
    context.set("viewer", viewer);
    await next();
  });
  app.route("/", createJuniorApi());
  return app;
}

async function readCards(viewer: User, urls: string[]) {
  const query = new URLSearchParams(urls.map((url) => ["url", url]));
  const response = await signedInApi(viewer).request(
    `http://localhost/api/objects?${query}`,
  );
  expect(response.status).toBe(200);
  const body = await response.text();
  return {
    body,
    objects: objectLinksReportSchema.parse(JSON.parse(body)).objects,
  };
}

describe("Notion page link cards", () => {
  beforeEach(async () => {
    vi.stubEnv("JUNIOR_BASE_URL", "https://junior.example.com");
    await createApp({
      dashboard: { disabled: true },
      plugins: defineJuniorPlugins([notionPlugin()]),
    });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await closeDb();
  });

  it("shows a page card from one read to a viewer whose Notion login opens the page", async () => {
    const notion = fakeNotionMcp({ alice: [LAUNCH_ID] });
    const alice = testViewer("alice@example.com");
    await notion.connect(alice, "alice");

    const { objects } = await readCards(alice, [LAUNCH_URL]);

    const thumbnailUrl =
      objects[0]?.object.facts?.type === "document"
        ? objects[0].object.facts.thumbnailUrl
        : undefined;
    expect(thumbnailUrl).toMatch(/^\/api\/images\//);
    expect(objects).toEqual([
      {
        url: LAUNCH_URL,
        object: {
          kind: "object",
          objectType: "document",
          plugin: "notion",
          key: LAUNCH_ID,
          label: "🚀 Launch plan",
          title: "🚀 Launch plan",
          url: LAUNCH_URL,
          displayType: "Notion page",
          sourceUpdatedAt: "2026-07-01T10:00:00.000Z",
          facts: {
            type: "document",
            summary: "Ship the new onboarding flow to all teams by June.",
            modifiedAt: "2026-07-01T10:00:00.000Z",
            thumbnailUrl,
          },
        },
      },
    ]);
    // The access check and the card share one `notion-fetch` call, and a
    // link with a trailing slash reads the same page from the cache.
    const { objects: slashed } = await readCards(alice, [`${LAUNCH_URL}/`]);
    expect(slashed.map((card) => card.object.title)).toEqual([
      "🚀 Launch plan",
    ]);
    expect(notion.calls).toEqual([`alice notion-fetch ${LAUNCH_ID}`]);

    // The cover goes through the image proxy, which checks each viewer.
    const cover = await signedInApi(alice).request(
      `http://localhost${thumbnailUrl}`,
    );
    expect(cover.status).toBe(200);
    expect(cover.headers.get("content-type")).toBe("image/webp");
    const bob = testViewer("bob@example.com");
    await notion.connect(bob, "bob");
    expect(
      (await signedInApi(bob).request(`http://localhost${thumbnailUrl}`))
        .status,
    ).toBe(404);
  });

  it("shows nothing of a page to a viewer whose Notion login cannot open it", async () => {
    const notion = fakeNotionMcp({ alice: [LAUNCH_ID] });
    const bob = testViewer("bob@example.com");
    await notion.connect(bob, "bob");

    const { body, objects } = await readCards(bob, [LAUNCH_URL]);

    // Notion shows a private page to nobody signed out, so no card shows.
    expect(objects).toEqual([]);
    for (const text of ["Launch plan", "onboarding", "launch-cover"]) {
      expect(body).not.toContain(text);
    }
    expect(notion.calls).toEqual([`bob notion-fetch ${LAUNCH_ID}`]);
  });

  it("shows the public web page card to a viewer who has not connected Notion", async () => {
    const notion = fakeNotionMcp({ alice: [LAUNCH_ID] });
    // Alice is connected. Her login must not stand in for Carol.
    await notion.connect(testViewer("alice@example.com"), "alice");
    const carol = testViewer("carol@example.com");

    const { objects } = await readCards(carol, [LAUNCH_URL, PUBLIC_URL]);

    expect(objects).toEqual([
      {
        url: PUBLIC_URL,
        object: expect.objectContaining({
          objectType: "web_page",
          plugin: "junior",
          title: "Public roadmap",
        }),
      },
    ]);
    expect(notion.calls).toEqual([]);
  });

  it("refreshes an expired login once when a card and a Turn need it at the same time", async () => {
    const notion = fakeNotionMcp({ alice: [LAUNCH_ID, RETRO_ID] });
    const alice = testViewer("alice@example.com");
    await notion.connect(alice, "alice", true);
    const plugin = pluginCatalogRuntime.getDefinition("notion");
    if (!plugin) throw new Error("Expected the Notion plugin");
    const turnClient = new PluginMcpClient(plugin, {
      authProvider: await createMcpOAuthClientProvider({
        conversationId: "conversation-1",
        provider: "notion",
        sessionId: "turn-1",
        userId: alice.id,
        userMessage: "Summarize the retro notes",
      }),
    });

    const [cards, turnResult] = await Promise.all([
      readCards(alice, [LAUNCH_URL]),
      turnClient.callTool("notion-fetch", { id: RETRO_ID }),
    ]);
    await turnClient.close();

    expect(cards.objects.map((card) => card.object.title)).toEqual([
      "🚀 Launch plan",
    ]);
    expect(turnResult.isError).toBeFalsy();
    // One refresh went to Notion. The other caller waited and used its
    // tokens, so the retired refresh token never came back.
    expect(notion.refreshes).toEqual(["alice-refresh-1"]);
    expect(
      (await getMcpStoredOAuthCredentials(alice.id, "notion"))?.tokens,
    ).toMatchObject({
      access_token: "alice-access-2",
      refresh_token: "alice-refresh-2",
    });
    expect([...notion.calls].sort()).toEqual([
      `alice notion-fetch ${LAUNCH_ID}`,
      `alice notion-fetch ${RETRO_ID}`,
    ]);
  });
});
