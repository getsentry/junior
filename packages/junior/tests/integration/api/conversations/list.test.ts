import { describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import {
  readConversationFeedFromSql,
  readConversationRecordFromSql,
} from "@/api/conversations/list";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import {
  juniorConversations,
  juniorIdentities,
  juniorUsers,
} from "@/db/schema";
import { createConfiguredJuniorSqlFixture } from "../../../fixtures/sql";

describe("conversation list API", () => {
  test("uses canonical and fallback actor names with provider identity fields", async () => {
    const fixture = createConfiguredJuniorSqlFixture();
    const store = createSqlStore(fixture.sql);
    try {
      await migrateSchema(fixture.sql);
      await store.recordActivity({
        actor: {
          email: "alice@example.com",
          fullName: "Alice Example",
          platform: "slack",
          slackUserId: "U1",
          slackUserName: "alice",
          teamId: "T1",
        },
        conversationId: "slack:C1:canonical-name",
        nowMs: 1_000,
        source: "slack",
      });
      await store.recordActivity({
        actor: {
          email: "ALICE@example.com",
          fullName: "Workspace Alice",
          platform: "slack",
          slackUserId: "U2",
          slackUserName: "workspace-alice",
          teamId: "T1",
        },
        conversationId: "slack:C1:provider-name",
        nowMs: 2_000,
        source: "slack",
      });
      await store.recordActivity({
        actor: {
          fullName: "Unlinked User",
          platform: "slack",
          slackUserId: "U3",
          slackUserName: "unlinked",
          teamId: "T1",
        },
        conversationId: "slack:C1:unlinked-name",
        nowMs: 3_000,
        source: "slack",
      });

      const feed = await readConversationFeedFromSql();

      expect(feed.conversations).toContainEqual(
        expect.objectContaining({
          actorIdentity: {
            email: "ALICE@example.com",
            fullName: "Alice Example",
            slackUserId: "U2",
            slackUserName: "workspace-alice",
          },
          conversationId: "slack:C1:provider-name",
        }),
      );
      expect(feed.conversations).toContainEqual(
        expect.objectContaining({
          actorIdentity: {
            fullName: "Unlinked User",
            slackUserId: "U3",
            slackUserName: "unlinked",
          },
          conversationId: "slack:C1:unlinked-name",
        }),
      );
      await expect(
        readConversationRecordFromSql("slack:C1:provider-name"),
      ).resolves.toMatchObject({
        conversation: {
          actor: {
            fullName: "Alice Example",
            slackUserId: "U2",
            slackUserName: "workspace-alice",
          },
        },
      });
      await fixture.sql
        .db()
        .update(juniorUsers)
        .set({ displayName: "" })
        .where(eq(juniorUsers.primaryEmailNormalized, "alice@example.com"));
      await expect(readConversationFeedFromSql()).resolves.toMatchObject({
        conversations: expect.arrayContaining([
          expect.objectContaining({
            actorIdentity: expect.objectContaining({
              fullName: "Workspace Alice",
              slackUserId: "U2",
              slackUserName: "workspace-alice",
            }),
            conversationId: "slack:C1:provider-name",
          }),
        ]),
      });
    } finally {
      await fixture.close();
    }
  });

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

  test("excludes child conversations from the top-level feed", async () => {
    const fixture = createConfiguredJuniorSqlFixture();
    const store = createSqlStore(fixture.sql);
    try {
      await migrateSchema(fixture.sql);
      await store.recordActivity({
        conversationId: "slack:C1:root",
        nowMs: 1_000,
        source: "slack",
      });
      const childAt = new Date(2_000);
      await fixture.sql.db().insert(juniorConversations).values({
        conversationId: "advisor:child",
        parentConversationId: "slack:C1:root",
        createdAt: childAt,
        lastActivityAt: childAt,
        updatedAt: childAt,
        executionStatus: "idle",
      });

      const feed = await readConversationFeedFromSql();

      expect(feed.conversations.map((item) => item.conversationId)).toEqual([
        "slack:C1:root",
      ]);
    } finally {
      await fixture.close();
    }
  });
});
