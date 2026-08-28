import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { defineJuniorPlugin } from "@sentry/junior-plugin-api";
import { testViewer } from "../../../fixtures/user";
import { eq } from "drizzle-orm";
import { createJuniorApi } from "@/api";
import { readConversationAccessFromSql } from "@/api/conversations/access";
import {
  readConversationFeedFromSql,
  readConversationRecordFromSql,
} from "@/api/conversations/list";
import { apiErrorSchema, conversationFeedSchema } from "@/api/schema";
import { createSqlConversationEventStore } from "@/chat/conversations/sql/history";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { setPlugins } from "@/chat/plugins/agent-hooks";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import {
  juniorConversationEvents,
  juniorConversationParticipants,
  juniorConversations,
  juniorDestinations,
  juniorIdentities,
  juniorUsers,
} from "@/db/schema";
import { createConfiguredJuniorSqlFixture } from "../../../fixtures/sql";

function dashboardAuthorIdFromEmail(email: string): string {
  return `dashboard:${createHash("sha256").update(email).digest("hex").slice(0, 24)}`;
}

describe("conversation list API", () => {
  test("serves the route and validates its filters", async () => {
    const fixture = createConfiguredJuniorSqlFixture();
    try {
      await migrateSchema(fixture.sql);
      const store = createSqlStore(fixture.sql);
      const archivedId = "slack:C123:archived";
      await store.recordActivity({ conversationId: archivedId, nowMs: 1_000, destination: { platform: "slack" as const, teamId: "T123", channelId: "C123" }});
      const viewer = await resolveViewerUser("viewer@example.com");
      expect(viewer).toBeDefined();
      await fixture.sql.db().insert(juniorConversationParticipants).values({
        archivedAt: new Date(2_000),
        lastMessageAt: new Date(1_000),
        rootConversationId: archivedId,
        userId: viewer!.id,
      });
      const app = createJuniorApi();

      const response = await app.request(
        "http://localhost/api/conversations?actorEmail=viewer%40example.com",
      );
      expect(response.status).toBe(200);
      expect(
        conversationFeedSchema.parse(await response.json()).conversations,
      ).toEqual([]);
      const archivedResponse = await app.request(
        "http://localhost/api/conversations?actorEmail=viewer%40example.com&status=archived",
      );
      expect(archivedResponse.status).toBe(200);
      expect(
        conversationFeedSchema.parse(await archivedResponse.json())
          .conversations,
      ).toEqual([
        expect.objectContaining({
          archivedAt: new Date(2_000).toISOString(),
          conversationId: archivedId,
        }),
      ]);

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

  test("marks conversations with assigned work and feed priority", async () => {
    const fixture = createConfiguredJuniorSqlFixture();
    const store = createSqlStore(fixture.sql);
    const unfinishedId = "slack:C123:unfinished-work";
    const finishedId = "slack:C123:finished-work";
    const finishedUpdatedId = "slack:C123:finished-updated";
    const seenConversationIds: string[][] = [];
    const nowMs = Date.now();
    try {
      await migrateSchema(fixture.sql);
      await store.recordActivity({
        conversationId: unfinishedId,
        destination: { platform: "slack" as const, teamId: "T123", channelId: "C123" },
        nowMs: nowMs - 60_000,
      });
      await store.recordActivity({
        conversationId: finishedUpdatedId,
        destination: { platform: "slack" as const, teamId: "T123", channelId: "C123" },
        nowMs: nowMs - 30_000,
      });
      await store.recordActivity({
        conversationId: finishedId,
        destination: { platform: "slack" as const, teamId: "T123", channelId: "C123" },
        nowMs: nowMs - 120_000,
      });
      await fixture.sql.db().insert(juniorConversationEvents).values([
        {
          conversationId: finishedUpdatedId,
          createdAt: new Date(nowMs - 30_000),
          historyVersion: 0,
          payload: {
            content: "Please follow up.",
            provenance: {
              authority: "instruction",
              actor: {
                platform: "slack",
                teamId: "T123",
                userId: "U123456",
              },
            },
            timestamp: nowMs - 30_000,
          },
          schemaVersion: 1,
          seq: 0,
          type: "user_message",
        },
        {
          conversationId: finishedId,
          createdAt: new Date(nowMs - 30_000),
          historyVersion: 0,
          payload: {
            content: "Pull request merged.",
            provenance: {
              authority: "instruction",
              actor: { name: "resource-event", platform: "system" },
            },
            timestamp: nowMs - 30_000,
          },
          schemaVersion: 1,
          seq: 0,
          type: "user_message",
        },
      ]);
      setPlugins([
        defineJuniorPlugin({
          manifest: {
            name: "work",
            displayName: "Work",
            description: "Unfinished work test plugin",
          },
          hooks: {
            unfinishedWork(ctx) {
              seenConversationIds.push([...ctx.conversationIds]);
              return {
                assignedConversationIds: [
                  unfinishedId,
                  finishedId,
                  finishedUpdatedId,
                ],
                conversationIds: [unfinishedId],
                finishedWorkAtByConversationId: {
                  [finishedId]: new Date(nowMs - 120_000).toISOString(),
                  [finishedUpdatedId]: new Date(nowMs - 90_000).toISOString(),
                },
              };
            },
          },
        }),
      ]);

      await expect(readConversationFeedFromSql()).resolves.toMatchObject({
        conversations: [
          expect.objectContaining({
            conversationId: finishedUpdatedId,
            assignedWork: true,
            finishedWorkAt: new Date(nowMs - 90_000).toISOString(),
            isPriority: true,
          }),
          expect.objectContaining({
            conversationId: unfinishedId,
            assignedWork: true,
            unfinishedWork: true,
            isPriority: true,
          }),
          expect.objectContaining({
            conversationId: finishedId,
            assignedWork: true,
            finishedWorkAt: new Date(nowMs - 120_000).toISOString(),
            isPriority: false,
          }),
        ],
      });
      expect(seenConversationIds).toEqual([
        [finishedUpdatedId, unfinishedId, finishedId],
      ]);
    } finally {
      setPlugins([]);
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
          visibility: "public",
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
            sourceUrl:
              "https://example.slack.com/archives/C123/p1700000000000100?thread_ts=1700000000.000100&cid=C123",
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
          platform: "slack",
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
      expect(privateSummary).not.toHaveProperty("sourceUrl");
      expect(privateSummary).toMatchObject({
        channelName: "Direct Message",
        displayTitle: "Direct Message",
      });
    } finally {
      await fixture.close();
    }
  });

  test.each(["direct", "unknown"] as const)(
    "treats persisted %s visibility as private",
    async (visibility) => {
      const fixture = createConfiguredJuniorSqlFixture();
      const store = createSqlStore(fixture.sql);
      const conversationId = `slack:C123:${visibility}-visibility`;
      const channelId = `C${visibility.toUpperCase()}`;
      try {
        await migrateSchema(fixture.sql);
        await store.recordActivity({
          conversationId,
          destination: {
            platform: "slack",
            teamId: "T123",
            channelId,
          },
          nowMs: 1_000,
          source: "slack",
          visibility: "private",
        });
        const db = fixture.sql.db();
        await db
          .update(juniorDestinations)
          .set({ visibility })
          .where(eq(juniorDestinations.providerDestinationId, channelId));
        const access = await readConversationAccessFromSql(db, [
          conversationId,
        ]);
        expect(access.get(conversationId)).toMatchObject({
          canViewPrivateContent: false,
          visibility,
        });
      } finally {
        await fixture.close();
      }
    },
  );

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
        destination: { platform: "slack" as const, teamId: "T1", channelId: "C1" },
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
        destination: { platform: "slack" as const, teamId: "T1", channelId: "C1" },
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
        destination: { platform: "slack" as const, teamId: "T1", channelId: "C1" },
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

  test("filters by linked user before applying the feed limit", async () => {
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
        destination: { platform: "slack" as const, teamId: "T1", channelId: "C1" },
        nowMs: 4_000,
        source: "slack",
      });
      const otherUser = await fixture.sql
        .db()
        .select({ id: juniorUsers.id })
        .from(juniorUsers)
        .where(eq(juniorUsers.primaryEmailNormalized, "other@example.com"))
        .limit(1);
      const otherUserId = otherUser[0]?.id;
      expect(otherUserId).toBeDefined();
      await fixture.sql
        .db()
        .update(juniorIdentities)
        .set({ emailVerified: false, userId: null })
        .where(eq(juniorIdentities.providerSubjectId, "U2"));
      // Unlinked identities also drop durable participant membership.
      await fixture.sql
        .db()
        .delete(juniorConversationParticipants)
        .where(eq(juniorConversationParticipants.userId, otherUserId!));
      await store.recordActivity({
        actor: {
          email: "Morgan@Example.com",
          platform: "slack",
          slackUserId: "U1",
          teamId: "T1",
        },
        conversationId: "slack:C1:morgan-newest",
        destination: { platform: "slack" as const, teamId: "T1", channelId: "C1" },
        nowMs: 3_000,
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
        destination: { platform: "slack" as const, teamId: "T1", channelId: "C1" },
        nowMs: 1_000,
        source: "slack",
      });
      await store.recordActivity({
        actor: {
          fullName: "Morgan Linked",
          platform: "slack",
          slackUserId: "U1B",
          slackUserName: "morgan-linked",
          teamId: "T1",
        },
        conversationId: "slack:D1:morgan-linked",
        destination: { platform: "slack" as const, teamId: "T1", channelId: "D1" },
        nowMs: 2_000,
        source: "slack",
        visibility: "private",
      });
      const linkedUser = await fixture.sql
        .db()
        .select({ id: juniorUsers.id })
        .from(juniorUsers)
        .where(eq(juniorUsers.primaryEmailNormalized, "morgan@example.com"))
        .limit(1);
      const linkedUserId = linkedUser[0]?.id;
      expect(linkedUserId).toBeDefined();
      await fixture.sql
        .db()
        .update(juniorIdentities)
        .set({
          email: null,
          emailNormalized: null,
          emailVerified: false,
          userId: linkedUserId!,
        })
        .where(eq(juniorIdentities.providerSubjectId, "U1B"));

      const viewer = {
        ...testViewer("morgan@example.com"),
        id: linkedUserId!,
      };
      const feed = await readConversationFeedFromSql({
        actorEmail: "other@example.com",
        viewer,
        limit: 2,
      });

      expect(feed.conversations).toEqual([
        expect.objectContaining({
          actorIdentity: expect.objectContaining({
            email: "Morgan@Example.com",
          }),
          conversationId: "slack:C1:morgan-newest",
          isParticipant: true,
        }),
        expect.objectContaining({
          actorIdentity: expect.objectContaining({
            fullName: "Morgan Linked",
            slackUserId: "U1B",
          }),
          conversationId: "slack:D1:morgan-linked",
          isParticipant: true,
        }),
      ]);
      await expect(
        readConversationFeedFromSql({ actorEmail: "other@example.com" }),
      ).resolves.toMatchObject({ conversations: [] });
      await expect(
        readConversationFeedFromSql({
          actorEmail: "morgan@example.com",
          limit: 2,
        }),
      ).resolves.toMatchObject({
        conversations: [
          expect.objectContaining({
            conversationId: "slack:C1:morgan-newest",
          }),
          expect.objectContaining({
            conversationId: "slack:D1:morgan-linked",
          }),
        ],
      });
    } finally {
      await fixture.close();
    }
  });

  test("includes conversations where the viewer authored a durable user message", async () => {
    const fixture = createConfiguredJuniorSqlFixture();
    const store = createSqlStore(fixture.sql);
    try {
      await migrateSchema(fixture.sql);
      await store.recordActivity({
        actor: {
          email: "owner@example.com",
          platform: "slack",
          slackUserId: "U-OWNER",
          teamId: "T1",
        },
        conversationId: "slack:C1:shared-thread",
        destination: { platform: "slack" as const, teamId: "T1", channelId: "C1" },
        nowMs: 5_000,
        source: "slack",
      });
      await store.recordActivity({
        actor: {
          email: "other@example.com",
          platform: "slack",
          slackUserId: "U-OTHER",
          teamId: "T1",
        },
        conversationId: "slack:C1:unrelated",
        destination: { platform: "slack" as const, teamId: "T1", channelId: "C1" },
        nowMs: 4_000,
        source: "slack",
      });

      const participant = await fixture.sql
        .db()
        .insert(juniorUsers)
        .values({
          id: "user-participant",
          createdAt: new Date(1_000),
          displayName: "Participant",
          primaryEmail: "participant@example.com",
          primaryEmailNormalized: "participant@example.com",
          updatedAt: new Date(1_000),
        })
        .returning({ id: juniorUsers.id });
      const participantUserId = participant[0]?.id;
      expect(participantUserId).toBeDefined();
      await fixture.sql.db().insert(juniorIdentities).values({
        id: "identity-participant-slack",
        createdAt: new Date(1_000),
        email: "participant@example.com",
        emailNormalized: "participant@example.com",
        emailVerified: true,
        kind: "user",
        provider: "slack",
        providerSubjectId: "U-PARTICIPANT",
        providerTenantId: "T1",
        updatedAt: new Date(1_000),
        userId: participantUserId!,
      });
      await fixture.sql.db().insert(juniorConversationEvents).values({
        actorIdentityId: "identity-participant-slack",
        conversationId: "slack:C1:shared-thread",
        createdAt: new Date(5_500),
        historyVersion: 0,
        payload: {
          messageId: "1786500342.616849",
          meta: {
            author: {
              fullName: "Participant",
              isBot: false,
              userId: "U-PARTICIPANT",
              userName: "participant",
            },
            explicitMention: true,
          },
          role: "user",
          text: "@junior make urls clickable",
        },
        seq: 0,
        type: "message",
      });
      await fixture.sql.db().insert(juniorConversationParticipants).values({
        lastMessageAt: new Date(5_500),
        rootConversationId: "slack:C1:shared-thread",
        userId: participantUserId!,
      });

      const viewer = {
        ...testViewer("participant@example.com"),
        id: participantUserId!,
      };
      const feed = await readConversationFeedFromSql({
        viewer,
        limit: 10,
      });

      expect(feed.conversations.map((item) => item.conversationId)).toEqual([
        "slack:C1:shared-thread",
      ]);
      expect(feed.conversations[0]).toMatchObject({
        actorIdentity: expect.objectContaining({
          slackUserId: "U-OWNER",
        }),
        conversationId: "slack:C1:shared-thread",
        isParticipant: true,
      });
    } finally {
      await fixture.close();
    }
  });

  test("resolves dashboard author ids against junior email identities", async () => {
    const fixture = createConfiguredJuniorSqlFixture();
    const store = createSqlStore(fixture.sql);
    const eventStore = createSqlConversationEventStore(fixture.sql);
    try {
      await migrateSchema(fixture.sql);
      await store.recordActivity({
        actor: {
          email: "owner@example.com",
          platform: "slack",
          slackUserId: "U-OWNER",
          teamId: "T1",
        },
        conversationId: "slack:C1:dashboard-author",
        destination: { platform: "slack" as const, teamId: "T1", channelId: "C1" },
        nowMs: 5_000,
        source: "slack",
      });

      const participant = await fixture.sql
        .db()
        .insert(juniorUsers)
        .values({
          id: "user-dashboard-participant",
          createdAt: new Date(1_000),
          displayName: "Dashboard Participant",
          primaryEmail: "dashboard-participant@example.com",
          primaryEmailNormalized: "dashboard-participant@example.com",
          updatedAt: new Date(1_000),
        })
        .returning({ id: juniorUsers.id });
      const participantUserId = participant[0]?.id;
      expect(participantUserId).toBeDefined();
      await fixture.sql.db().insert(juniorIdentities).values({
        id: "identity-dashboard-participant",
        createdAt: new Date(1_000),
        email: "dashboard-participant@example.com",
        emailNormalized: "dashboard-participant@example.com",
        emailVerified: true,
        kind: "user",
        provider: "junior",
        providerSubjectId: "dashboard-participant@example.com",
        providerTenantId: "",
        updatedAt: new Date(1_000),
        userId: participantUserId!,
      });

      await eventStore.append("slack:C1:dashboard-author", [
        {
          createdAtMs: 5_500,
          data: {
            messageId: "dashboard-msg-1",
            meta: {
              author: {
                isBot: false,
                userId: dashboardAuthorIdFromEmail(
                  "dashboard-participant@example.com",
                ),
              },
            },
            role: "user",
            text: "continue from dashboard",
            type: "message",
          },
          idempotencyKey: "message:dashboard-msg-1",
        },
      ]);

      const [event] = await fixture.sql
        .db()
        .select({
          actorIdentityId: juniorConversationEvents.actorIdentityId,
        })
        .from(juniorConversationEvents)
        .where(eq(juniorConversationEvents.conversationId, "slack:C1:dashboard-author"))
        .limit(1);
      expect(event?.actorIdentityId).toBe("identity-dashboard-participant");

      const participantRows = await fixture.sql
        .db()
        .select({
          userId: juniorConversationParticipants.userId,
        })
        .from(juniorConversationParticipants)
        .where(
          eq(
            juniorConversationParticipants.rootConversationId,
            "slack:C1:dashboard-author",
          ),
        );
      expect(participantRows.map((row) => row.userId)).toContain(
        participantUserId,
      );

      const feed = await readConversationFeedFromSql({
        viewer: {
          ...testViewer("dashboard-participant@example.com"),
          id: participantUserId!,
        },
        limit: 10,
      });
      expect(feed.conversations.map((item) => item.conversationId)).toEqual([
        "slack:C1:dashboard-author",
      ]);
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
        destination: { platform: "slack" as const, teamId: "T1", channelId: "C1" },
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
        destination: { platform: "slack" as const, teamId: "T1", channelId: "C1" },
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
