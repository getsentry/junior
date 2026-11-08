import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { readConversationFeedFromSql } from "@/api/conversations/list";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { getStateAdapter } from "@/chat/state/adapter";
import { juniorConversations } from "@/db/schema";
import { createConfiguredJuniorSqlFixture } from "../../../fixtures/sql";

describe("conversation Location URL", () => {
  test("returns a link for a viewable Slack Location", async () => {
    const fixture = createConfiguredJuniorSqlFixture();
    const store = createSqlStore(fixture.sql);
    const conversationId = "slack:C123:location-url";
    const locationUrl =
      "https://example.slack.com/archives/C123/p1700000000000100?thread_ts=1700000000.000100&cid=C123";
    try {
      await migrateSchema(fixture.sql);
      await store.recordActivity({
        conversationId,
        destination: {
          platform: "slack",
          teamId: "T123",
          channelId: "C123",
        },
        nowMs: 1_000,
        sessionSource: {
          kind: "slack",
          visibility: "public",
          teamId: "T123",
          channelId: "C123",
          threadTs: "1700000000.000100",
        },
        source: "slack",
        visibility: "public",
      });
      await fixture.sql
        .db()
        .update(juniorConversations)
        .set({ sessionSource: null })
        .where(eq(juniorConversations.conversationId, conversationId));

      await expect(readConversationFeedFromSql()).resolves.toMatchObject({
        conversations: [
          expect.objectContaining({
            conversationId,
            locationUrl,
          }),
        ],
      });

      await fixture.sql
        .db()
        .update(juniorConversations)
        .set({
          location: {
            id: "slack:T123:C123",
            provider: "slack",
            teamId: "T123",
            channelId: "C123",
          },
          sessionSource: {
            kind: "slack",
            visibility: "public",
            teamId: "T123",
            channelId: "C123",
            threadTs: "1700000000.000100",
          },
        })
        .where(eq(juniorConversations.conversationId, conversationId));

      await expect(readConversationFeedFromSql()).resolves.toMatchObject({
        conversations: [
          expect.objectContaining({
            conversationId,
            locationUrl,
          }),
        ],
      });

      await store.recordActivity({
        conversationId: "slack:D123:1700000000.000200",
        destination: {
          platform: "slack",
          teamId: "T123",
          channelId: "D123",
        },
        nowMs: 2_000,
        sessionSource: {
          kind: "slack",
          visibility: "private",
          teamId: "T123",
          channelId: "D123",
          threadTs: "1700000000.000200",
        },
        source: "slack",
        visibility: "private",
      });
      const privateSummary = (
        await readConversationFeedFromSql()
      ).conversations.find(
        (conversation) =>
          conversation.conversationId === "slack:D123:1700000000.000200",
      );
      expect(privateSummary).toBeDefined();
      expect(privateSummary).not.toHaveProperty("locationUrl");
      expect(privateSummary).toMatchObject({
        channelName: "Direct Message",
        displayTitle: "Direct Message",
      });

      // Instances share found domains, so a new instance skips team.info.
      await expect(
        getStateAdapter().get("slack-team-domain:T123"),
      ).resolves.toBe("example");
      await getStateAdapter().set("slack-team-domain:T456", "shared", 60_000);
      await store.recordActivity({
        conversationId: "slack:C456:1700000000.000300",
        destination: {
          platform: "slack",
          teamId: "T456",
          channelId: "C456",
        },
        nowMs: 3_000,
        sessionSource: {
          kind: "slack",
          visibility: "public",
          teamId: "T456",
          channelId: "C456",
          threadTs: "1700000000.000300",
        },
        source: "slack",
        visibility: "public",
      });
      const sharedSummary = (
        await readConversationFeedFromSql()
      ).conversations.find(
        (conversation) =>
          conversation.conversationId === "slack:C456:1700000000.000300",
      );
      expect(sharedSummary?.locationUrl).toMatch(
        /^https:\/\/shared\.slack\.com\/archives\/C456\//,
      );
    } finally {
      await fixture.close();
    }
  });
});
