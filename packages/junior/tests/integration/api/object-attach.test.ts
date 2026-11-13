import { defineJuniorPlugin } from "@sentry/junior-plugin-api";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createJuniorApi } from "@/api";
import { createApp } from "@/app";
import type { JuniorApiEnv } from "@/api/route";
import { loadTurnConversationNotes } from "@/chat/conversations/notes";
import { getTurnLifecycle } from "@/chat/conversations/turn-lifecycle";
import { closeDb, getConversationStore, getDb } from "@/chat/db";
import { listConversationAnnotations } from "@/chat/plugins/annotations";
import { buildTurnContextPrompt } from "@/chat/prompt";
import { juniorConversationParticipants } from "@/db/schema";
import { defineJuniorPlugins } from "@/plugins";
import { signedInViewer } from "../../fixtures/user";

const CONVERSATION_ID = "slack:CPRIVATE:1712345.0001";
const DOC_URL = "https://docs.test/d/1";
const EVENT_URL = "https://docs.test/e/1";
const TITLE = 'Launch <plan> & "notes"';
const SECRET = "The launch slips to March.";
// Only these people can see the objects.
const READERS = new Set(["alice@example.com", "carol@example.com"]);

function object(objectType: "calendar_event" | "document", url: URL) {
  return {
    kind: "object" as const,
    objectType,
    key: url.pathname,
    label: TITLE,
    title: TITLE,
    url: url.href,
    description: SECRET,
  };
}

async function recordConversation(participants: string[]) {
  await getConversationStore().recordActivity({
    conversationId: CONVERSATION_ID,
    destination: { channelId: "CPRIVATE", platform: "slack", teamId: "T123" },
    nowMs: Date.parse("2026-01-02T03:04:05.000Z"),
    source: "slack",
    title: "Plan the private launch",
    visibility: "private",
  });
  for (const email of participants) {
    await getDb()
      .insert(juniorConversationParticipants)
      .values({
        lastMessageAt: new Date("2026-01-02T03:04:05.000Z"),
        rootConversationId: CONVERSATION_ID,
        userId: (await signedInViewer(email)).id,
      });
  }
}

function apiAs(viewer: Awaited<ReturnType<typeof signedInViewer>>) {
  const app = new Hono<JuniorApiEnv>();
  app.use("*", async (context, next) => {
    context.set("viewer", viewer);
    await next();
  });
  app.route("/", createJuniorApi());
  return app;
}

async function attachAs(
  email: string,
  url: string,
  conversationId = CONVERSATION_ID,
) {
  const response = await apiAs(await signedInViewer(email)).request(
    `http://localhost/api/conversations/${encodeURIComponent(conversationId)}/annotations`,
    {
      body: JSON.stringify({ url }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
  return { body: await response.text(), status: response.status };
}

async function nextTurnNotes(turnId: string, conversationId = CONVERSATION_ID) {
  await getTurnLifecycle().start({
    conversationId,
    createdAtMs: Date.now(),
    inputMessageIds: [`${turnId}-message`],
    surface: "internal",
    turnId,
  });
  return await loadTurnConversationNotes({
    conversationId,
    turnId,
  });
}

describe("attach a linked object", () => {
  beforeEach(async () => {
    await createApp({
      dashboard: { disabled: true },
      plugins: defineJuniorPlugins([
        defineJuniorPlugin({
          manifest: {
            name: "docs",
            displayName: "Docs",
            description: "Docs test plugin",
            configKeys: [],
          },
          objectLinks: [
            {
              filters: [{ host: "docs.test", pathPrefix: "/d/" }],
              objectType: "document",
              readTool: "readDocsFile",
              async resolve(ctx, url) {
                return READERS.has(ctx.viewer.email)
                  ? object("document", url)
                  : undefined;
              },
            },
            {
              filters: [{ host: "docs.test", pathPrefix: "/e/" }],
              objectType: "calendar_event",
              async resolve(ctx, url) {
                return READERS.has(ctx.viewer.email)
                  ? object("calendar_event", url)
                  : undefined;
              },
            },
          ],
        }),
      ]),
    });
    await recordConversation(["alice@example.com", "bob@example.com"]);
  });

  afterEach(async () => {
    await closeDb();
  });

  it("saves only the link, once, and tells the next Turn how to read it", async () => {
    expect(await attachAs("alice@example.com", DOC_URL)).toEqual({
      body: JSON.stringify({ status: "attached" }),
      status: 200,
    });
    // A second attach of the same link, with a trailing slash, adds nothing.
    expect(await attachAs("alice@example.com", `${DOC_URL}/`)).toEqual({
      body: JSON.stringify({ status: "unchanged" }),
      status: 200,
    });

    const annotations = await listConversationAnnotations(
      getDb(),
      CONVERSATION_ID,
    );
    expect(annotations).toEqual([
      expect.objectContaining({
        kind: "resource_link",
        key: "/d/1",
        label: DOC_URL,
        objectType: "document",
        plugin: "docs",
        url: DOC_URL,
      }),
    ]);
    // The card text and the title are never saved.
    expect(JSON.stringify(annotations)).not.toContain(SECRET);
    expect(JSON.stringify(annotations)).not.toContain("Launch <plan>");

    // Bob takes part, but cannot open the object, so he sees only the link.
    const bob = apiAs(await signedInViewer("bob@example.com"));
    const path = `http://localhost/api/conversations/${encodeURIComponent(CONVERSATION_ID)}`;
    for (const url of [path, `${path}/events?event=0&limit=50`]) {
      const response = await bob.request(url);
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain(DOC_URL);
      expect(body).not.toContain("Launch <plan>");
    }

    const notes = await nextTurnNotes("next-turn");
    expect(notes).toHaveLength(1);
    const context = buildTurnContextPrompt({
      availableSkills: [],
      conversationNotes: notes,
      includeSessionContext: false,
    });
    // The note names the type and the read tool. The agent reads the title.
    expect(context).toContain(
      `attached a Document (${DOC_URL}) to this Conversation. Read it live with \`readDocsFile\` when the work needs its content.`,
    );
    expect(context).not.toContain("Launch");
    expect(context).not.toContain(SECRET);
  });

  it("attaches an object that no tool reads without naming a tool", async () => {
    expect((await attachAs("alice@example.com", EVENT_URL)).status).toBe(200);
    const notes = await nextTurnNotes("next-turn");
    expect(notes).toEqual([
      expect.stringContaining(`(${EVENT_URL}) to this Conversation.`),
    ]);
    expect(notes[0]).not.toContain("Read it live");
    expect(notes[0]).not.toContain("Launch");
  });

  it("attaches nothing for a viewer who cannot see the object or write to the Conversation", async () => {
    // Bob is a participant, but cannot see the object.
    const denied = await attachAs("bob@example.com", DOC_URL);
    expect(denied.status).toBe(404);
    expect(denied.body).not.toContain("Launch");
    // Carol can see the object, but is not a participant.
    expect((await attachAs("carol@example.com", DOC_URL)).status).toBe(404);
    // No link type claims this URL.
    expect(
      (await attachAs("alice@example.com", "https://unknown.test/d/1")).status,
    ).toBe(404);

    expect(await listConversationAnnotations(getDb(), CONVERSATION_ID)).toEqual(
      [],
    );
    expect(await nextTurnNotes("next-turn")).toEqual([]);
  });

  it("attaches nothing to a Task, which takes no input from people", async () => {
    const taskId = "agent:object-attach-task";
    await getConversationStore().createChild({
      childConversationId: taskId,
      kind: "task",
      nowMs: Date.parse("2026-01-02T03:05:00.000Z"),
      parentConversationId: CONVERSATION_ID,
    });

    // Alice takes part in the root, so she takes part in the Task too.
    expect((await attachAs("alice@example.com", DOC_URL, taskId)).status).toBe(
      409,
    );
    expect(await listConversationAnnotations(getDb(), taskId)).toEqual([]);
    expect(await nextTurnNotes("task-turn", taskId)).toEqual([]);
  });
});
