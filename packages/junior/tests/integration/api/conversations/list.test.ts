import { describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { readConversationFeedFromSql } from "@/api/conversations/list";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { juniorIdentities } from "@/db/schema";
import { createConfiguredJuniorSqlFixture } from "../../../fixtures/sql";

describe("conversation list API", () => {
  test("filters by verified actor email before applying the feed limit", async () => {
    const fixture = createConfiguredJuniorSqlFixture();
    const store = createSqlStore(fixture.sql);
    try {
      await migrateSchema(fixture.sql);
      await store.recordActivity({
        actor: {
          email: "other@example.com",
          platform: "slack",
          slackUserId: "U2",
          teamId: "T1",
        },
        conversationId: "slack:C1:newest-overall",
        nowMs: 3_000,
        source: "slack",
      });
      await fixture.sql
        .db()
        .update(juniorIdentities)
        .set({ emailVerified: false })
        .where(eq(juniorIdentities.providerSubjectId, "U2"));
      await store.recordActivity({
        actor: {
          email: "Morgan@Example.com",
          platform: "slack",
          slackUserId: "U1",
          teamId: "T1",
        },
        conversationId: "slack:C1:morgan-newest",
        nowMs: 2_000,
        source: "slack",
      });
      await store.recordActivity({
        actor: {
          email: "morgan@example.com",
          platform: "slack",
          slackUserId: "U1",
          teamId: "T1",
        },
        conversationId: "slack:C1:morgan-older",
        nowMs: 1_000,
        source: "slack",
      });

      const feed = await readConversationFeedFromSql({
        actorEmail: "morgan@example.com",
        limit: 1,
      });

      expect(feed.conversations).toEqual([
        expect.objectContaining({
          actorIdentity: expect.objectContaining({
            email: "Morgan@Example.com",
          }),
          conversationId: "slack:C1:morgan-newest",
        }),
      ]);
      await expect(
        readConversationFeedFromSql({ actorEmail: "other@example.com" }),
      ).resolves.toMatchObject({ conversations: [] });
    } finally {
      await fixture.close();
    }
  });
});
