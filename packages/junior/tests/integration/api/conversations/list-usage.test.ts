import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { readConversationFeedFromSql } from "@/api/conversations/list";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { juniorConversationEvents, juniorConversations } from "@/db/schema";
import { createConfiguredJuniorSqlFixture } from "../../../fixtures/sql";

describe("conversation list API usage rollup", () => {
  test("excludes children from the feed and rolls their usage into the root", async () => {
    const fixture = createConfiguredJuniorSqlFixture();
    const store = createSqlStore(fixture.sql);
    try {
      await migrateSchema(fixture.sql);
      await store.recordActivity({
        conversationId: "slack:C1:root",
        destination: {
          platform: "slack" as const,
          teamId: "T1",
          channelId: "C1",
        },
        nowMs: 1_000,
        source: "slack",
      });
      await fixture.sql
        .db()
        .update(juniorConversations)
        .set({ usage: { inputTokens: 10 } })
        .where(eq(juniorConversations.conversationId, "slack:C1:root"));
      const childAt = new Date(2_000);
      await fixture.sql
        .db()
        .insert(juniorConversations)
        .values({
          conversationId: "advisor:child",
          parentConversationId: "slack:C1:root",
          rootConversationId: "slack:C1:root",
          createdAt: childAt,
          lastActivityAt: childAt,
          updatedAt: childAt,
          executionStatus: "idle",
          usage: { outputTokens: 5 },
        });
      await fixture.sql
        .db()
        .insert(juniorConversationEvents)
        .values([
          {
            conversationId: "slack:C1:root",
            createdAt: new Date(3_000),
            historyVersion: 1,
            payload: {
              content: { costUsd: 0.0002, memories: [] },
              name: "memories_recalled",
              namespace: "memory",
              version: 1,
            },
            seq: 0,
            type: "structured_event",
          },
          {
            conversationId: "advisor:child",
            createdAt: new Date(4_000),
            historyVersion: 1,
            payload: { costUsd: 0.0003 },
            seq: 0,
            type: "guardian_action_reviewed",
          },
        ]);

      const feed = await readConversationFeedFromSql();

      expect(feed.conversations.map((item) => item.conversationId)).toEqual([
        "slack:C1:root",
      ]);
      expect(feed.conversations[0]?.cumulativeUsage).toEqual({
        inputTokens: 10,
        outputTokens: 5,
      });
      expect(feed.conversations[0]?.auxiliaryCosts).toEqual({
        costUsd: 0.0005,
        operations: [
          {
            costUsd: 0.0003,
            events: 1,
            name: "guardian_action_reviewed",
            namespace: "junior",
          },
          {
            costUsd: 0.0002,
            events: 1,
            name: "memories_recalled",
            namespace: "memory",
          },
        ],
      });
    } finally {
      await fixture.close();
    }
  });

  test("does not return partial tree metrics for an invalid root", async () => {
    const fixture = createConfiguredJuniorSqlFixture();
    const store = createSqlStore(fixture.sql);
    try {
      await migrateSchema(fixture.sql);
      await store.recordActivity({
        conversationId: "slack:C1:invalid-root",
        destination: {
          platform: "slack" as const,
          teamId: "T1",
          channelId: "C1",
        },
        nowMs: 1_000,
        source: "slack",
      });
      await fixture.sql
        .db()
        .update(juniorConversations)
        .set({
          durationMs: 100,
          rootConversationId: null,
          usage: { inputTokens: 10 },
        })
        .where(eq(juniorConversations.conversationId, "slack:C1:invalid-root"));
      const childAt = new Date(2_000);
      await fixture.sql
        .db()
        .insert(juniorConversations)
        .values({
          conversationId: "advisor:invalid-root-child",
          parentConversationId: "slack:C1:invalid-root",
          rootConversationId: "slack:C1:invalid-root",
          createdAt: childAt,
          lastActivityAt: childAt,
          updatedAt: childAt,
          executionStatus: "idle",
          durationMs: 500,
          usage: { outputTokens: 50 },
        });
      await fixture.sql
        .db()
        .insert(juniorConversationEvents)
        .values([
          {
            conversationId: "slack:C1:invalid-root",
            createdAt: new Date(3_000),
            historyVersion: 1,
            payload: {
              content: { costUsd: 0.0002, memories: [] },
              name: "memories_recalled",
              namespace: "memory",
              version: 1,
            },
            seq: 0,
            type: "structured_event",
          },
          {
            conversationId: "advisor:invalid-root-child",
            createdAt: new Date(4_000),
            historyVersion: 1,
            payload: { costUsd: 0.0003 },
            seq: 0,
            type: "guardian_action_reviewed",
          },
        ]);

      const feed = await readConversationFeedFromSql();

      expect(feed.conversations).toContainEqual(
        expect.objectContaining({
          conversationId: "slack:C1:invalid-root",
          cumulativeDurationMs: 100,
          cumulativeUsage: { inputTokens: 10 },
          auxiliaryCosts: {
            costUsd: 0.0002,
            operations: [
              {
                costUsd: 0.0002,
                events: 1,
                name: "memories_recalled",
                namespace: "memory",
              },
            ],
          },
        }),
      );
    } finally {
      await fixture.close();
    }
  });
});
