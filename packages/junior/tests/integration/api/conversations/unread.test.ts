import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createJuniorApi } from "@/api";
import { readConversationFeed } from "@/api/conversations/list";
import type { JuniorApiEnv } from "@/api/route";
import { markConversationUnreadResponseSchema } from "@/api/schema";
import {
  closeDb,
  getConversationEventStore,
  getConversationStore,
  getDb,
} from "@/chat/db";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import { juniorConversationParticipants } from "@/db/schema";

async function authenticatedApi(email: string) {
  const viewer = await resolveViewerUser(email);
  if (!viewer) throw new Error(`missing viewer for ${email}`);
  const app = new Hono<JuniorApiEnv>();
  app.use("*", async (context, next) => {
    context.set("viewer", viewer);
    await next();
  });
  app.route("/", createJuniorApi());
  return { app, viewer };
}

async function recordActivity(conversationId: string, nowMs: number) {
  await getConversationStore().recordActivity({
    conversationId,
    destination: { platform: "local", conversationId },
    nowMs,
    source: "internal",
    title: conversationId,
    visibility: "private",
  });
}

function setUnread(
  app: Hono<JuniorApiEnv>,
  conversationId: string,
  unread: boolean,
) {
  return app.request(
    `http://localhost/api/conversations/${conversationId}/unread`,
    {
      body: JSON.stringify({ unread }),
      headers: { "content-type": "application/json" },
      method: "PATCH",
    },
  );
}

async function unread(
  viewer: Awaited<ReturnType<typeof authenticatedApi>>["viewer"],
  conversationId: string,
) {
  const feeds = await Promise.all([
    readConversationFeed({ viewer }),
    readConversationFeed({ status: "archived", viewer }),
  ]);
  const summary = feeds
    .flatMap((feed) => feed.conversations)
    .find((conversation) => conversation.conversationId === conversationId);
  if (!summary) throw new Error(`missing ${conversationId} in feed`);
  return summary.unread ?? false;
}

describe("conversation unread API", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("keeps a finished conversation unread until the viewer acts on it", async () => {
    const conversationId = "local:test:unread";
    const startMs = Date.now() - 60_000;
    await recordActivity(conversationId, startMs);
    const { app, viewer } = await authenticatedApi("reader@example.com");
    const other = await authenticatedApi("other-reader@example.com");
    // Both viewers joined with the first message. Only `viewer` missed the
    // reply after it.
    await getDb()
      .insert(juniorConversationParticipants)
      .values([
        {
          lastMessageAt: new Date(startMs),
          readAt: new Date(startMs - 1_000),
          rootConversationId: conversationId,
          userId: viewer.id,
        },
        {
          lastMessageAt: new Date(startMs),
          rootConversationId: conversationId,
          userId: other.viewer.id,
        },
      ]);
    await expect(unread(viewer, conversationId)).resolves.toBe(true);
    await expect(unread(other.viewer, conversationId)).resolves.toBe(false);

    // Opening the conversation is not an act on it.
    const detail = await app.request(
      `http://localhost/api/conversations/${conversationId}`,
    );
    expect(detail.status).toBe(200);
    await expect(unread(viewer, conversationId)).resolves.toBe(true);

    const markRead = await setUnread(app, conversationId, false);
    expect(markRead.status).toBe(200);
    expect(
      markConversationUnreadResponseSchema.parse(await markRead.json()),
    ).toEqual({ readAt: expect.any(String) });
    await expect(unread(viewer, conversationId)).resolves.toBe(false);

    expect((await setUnread(app, conversationId, true)).status).toBe(200);
    await expect(unread(viewer, conversationId)).resolves.toBe(true);
    await expect(unread(other.viewer, conversationId)).resolves.toBe(false);

    // Archive is an act, so a restored conversation comes back read.
    const archive = await app.request(
      `http://localhost/api/conversations/${conversationId}/archive`,
      {
        body: JSON.stringify({
          archived: true,
          lastSeenAt: new Date(startMs).toISOString(),
        }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      },
    );
    expect(archive.status).toBe(200);
    await expect(unread(viewer, conversationId)).resolves.toBe(false);

    // Later activity on the idle conversation makes it unread again.
    const replyMs = Date.now() + 60_000;
    await recordActivity(conversationId, replyMs);
    await expect(unread(viewer, conversationId)).resolves.toBe(true);

    // The viewer's next message that starts a Turn marks it read.
    const messageMs = replyMs + 1_000;
    await getConversationEventStore().append(conversationId, [
      {
        createdAtMs: messageMs,
        data: {
          messageId: "reader-msg-1",
          meta: {
            author: {
              email: "reader@example.com",
              isBot: false,
              userId: viewer.id,
            },
          },
          role: "user",
          text: "thanks, one more thing",
          type: "message",
        },
        idempotencyKey: "message:reader-msg-1",
      },
      {
        createdAtMs: messageMs,
        data: {
          inputMessageIds: ["reader-msg-1"],
          surface: "api",
          turnId: "turn-reader-msg-1",
          type: "turn_started",
        },
        idempotencyKey: "turn:turn-reader-msg-1:started",
      },
    ]);
    await recordActivity(conversationId, messageMs);
    await expect(unread(viewer, conversationId)).resolves.toBe(false);
  });

  it("rejects a viewer who is not a participant", async () => {
    const conversationId = "local:test:unread-stranger";
    await recordActivity(conversationId, 1_000);
    const { app } = await authenticatedApi("stranger@example.com");
    expect((await setUnread(app, conversationId, true)).status).toBe(404);
  });
});
