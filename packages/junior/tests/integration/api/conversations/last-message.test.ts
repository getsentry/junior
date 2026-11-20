import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { readConversationFeed } from "@/api/conversations/list";
import {
  closeDb,
  getConversationEventStore,
  getConversationStore,
  getDb,
} from "@/chat/db";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import {
  juniorConversationParticipants,
  juniorConversations,
} from "@/db/schema";

async function resolveViewer(email: string) {
  const viewer = await resolveViewerUser(email);
  if (!viewer) throw new Error(`missing viewer for ${email}`);
  return viewer;
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

/** Append one Junior Message and return its time. */
async function appendMessage(
  conversationId: string,
  message: { progress?: boolean },
): Promise<string> {
  const index = nextMessage++;
  const createdAtMs = 10_000 + index;
  await getConversationEventStore().append(conversationId, [
    {
      createdAtMs,
      data: {
        messageId: `message-${index}`,
        text: `Message ${index}`,
        type: "message",
        role: "assistant",
        ...(message.progress ? { meta: { progress: true } } : undefined),
      },
    },
  ]);
  return new Date(createdAtMs).toISOString();
}

async function feedSummary(
  viewer: Awaited<ReturnType<typeof resolveViewer>>,
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

describe("conversation feed last Message", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("does not move the last Message for a progress ack", async () => {
    const conversationId = "local:test:last-message-progress";
    await recordActivity(conversationId, 1_000);
    const viewer = await resolveViewer("progress-reader@example.com");
    await getDb()
      .insert(juniorConversationParticipants)
      .values({
        lastMessageAt: new Date(1_000),
        rootConversationId: conversationId,
        userId: viewer.id,
      });
    const replyAt = await appendMessage(conversationId, {});

    // A progress ack only says that work continues.
    await appendMessage(conversationId, { progress: true });
    await expect(feedSummary(viewer, conversationId)).resolves.toMatchObject({
      lastMessageAt: replyAt,
    });
  });

  it("stores the last Message and reads events when a row has none", async () => {
    const conversationId = "local:test:last-message-unstored";
    await recordActivity(conversationId, 1_000);
    const viewer = await resolveViewer("unstored-reader@example.com");
    await getDb()
      .insert(juniorConversationParticipants)
      .values({
        lastMessageAt: new Date(1_000),
        rootConversationId: conversationId,
        userId: viewer.id,
      });
    const replyAt = await appendMessage(conversationId, {});
    // The append stores the time, so the feed reads no events for it.
    const [stored] = await getDb()
      .select({ lastMessageAt: juniorConversations.lastMessageAt })
      .from(juniorConversations)
      .where(eq(juniorConversations.conversationId, conversationId));
    expect(stored?.lastMessageAt?.toISOString()).toBe(replyAt);

    // Rows written before the stored time have none.
    await getDb()
      .update(juniorConversations)
      .set({ lastMessageAt: null })
      .where(eq(juniorConversations.conversationId, conversationId));

    await expect(feedSummary(viewer, conversationId)).resolves.toMatchObject({
      lastMessageAt: replyAt,
    });
  });
});
