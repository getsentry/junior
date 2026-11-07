import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createJuniorApi } from "@/api";
import { readConversationFeed } from "@/api/conversations/list";
import type { JuniorApiEnv } from "@/api/route";
import {
  CONVERSATION_DETAIL_VERSION_HEADER,
  conversationReadPositionSchema,
} from "@/api/schema";
import {
  closeDb,
  getConversationEventStore,
  getConversationStore,
  getDb,
} from "@/chat/db";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import { juniorConversationParticipants, juniorIdentities } from "@/db/schema";

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

let nextMessage = 0;

/** Append one Message. A user Message comes from `authorIdentityId`. */
async function appendMessage(
  conversationId: string,
  message:
    | { authorIdentityId: string }
    | { quiet?: boolean; role: "assistant" },
) {
  const index = nextMessage++;
  await getConversationEventStore().append(conversationId, [
    {
      createdAtMs: 10_000 + index,
      data: {
        messageId: `message-${index}`,
        text: `Message ${index}`,
        type: "message",
        ...("authorIdentityId" in message
          ? { authorIdentityId: message.authorIdentityId, role: "user" }
          : {
              role: "assistant",
              ...(message.quiet ? { meta: { quiet: true } } : undefined),
            }),
      },
    },
  ]);
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

function putReadPosition(
  app: Hono<JuniorApiEnv>,
  conversationId: string,
  lastReadSeq: number,
) {
  return app.request(
    `http://localhost/api/conversations/${conversationId}/read-position`,
    {
      body: JSON.stringify({ lastReadSeq }),
      headers: { "content-type": "application/json" },
      method: "PUT",
    },
  );
}

async function feedSummary(
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
  return summary;
}

async function unread(
  viewer: Awaited<ReturnType<typeof authenticatedApi>>["viewer"],
  conversationId: string,
) {
  return (await feedSummary(viewer, conversationId)).unread ?? false;
}

describe("conversation unread API", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("keeps a visible reply unread until the viewer reads or acts on it", async () => {
    const conversationId = "local:test:unread";
    await recordActivity(conversationId, 1_000);
    const { app, viewer } = await authenticatedApi("reader@example.com");
    const other = await authenticatedApi("other-reader@example.com");
    const [identity] = await getDb()
      .insert(juniorIdentities)
      .values({
        id: "identity-unread-reader",
        createdAt: new Date(1_000),
        kind: "user",
        provider: "slack",
        providerSubjectId: "UREADER",
        updatedAt: new Date(1_000),
        userId: viewer.id,
      })
      .returning({ id: juniorIdentities.id });
    await getDb()
      .insert(juniorConversationParticipants)
      .values(
        [viewer, other.viewer].map((user) => ({
          lastMessageAt: new Date(1_000),
          rootConversationId: conversationId,
          userId: user.id,
        })),
      );
    await appendMessage(conversationId, { authorIdentityId: identity!.id }); // 0
    await appendMessage(conversationId, { role: "assistant" }); // 1

    // Without a read position nothing is unread, so a release does not
    // light up every old conversation.
    await expect(unread(viewer, conversationId)).resolves.toBe(false);
    await putReadPosition(app, conversationId, 1);
    await expect(unread(viewer, conversationId)).resolves.toBe(false);

    // A quiet reply folds into activity, so it is not new.
    await appendMessage(conversationId, { quiet: true, role: "assistant" }); // 2
    await expect(unread(viewer, conversationId)).resolves.toBe(false);

    await appendMessage(conversationId, { role: "assistant" }); // 3
    await expect(unread(viewer, conversationId)).resolves.toBe(true);
    // Opening the conversation does not move the read position.
    const detail = await app.request(
      `http://localhost/api/conversations/${conversationId}`,
    );
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      readPosition: { lastReadSeq: 1 },
      unread: true,
    });
    await expect(unread(viewer, conversationId)).resolves.toBe(true);
    await expect(unread(other.viewer, conversationId)).resolves.toBe(false);

    // Mark as read reads to the last event.
    const markRead = await setUnread(app, conversationId, false);
    expect(markRead.status).toBe(200);
    expect(conversationReadPositionSchema.parse(await markRead.json())).toEqual(
      { lastReadSeq: 3 },
    );
    await expect(unread(viewer, conversationId)).resolves.toBe(false);
    // The read position is not in the detail version, but its unread state
    // is, so a poll gets the read detail.
    const poll = await app.request(
      `http://localhost/api/conversations/${conversationId}`,
      {
        headers: {
          [CONVERSATION_DETAIL_VERSION_HEADER]: detail.headers.get(
            CONVERSATION_DETAIL_VERSION_HEADER,
          )!,
        },
      },
    );
    expect(poll.status).toBe(200);
    expect(await poll.json()).not.toHaveProperty("unread");

    // Mark as unread moves the position back to just before that reply.
    const markUnread = await setUnread(app, conversationId, true);
    expect(
      conversationReadPositionSchema.parse(await markUnread.json()),
    ).toEqual({ lastReadSeq: 2 });
    await expect(unread(viewer, conversationId)).resolves.toBe(true);
    await expect(unread(other.viewer, conversationId)).resolves.toBe(false);

    // Archive is an act on the conversation, so it reads it to the end.
    const archive = await app.request(
      `http://localhost/api/conversations/${conversationId}/archive`,
      {
        body: JSON.stringify({
          archived: true,
          lastSeenAt: (await feedSummary(viewer, conversationId)).lastSeenAt,
        }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      },
    );
    expect(archive.status).toBe(200);
    await expect(unread(viewer, conversationId)).resolves.toBe(false);

    // A new reply is unread again. The viewer's reply after it, also from
    // Slack, is an act on it.
    await appendMessage(conversationId, { role: "assistant" }); // 4
    await expect(unread(viewer, conversationId)).resolves.toBe(true);
    await appendMessage(conversationId, { authorIdentityId: identity!.id }); // 5
    await expect(unread(viewer, conversationId)).resolves.toBe(false);
  });

  it("rejects a viewer who is not a participant", async () => {
    const conversationId = "local:test:unread-stranger";
    await recordActivity(conversationId, 1_000);
    const { app } = await authenticatedApi("stranger@example.com");
    expect((await setUnread(app, conversationId, true)).status).toBe(404);
  });
});
