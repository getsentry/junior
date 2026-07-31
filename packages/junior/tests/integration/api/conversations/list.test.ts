import { describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { createJuniorApi } from "@/api";
import {
  readConversationFeedFromSql,
  readConversationRecordFromSql,
} from "@/api/conversations/list";
import { apiErrorSchema, conversationFeedSchema } from "@/api/schema";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import {
  juniorConversations,
  juniorIdentities,
  juniorUsers,
} from "@/db/schema";
import { createConfiguredJuniorSqlFixture } from "../../../fixtures/sql";

describe("conversation list API", () => {
  test("serves the route and validates its filters", async () => {
    const fixture = createConfiguredJuniorSqlFixture();
    try {
      await migrateSchema(fixture.sql);
      const app = createJuniorApi();

      const response = await app.request("http://localhost/api/conversations");
      expect(response.status).toBe(200);
      conversationFeedSchema.parse(await response.json());

      const invalid = await app.request(
        "http://localhost/api/conversations?actorEmail=not-an-email",
      );
      expect(invalid.status).toBe(400);
      expect(apiErrorSchema.parse(await invalid.json())).toEqual({
        error: "Invalid query parameters.",
      });
    } finally {
      await fixture.close();
    }
  });

  test("returns a Slack source link for a viewable conversation", async () => {
    const fixture = createConfiguredJuniorSqlFixture();
    const store = createSqlStore(fixture.sql);
    try {
      await migrateSchema(fixture.sql);
      await store.recordActivity({
        conversationId: "slack:C123:source-link",
        destination: {
          platform: "slack",
          teamId: "T123",
          channelId: "C123",
        },
        nowMs: 1_000,
        sessionSource: {
          platform: "slack",
          type: "pub",
          teamId: "T123",
          channelId: "C123",
          threadTs: "1700000000.000100",
        },
        source: "slack",
        visibility: "public",
      });

      await expect(readConversationFeedFromSql()).resolves.toMatchObject({
        conversations: [
          expect.objectContaining({
            conversationId: "slack:C123:source-link",
            sourceUrl: "https://slack.com/app_redirect?channel=C123&team=T123",
          }),
        ],
      });

      await store.recordActivity({
        conversationId: "slack:D123:private-source-link",
        destination: {
          platform: "slack",
          teamId: "T123",
          channelId: "D123",
        },
        nowMs: 2_000,
        sessionSource: {
          platform: "slack",
          type: "priv",
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
          conversation.conversationId === "slack:D123:private-source-link",
      );
      expect(privateSummary).toBeDefined();
      expect(privateSummary).not.toHaveProperty("sourceUrl");
    } finally {
      await fixture.close();
    }
  });

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
      await fixture.sql
        .db()
        .update(juniorConversations)
        .set({ rootConversationId: null, usage: { totalTokens: 9 } })
        .where(
          eq(juniorConversations.conversationId, "slack:C1:provider-name"),
        );

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
          cumulativeUsage: { totalTokens: 9 },
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
        verifiedViewerEmail: "MORGAN@example.com",
        limit: 1,
      });

      expect(feed.conversations).toEqual([
        expect.objectContaining({
          actorIdentity: expect.objectContaining({
            email: "Morgan@Example.com",
          }),
          conversationId: "slack:C1:morgan-newest",
          isParticipant: true,
        }),
      ]);
      await expect(
        readConversationFeedFromSql({ actorEmail: "other@example.com" }),
      ).resolves.toMatchObject({ conversations: [] });
    } finally {
      await fixture.close();
    }
  });

  test("excludes children from the feed and rolls their usage into the root", async () => {
    const fixture = createConfiguredJuniorSqlFixture();
    const store = createSqlStore(fixture.sql);
    try {
      await migrateSchema(fixture.sql);
      await store.recordActivity({
        conversationId: "slack:C1:root",
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

      const feed = await readConversationFeedFromSql();

      expect(feed.conversations.map((item) => item.conversationId)).toEqual([
        "slack:C1:root",
      ]);
      expect(feed.conversations[0]?.cumulativeUsage).toEqual({
        inputTokens: 10,
        outputTokens: 5,
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

      const feed = await readConversationFeedFromSql();

      expect(feed.conversations).toContainEqual(
        expect.objectContaining({
          conversationId: "slack:C1:invalid-root",
          cumulativeDurationMs: 100,
          cumulativeUsage: { inputTokens: 10 },
        }),
      );
    } finally {
      await fixture.close();
    }
  });
});
