import {
  OBJECT_FACTS_MAX_BYTES,
  objectFactsBytes,
} from "@sentry/junior-plugin-api";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { conversationFeedSchema } from "@/api/schema";
import {
  CONVERSATION_FEED_THREAD_LIMIT,
  CONVERSATION_FEED_WAITING_LIMIT,
} from "@/api/schema/conversation-feed";
import { ACTIVITY_PREVIEW_MAX_LENGTH } from "@/api/schema/activity-preview-text";
import { getConversationEventStore, getDb } from "@/chat/db";
import { createPluginAnnotations } from "@/chat/plugins/annotations";
import { juniorConversations } from "@/db/schema";
import { closeConversationFixture } from "../../../fixtures/conversation";
import { storeConversationMetadataFixture } from "../../../fixtures/conversation-metadata";
import {
  ACTION_ITEM,
  addItem,
  createStatusFixture,
  lastSeq,
  recordSlackRoot,
} from "../../../fixtures/conversation-status";
import { expectResponseBudget } from "../../../fixtures/response-budget";
import { expectSqlBudget } from "../../../fixtures/sql-budget";

type StatusFixture = Awaited<ReturnType<typeof createStatusFixture>>;

// The longest message that the web composer accepts. An assistant message
// has no cap, and the feed row previews only its start.
const LATEST_MESSAGE_CHARS = 32_000;

function text(length: number, fill = "x"): string {
  return fill.repeat(length);
}

function url(length: number): string {
  const base = "https://github.com/getsentry/junior/pull/1?q=";
  return base + text(length - base.length);
}

/**
 * Give a root the most that a feed row can show: a full title, Threads, a
 * long latest message, a summary, an open Inbox item, and annotations at their max
 * lengths.
 */
async function makeHeavy(fixture: StatusFixture, conversationId: string) {
  await getDb()
    .update(juniorConversations)
    .set({ title: text(200, "t") })
    .where(eq(juniorConversations.conversationId, conversationId));
  for (let index = 0; index < 3; index += 1) {
    await fixture.conversationStore.createChild({
      childConversationId: `agent:${conversationId}:thread-${index}`,
      kind: "root",
      parentConversationId: conversationId,
      title: text(200, "h"),
    });
  }
  await getConversationEventStore().append(conversationId, [
    {
      data: {
        type: "message",
        messageId: `${conversationId}:long`,
        role: "assistant",
        text: text(LATEST_MESSAGE_CHARS, "m"),
      },
      createdAtMs: Date.now(),
    },
  ]);
  await storeConversationMetadataFixture(getDb(), {
    conversationId,
    summary: text(600, "s"),
    throughSeq: await lastSeq(conversationId),
  });
  await addItem(conversationId, ACTION_ITEM);
  const facts = {
    type: "code_change" as const,
    summary: text(280, "s"),
    author: text(160, "a"),
    sourceBranch: text(160, "b"),
    targetBranch: text(160, "b"),
    reviewers: Array.from({ length: 5 }, () => text(160, "r")),
    previewImageUrls: Array.from({ length: 4 }, () => url(512)),
  };
  // One more image URL fills the facts to their limit. It adds its quotes
  // and a comma.
  facts.previewImageUrls.push(
    url(OBJECT_FACTS_MAX_BYTES - objectFactsBytes(facts) - 3),
  );
  const annotations = createPluginAnnotations({
    conversationId,
    db: getDb(),
    plugin: "github",
  });
  await annotations.upsert({
    kind: "object",
    key: text(256, "k"),
    label: text(256, "l"),
    objectType: "code_change",
    title: text(512, "t"),
    url: url(2048),
    description: text(4000, "d"),
    status: text(100, "s"),
    trigger: text(4000, "r"),
    warning: text(1000, "w"),
    displayType: text(80, "p"),
    sourceUpdatedAt: new Date().toISOString(),
    facts,
  });
  await annotations.upsert({
    kind: "resource_link",
    key: text(256, "j"),
    label: text(256, "l"),
    url: url(2048),
    description: text(512, "d"),
    status: "open",
  });
}

describe("conversation list API response budget", () => {
  afterEach(async () => {
    await closeConversationFixture();
  });

  it("keeps each row of a heavy viewer's feed inside a size budget", async () => {
    const fixture = await createStatusFixture();
    // Waiting rows older than the page join the first page after it.
    const waitingIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const conversationId = await recordSlackRoot(
        fixture.conversationStore,
        `1700000000.1000${index}`,
      );
      await makeHeavy(fixture, conversationId);
      waitingIds.push(conversationId);
    }
    for (let index = 0; index < 50; index += 1) {
      await recordSlackRoot(
        fixture.conversationStore,
        `1700000000.2${String(index).padStart(4, "0")}`,
      );
    }
    const pinnedIds: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const conversationId = await recordSlackRoot(
        fixture.conversationStore,
        `1700000000.3000${index}`,
      );
      await makeHeavy(fixture, conversationId);
      const pin = await fixture.request(
        `/api/conversations/${encodeURIComponent(conversationId)}/pin`,
        {
          body: JSON.stringify({ pinned: true }),
          headers: { "content-type": "application/json" },
          method: "PATCH",
        },
      );
      expect(pin.status).toBe(200);
      pinnedIds.push(conversationId);
    }

    const response = await expectResponseBudget(
      () =>
        expectSqlBudget(
          () => fixture.request("/api/conversations?include=links,media"),
          { statements: 18, serialRounds: 3 },
        ),
      // Pins are not paged, so the body has no budget.
      {
        // A row's own fields, plus its activity preview, which holds the
        // start of the latest message.
        conversations: 1_959 + 469,
        // A row lists many of these. Each item has its own budget, and the
        // row leaves them out.
        "conversations.participants": 52,
        "conversations.sidebarAnnotations": 674,
        "conversations.threads": 637,
      },
    );
    expect(response.status).toBe(200);
    const feed = conversationFeedSchema.parse(await response.json());
    expect(feed.conversations.map((row) => row.conversationId)).toEqual(
      expect.arrayContaining([...pinnedIds, ...waitingIds]),
    );
    expect(feed.nextCursor).toBeDefined();
    expect(feed.conversations[0]?.activityPreview?.text).toHaveLength(
      ACTIVITY_PREVIEW_MAX_LENGTH,
    );
  });

  it("caps a row's Threads and the waiting rows from outside the page", async () => {
    const fixture = await createStatusFixture();
    const waitingIds: string[] = [];
    for (let index = 0; index <= CONVERSATION_FEED_WAITING_LIMIT; index += 1) {
      const conversationId = await recordSlackRoot(
        fixture.conversationStore,
        `1700000000.1${String(index).padStart(4, "0")}`,
      );
      await addItem(conversationId, ACTION_ITEM);
      waitingIds.push(conversationId);
    }
    for (let index = 0; index < 50; index += 1) {
      await recordSlackRoot(
        fixture.conversationStore,
        `1700000000.2${String(index).padStart(4, "0")}`,
      );
    }
    const rootId = await recordSlackRoot(
      fixture.conversationStore,
      "1700000000.30000",
    );
    // One nested Thread, so the cap keeps whole chains.
    for (let index = 0; index < CONVERSATION_FEED_THREAD_LIMIT; index += 1) {
      await fixture.conversationStore.createChild({
        childConversationId: `agent:${rootId}:thread-${index}`,
        kind: "root",
        parentConversationId: rootId,
      });
    }
    await fixture.conversationStore.createChild({
      childConversationId: `agent:${rootId}:nested`,
      kind: "root",
      parentConversationId: `agent:${rootId}:thread-0`,
    });

    const response = await fixture.request("/api/conversations");
    expect(response.status).toBe(200);
    const feed = conversationFeedSchema.parse(await response.json());
    const root = feed.conversations.find(
      (row) => row.conversationId === rootId,
    );
    const shown = (root?.threads ?? []).flatMap((thread) => [
      thread.conversationId,
      ...(thread.threads ?? []).map((nested) => nested.conversationId),
    ]);
    expect(shown).toHaveLength(CONVERSATION_FEED_THREAD_LIMIT);
    expect(root?.omittedThreadCount).toBe(1);
    // The newest waiting rows join the page. The oldest come on a later one.
    const ids = new Set(feed.conversations.map((row) => row.conversationId));
    expect(waitingIds.filter((id) => ids.has(id))).toEqual(waitingIds.slice(1));
    expect(feed.waitingRowsTruncated).toBe(true);
  });
});
