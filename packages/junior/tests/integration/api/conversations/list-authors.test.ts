import { describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { testViewer } from "../../../fixtures/user";
import { readConversationFeedFromSql } from "@/api/conversations/list";
import { legacyWebActorUserId } from "@/chat/conversations/legacy-web-actor-id";
import { setArchivedAt } from "@/chat/conversations/sql/conversation-tree";
import { createSqlConversationEventStore } from "@/chat/conversations/sql/history";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import {
  juniorConversationEvents,
  juniorConversationParticipants,
  juniorIdentities,
  juniorUsers,
} from "@/db/schema";
import { createConfiguredJuniorSqlFixture } from "../../../fixtures/sql";

describe("conversation list authors", () => {
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
        destination: {
          platform: "slack" as const,
          teamId: "T1",
          channelId: "C1",
        },
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
      await fixture.sql
        .db()
        .insert(juniorIdentities)
        .values({
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
                // Web authors stored this id before they used the User id.
                userId: legacyWebActorUserId(
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
        .where(
          eq(
            juniorConversationEvents.conversationId,
            "slack:C1:dashboard-author",
          ),
        )
        .limit(1);
      expect(event?.actorIdentityId).toBe("identity-dashboard-participant");

      const readParticipantUserIds = async () =>
        (
          await fixture.sql
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
            )
        ).map((row) => row.userId);
      // A message that does not start a Turn is context, not membership.
      expect(await readParticipantUserIds()).not.toContain(participantUserId);

      await eventStore.append("slack:C1:dashboard-author", [
        {
          createdAtMs: 5_600,
          data: {
            inputMessageIds: ["dashboard-msg-1"],
            surface: "api",
            turnId: "turn-dashboard-msg-1",
            type: "turn_started",
          },
          idempotencyKey: "turn:turn-dashboard-msg-1:started",
        },
      ]);
      // A web Message adds nobody, even when it starts a Turn: a person
      // joins on the web explicitly.
      expect(await readParticipantUserIds()).not.toContain(participantUserId);

      const feed = await readConversationFeedFromSql({
        viewer: {
          ...testViewer("dashboard-participant@example.com"),
          id: participantUserId!,
        },
        limit: 10,
      });
      expect(feed.conversations).toEqual([]);

      // A web Message that restores an archived root is an explicit act,
      // like Unarchive, so it adds and subscribes its author.
      await setArchivedAt(
        fixture.sql.db(),
        ["slack:C1:dashboard-author"],
        new Date(5_700),
      );
      await eventStore.append("slack:C1:dashboard-author", [
        {
          createdAtMs: 5_800,
          data: {
            messageId: "dashboard-msg-2",
            meta: {
              author: {
                isBot: false,
                userId: legacyWebActorUserId(
                  "dashboard-participant@example.com",
                ),
              },
            },
            role: "user",
            text: "bring this back",
            type: "message",
          },
          idempotencyKey: "message:dashboard-msg-2",
        },
        {
          createdAtMs: 5_900,
          data: {
            inputMessageIds: ["dashboard-msg-2"],
            surface: "api",
            turnId: "turn-dashboard-msg-2",
            type: "turn_started",
          },
          idempotencyKey: "turn:turn-dashboard-msg-2:started",
        },
      ]);
      expect(await readParticipantUserIds()).toContain(participantUserId);
      const restored = await readConversationFeedFromSql({
        viewer: {
          ...testViewer("dashboard-participant@example.com"),
          id: participantUserId!,
        },
        limit: 10,
      });
      expect(restored.conversations.map((item) => item.conversationId)).toEqual(
        ["slack:C1:dashboard-author"],
      );
    } finally {
      await fixture.close();
    }
  });
});
