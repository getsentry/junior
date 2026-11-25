import { linearPlugin } from "../../../../junior-linear/src/index.js";
import type { User } from "@sentry/junior-plugin-api";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createJuniorApi } from "@/api";
import { createApp } from "@/app";
import type { JuniorApiEnv } from "@/api/route";
import { objectLinksReportSchema } from "@/api/schema";
import { closeDb, getDb, getSqlExecutor } from "@/chat/db";
import { putMcpStoredOAuthCredentials } from "@/chat/mcp/auth-store";
import { createPluginAnnotations } from "@/chat/plugins/annotations";
import { juniorConversationAnnotations } from "@/db/schema";
import { defineJuniorPlugins } from "@/plugins";
import {
  BASE_MS,
  seedConversation,
} from "../../fixtures/conversation-retention";
import { testViewer } from "../../fixtures/user";
import { mswServer } from "../../msw/server";

const MCP_URL = "https://mcp.linear.app/mcp";
const ISSUE_URL = "https://linear.app/acme/issue/ENG-123/fix-login-redirect";
const ISSUE_UUID = "8a87ba83-4e33-4c81-8751-a885a554e2fd";

const ENG_123 = {
  id: "ENG-123",
  uuid: ISSUE_UUID,
  title: "Fix login redirect",
  description: "Users land on a blank page after they sign in.",
  url: ISSUE_URL,
  status: "In Progress",
  assignee: "Sam",
  priority: { value: 2, name: "High" },
  project: "Quality",
  labels: ["Bug"],
  updatedAt: "2026-09-25T14:00:00.000Z",
};

/**
 * `get_issue` results by the id that the call names, in the shape that
 * Linear's hosted MCP returns. The issue moved from team WEB to ENG, so its
 * old identifier finds it too, under its new identifier.
 */
const ISSUES: Record<string, Record<string, unknown>> = {
  "ENG-123": ENG_123,
  "WEB-9": ENG_123,
};

/**
 * Fake Linear's hosted MCP server. Each access token reads only the issues
 * of its person in `access`.
 */
function fakeLinearMcp(access: Record<string, string[]>) {
  const calls: string[] = [];
  mswServer.use(
    http.get(MCP_URL, () => new HttpResponse(null, { status: 405 })),
    http.post(MCP_URL, async ({ request }) => {
      const person = (request.headers.get("authorization") ?? "").replace(
        /^Bearer (\w+)-access$/,
        "$1",
      );
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
            serverInfo: { name: "linear-mcp", version: "1.0.0" },
          });
        case "tools/list":
          return result({
            tools: [
              {
                name: "get_issue",
                inputSchema: { type: "object" },
                annotations: { readOnlyHint: true },
              },
              {
                name: "save_issue",
                inputSchema: { type: "object" },
                annotations: { readOnlyHint: false },
              },
            ],
          });
        case "tools/call": {
          const id = message.params?.arguments?.id ?? "";
          calls.push(`${person} ${message.params?.name} ${id}`);
          const issue = ISSUES[id];
          if (!issue || !access[person]?.includes(String(issue["id"]))) {
            return result({
              isError: true,
              content: [{ type: "text", text: `Entity not found: Issue` }],
            });
          }
          return result({
            content: [{ type: "text", text: JSON.stringify(issue) }],
          });
        }
        default:
          return new HttpResponse(null, { status: 202 });
      }
    }),
  );

  /** Store a login for one person, as a finished Linear sign-in does. */
  async function connect(viewer: User, person: string) {
    await putMcpStoredOAuthCredentials(viewer.id, "linear", {
      clientInformation: { client_id: "junior-linear-client" },
      tokens: { access_token: `${person}-access`, token_type: "bearer" },
    });
  }

  return { calls, connect };
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

/**
 * Save a Ticket card as an older release did: its subject is the
 * identifier, because that release did not know Linear's uuid.
 */
async function seedIdentifierTicket(
  identifier = "ENG-123",
  url = `https://linear.app/acme/issue/${identifier}`,
) {
  const conversationId = `conversation-${randomUUID()}`;
  await seedConversation(getSqlExecutor(), {
    conversationId,
    lastActivityAtMs: BASE_MS,
  });
  await createPluginAnnotations({
    conversationId,
    db: getDb(),
    plugin: "linear",
  }).upsert({
    kind: "object",
    objectType: "task",
    key: identifier,
    subject: { id: identifier, kind: "issue" },
    label: identifier,
    title: "Login redirect",
    url,
    displayType: "Issue",
  });
  return conversationId;
}

async function savedTicket(conversationId: string) {
  return await getDb()
    .select({
      annotation: juniorConversationAnnotations.annotation,
      subjectId: juniorConversationAnnotations.subjectId,
      subjectKind: juniorConversationAnnotations.subjectKind,
      updatedAt: juniorConversationAnnotations.updatedAt,
    })
    .from(juniorConversationAnnotations)
    .where(eq(juniorConversationAnnotations.conversationId, conversationId));
}

describe("Linear issue link cards", () => {
  beforeEach(async () => {
    vi.stubEnv("JUNIOR_BASE_URL", "https://junior.example.com");
    await createApp({
      dashboard: { disabled: true },
      plugins: defineJuniorPlugins([linearPlugin()]),
    });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await closeDb();
  });

  it("shows an issue card from one read to a viewer whose Linear login opens the issue, and rekeys older Tickets to its uuid", async () => {
    const linear = fakeLinearMcp({ alice: ["ENG-123"] });
    const alice = testViewer("alice@example.com");
    await linear.connect(alice, "alice");
    const conversationId = await seedIdentifierTicket();
    const [before] = await savedTicket(conversationId);
    // A Ticket with the same identifier in another Linear workspace.
    const otherConversationId = await seedIdentifierTicket(
      "ENG-123",
      "https://linear.app/other-team/issue/ENG-123/payroll-export",
    );
    const otherBefore = await savedTicket(otherConversationId);

    const { objects } = await readCards(alice, [ISSUE_URL]);

    expect(objects).toEqual([
      {
        url: ISSUE_URL,
        object: {
          kind: "object",
          objectType: "task",
          plugin: "linear",
          key: "ENG-123",
          // Linear's uuid stays when the issue moves to another team.
          subject: { id: ISSUE_UUID, kind: "issue" },
          label: "ENG-123",
          title: "Fix login redirect",
          description: "Users land on a blank page after they sign in.",
          url: ISSUE_URL,
          status: "In Progress",
          displayType: "Issue",
          sourceUpdatedAt: "2026-09-25T14:00:00.000Z",
          facts: {
            type: "task",
            assignees: ["Sam"],
            priority: "High",
            project: "Quality",
            labels: ["Bug"],
          },
        },
      },
    ]);
    // The access check and the card share one `get_issue` call, and a link
    // without the title slug reads the same issue from the cache.
    const { objects: bare } = await readCards(alice, [
      "https://linear.app/acme/issue/eng-123",
    ]);
    expect(bare.map((card) => card.object.key)).toEqual(["ENG-123"]);
    expect(linear.calls).toEqual(["alice get_issue ENG-123"]);
    // Alice's own read names the uuid, so the older Ticket now has it. The
    // read changes nothing else in the saved card.
    expect(await savedTicket(conversationId)).toEqual([
      { ...before, subjectId: ISSUE_UUID },
    ]);
    expect(await savedTicket(otherConversationId)).toEqual(otherBefore);
  });

  it("shows a moved issue from a link with its old identifier, and rekeys Tickets saved under that identifier", async () => {
    const linear = fakeLinearMcp({ alice: ["ENG-123"] });
    const alice = testViewer("alice@example.com");
    await linear.connect(alice, "alice");
    const conversationId = await seedIdentifierTicket("WEB-9");
    const [before] = await savedTicket(conversationId);

    const { objects } = await readCards(alice, [
      "https://linear.app/acme/issue/WEB-9/fix-login-redirect",
    ]);

    expect(objects.map((card) => card.object)).toMatchObject([
      { key: "ENG-123", subject: { id: ISSUE_UUID, kind: "issue" } },
    ]);
    expect(await savedTicket(conversationId)).toEqual([
      { ...before, subjectId: ISSUE_UUID },
    ]);
  });

  it("shows nothing of an issue to a viewer who cannot open it or has not connected Linear", async () => {
    const linear = fakeLinearMcp({ alice: ["ENG-123"] });
    // Alice is connected. Her login must not stand in for Carol.
    await linear.connect(testViewer("alice@example.com"), "alice");
    const bob = testViewer("bob@example.com");
    await linear.connect(bob, "bob");
    const carol = testViewer("carol@example.com");
    const conversationId = await seedIdentifierTicket();
    const before = await savedTicket(conversationId);

    for (const viewer of [bob, carol]) {
      const { body, objects } = await readCards(viewer, [ISSUE_URL]);
      expect(objects).toEqual([]);
      expect(body).not.toContain("login redirect");
    }
    expect(linear.calls).toEqual(["bob get_issue ENG-123"]);
    expect(await savedTicket(conversationId)).toEqual(before);
  });

  it("shows nothing when the viewer's workspace has another issue with the same identifier", async () => {
    const linear = fakeLinearMcp({ alice: ["ENG-123"] });
    const alice = testViewer("alice@example.com");
    await linear.connect(alice, "alice");

    const { objects } = await readCards(alice, [
      "https://linear.app/other-team/issue/ENG-123/fix-login-redirect",
    ]);

    expect(objects).toEqual([]);
  });
});
