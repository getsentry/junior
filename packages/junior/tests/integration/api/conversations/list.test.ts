import { avatarPath } from "../../../fixtures/avatar";
import { describe, expect, test } from "vitest";
import { defineJuniorPlugin } from "@sentry/junior-plugin-api";
import { testViewer } from "../../../fixtures/user";
import { eq } from "drizzle-orm";
import { createJuniorApi } from "@/api";
import { readConversationAccessFromSql } from "@/api/conversations/access";
import { readConversationFeedFromSql } from "@/api/conversations/list";
import { readConversationRecordFromSql } from "@/api/conversations/record";
import { apiErrorSchema, conversationFeedSchema } from "@/api/schema";
import { recordCodeChange } from "@/chat/code/store";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { SYSTEM_IDENTITY_ID } from "@/chat/identities/actor";
import { upsertLinkedIdentity } from "@/chat/identities/sql";
import { setPlugins } from "@/chat/plugins/hooks/registry";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import {
  juniorConversationEvents,
  juniorConversationParticipants,
  juniorConversations,
  juniorIdentities,
  juniorUsers,
} from "@/db/schema";
import { storeConversationMetadataFixture } from "../../../fixtures/conversation-metadata";
import { createConfiguredJuniorSqlFixture } from "../../../fixtures/sql";

describe("conversation list API", () => {
  test("serves the route and validates its filters", async () => {
    const fixture = createConfiguredJuniorSqlFixture();
    try {
      await migrateSchema(fixture.sql);
      const store = createSqlStore(fixture.sql);
      const archivedId = "slack:C123:archived";
      const privateId = "slack:D123:private";
      await store.recordActivity({
        conversationId: archivedId,
        nowMs: 1_000,
        title: "Archived conversation",
        destination: {
          platform: "slack" as const,
          teamId: "T123",
          channelId: "C123",
        },
        visibility: "public",
      });
      await store.recordActivity({
        conversationId: privateId,
        nowMs: Date.now(),
        title: "Private roadmap conversation",
        destination: {
          platform: "slack" as const,
          teamId: "T123",
          channelId: "D123",
        },
        visibility: "private",
      });
      await storeConversationMetadataFixture(fixture.sql.db(), {
        conversationId: archivedId,
        summary: "The durable sapphire choice is current.",
      });
      await storeConversationMetadataFixture(fixture.sql.db(), {
        conversationId: privateId,
        summary: "The hidden marigold launch stays private.",
      });
      await fixture.sql
        .db()
        .update(juniorConversations)
        .set({ stoppedAt: new Date() })
        .where(eq(juniorConversations.conversationId, privateId));
      const viewer = await resolveViewerUser("viewer@example.com");
      expect(viewer).toBeDefined();
      await fixture.sql
        .db()
        .insert(juniorConversationParticipants)
        .values({
          lastMessageAt: new Date(1_000),
          rootConversationId: archivedId,
          userId: viewer!.id,
        });
      await fixture.sql
        .db()
        .update(juniorConversations)
        .set({ archivedAt: new Date(2_000) })
        .where(eq(juniorConversations.conversationId, archivedId));
      const app = createJuniorApi();

      const response = await app.request(
        "http://localhost/api/conversations?actorEmail=viewer%40example.com",
      );
      expect(response.status).toBe(200);
      expect(
        conversationFeedSchema.parse(await response.json()).conversations,
      ).toEqual([]);
      const searchResponse = await app.request(
        "http://localhost/api/conversations?actorEmail=viewer%40example.com&q=archived",
      );
      expect(searchResponse.status).toBe(200);
      expect(
        conversationFeedSchema.parse(await searchResponse.json()).conversations,
      ).toEqual([expect.objectContaining({ conversationId: archivedId })]);
      const summarySearchResponse = await app.request(
        "http://localhost/api/conversations?actorEmail=viewer%40example.com&q=durable%20sapphire",
      );
      expect(summarySearchResponse.status).toBe(200);
      expect(
        conversationFeedSchema.parse(await summarySearchResponse.json())
          .conversations,
      ).toEqual([expect.objectContaining({ conversationId: archivedId })]);
      const privateSummarySearchResponse = await app.request(
        "http://localhost/api/conversations?q=hidden%20marigold",
      );
      expect(privateSummarySearchResponse.status).toBe(200);
      expect(
        conversationFeedSchema.parse(await privateSummarySearchResponse.json())
          .conversations,
      ).toEqual([]);
      const privateTitleSearchResponse = await app.request(
        "http://localhost/api/conversations?q=private%20roadmap",
      );
      expect(privateTitleSearchResponse.status).toBe(200);
      expect(
        conversationFeedSchema.parse(await privateTitleSearchResponse.json())
          .conversations,
      ).toEqual([
        expect.objectContaining({
          conversationId: privateId,
          status: "done",
        }),
      ]);
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
      const invalidCursor = await app.request(
        "http://localhost/api/conversations?cursor=not-a-cursor",
      );
      expect(invalidCursor.status).toBe(400);
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
        destination: {
          platform: "slack" as const,
          teamId: "T123",
          channelId: "C123",
        },
        nowMs: nowMs - 60_000,
      });
      await store.recordActivity({
        conversationId: finishedUpdatedId,
        destination: {
          platform: "slack" as const,
          teamId: "T123",
          channelId: "C123",
        },
        nowMs: nowMs - 30_000,
      });
      await store.recordActivity({
        conversationId: finishedId,
        destination: {
          platform: "slack" as const,
          teamId: "T123",
          channelId: "C123",
        },
        nowMs: nowMs - 120_000,
      });
      await fixture.sql
        .db()
        .insert(juniorConversationEvents)
        .values([
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
                actor: { name: "event", platform: "system" },
              },
              timestamp: nowMs - 30_000,
            },
            schemaVersion: 1,
            seq: 0,
            type: "user_message",
          },
          // An event Message has the system Identity as its author.
          {
            actorIdentityId: SYSTEM_IDENTITY_ID,
            conversationId: finishedId,
            createdAt: new Date(nowMs - 30_000),
            historyVersion: 0,
            payload: {
              messageId: "event-message",
              role: "user",
              text: "Pull request merged.",
            },
            schemaVersion: 1,
            seq: 1,
            type: "message",
          },
        ]);
      const change = (
        number: number,
        conversationId: string,
        finish?: { at: Date; state: "closed" | "merged" },
      ) =>
        recordCodeChange(fixture.sql.db(), "work", {
          closedAt: finish?.state === "closed" ? finish.at : undefined,
          conversationIds: [conversationId],
          mergedAt: finish?.state === "merged" ? finish.at : undefined,
          number,
          openedAt: new Date(nowMs - 300_000),
          providerId: `change-${number}`,
          repository: { name: "getsentry/junior", providerId: "repository-1" },
          state: finish?.state ?? "open",
          updatedAt: finish?.at ?? new Date(nowMs - 300_000),
        });
      await change(1, unfinishedId);
      await change(2, finishedId, {
        at: new Date(nowMs - 120_000),
        state: "merged",
      });
      await change(3, finishedUpdatedId, {
        at: new Date(nowMs - 90_000),
        state: "closed",
      });
      // Another plugin's code change in the same Conversation is not work.
      await recordCodeChange(fixture.sql.db(), "other", {
        conversationIds: [finishedId],
        number: 4,
        openedAt: new Date(nowMs - 300_000),
        providerId: "change-4",
        repository: { name: "getsentry/junior", providerId: "repository-1" },
        state: "open",
        updatedAt: new Date(nowMs - 300_000),
      });
      setPlugins([
        defineJuniorPlugin({
          manifest: {
            name: "work",
            displayName: "Work",
            description: "Unfinished work test plugin",
          },
          hooks: {
            // The plugin reads its code changes from Junior's code index.
            async unfinishedWork(ctx) {
              seenConversationIds.push([...ctx.conversationIds]);
              const changes = await ctx.codeChanges.list({
                conversationIds: ctx.conversationIds,
              });
              const finishedAt = (change: (typeof changes)[number]) =>
                (change.mergedAt ?? change.closedAt)!.toISOString();
              return {
                assignedConversationIds: changes.flatMap(
                  (change) => change.conversationIds,
                ),
                conversationIds: changes
                  .filter((change) => change.state === "open")
                  .flatMap((change) => change.conversationIds),
                finishedWorkAtByConversationId: Object.fromEntries(
                  changes
                    .filter((change) => change.state !== "open")
                    .flatMap((change) =>
                      change.conversationIds.map((id) => [
                        id,
                        finishedAt(change),
                      ]),
                    ),
                ),
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

  test("treats a root with no stored visibility as private", async () => {
    const fixture = createConfiguredJuniorSqlFixture();
    const store = createSqlStore(fixture.sql);
    const conversationId = "slack:C123:missing-visibility";
    try {
      await migrateSchema(fixture.sql);
      await store.recordActivity({
        conversationId,
        destination: { platform: "slack", teamId: "T123", channelId: "C123" },
        nowMs: 1_000,
        source: "slack",
        visibility: "public",
      });
      // A writer of an older deploy leaves the root null. Its public
      // Destination does not widen access.
      const db = fixture.sql.db();
      await db
        .update(juniorConversations)
        .set({ visibility: null })
        .where(eq(juniorConversations.conversationId, conversationId));
      const access = await readConversationAccessFromSql(db, [conversationId]);
      expect(access.get(conversationId)).toMatchObject({
        canViewPrivateContent: false,
        visibility: null,
      });
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
        destination: {
          platform: "slack" as const,
          teamId: "T1",
          channelId: "C1",
        },
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
        destination: {
          platform: "slack" as const,
          teamId: "T1",
          channelId: "C1",
        },
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
        destination: {
          platform: "slack" as const,
          teamId: "T1",
          channelId: "C1",
        },
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
        destination: {
          platform: "slack" as const,
          teamId: "T1",
          channelId: "C1",
        },
        nowMs: 4_000,
        source: "slack",
        title: "Launch plan",
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
        destination: {
          platform: "slack" as const,
          teamId: "T1",
          channelId: "C1",
        },
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
        destination: {
          platform: "slack" as const,
          teamId: "T1",
          channelId: "C1",
        },
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
        destination: {
          platform: "slack" as const,
          teamId: "T1",
          channelId: "D1",
        },
        nowMs: 2_000,
        source: "slack",
        title: "Launch plan follow-up",
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
      // A trusted account link gives the Slack Identity its User later.
      await upsertLinkedIdentity(fixture.sql, linkedUserId!, {
        kind: "user",
        provider: "slack",
        providerSubjectId: "U1B",
        providerTenantId: "T1",
      });

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
      // Search keeps the same membership: a newer match from someone else
      // must not use up the limit.
      await expect(
        readConversationFeedFromSql({ viewer, q: "launch", limit: 1 }),
      ).resolves.toMatchObject({
        conversations: [
          expect.objectContaining({
            conversationId: "slack:D1:morgan-linked",
          }),
        ],
      });
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
        destination: {
          platform: "slack" as const,
          teamId: "T1",
          channelId: "C1",
        },
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
        destination: {
          platform: "slack" as const,
          teamId: "T1",
          channelId: "C1",
        },
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
      await fixture.sql
        .db()
        .insert(juniorIdentities)
        .values({
          id: "identity-participant-slack",
          avatarUrl: "https://avatars.slack-edge.com/participant_512.jpg",
          createdAt: new Date(1_000),
          email: "participant@example.com",
          emailNormalized: "participant@example.com",
          emailVerified: true,
          kind: "user",
          provider: "slack",
          providerSubjectId: "UPARTICIPANT1",
          providerTenantId: "T1",
          updatedAt: new Date(1_000),
          userId: participantUserId!,
        });
      // Photos: the participant has Slack and Google photos, and the owner has
      // only a Google photo. The Slack photo wins, and Google is the fallback.
      const [owner] = await fixture.sql
        .db()
        .select({ id: juniorUsers.id })
        .from(juniorUsers)
        .where(eq(juniorUsers.primaryEmailNormalized, "owner@example.com"));
      await fixture.sql
        .db()
        .insert(juniorIdentities)
        .values(
          [
            { subject: "google-participant", userId: participantUserId! },
            { subject: "google-owner", userId: owner!.id },
          ].map(({ subject, userId }) => ({
            id: `identity-${subject}`,
            avatarUrl: `https://lh3.googleusercontent.com/a/${subject}`,
            createdAt: new Date(2_000),
            kind: "user" as const,
            provider: "google",
            providerSubjectId: subject,
            updatedAt: new Date(2_000),
            userId,
          })),
        );
      await fixture.sql
        .db()
        .insert(juniorConversationEvents)
        .values([
          // An event Message author is not a participant.
          {
            actorIdentityId: SYSTEM_IDENTITY_ID,
            conversationId: "slack:C1:shared-thread",
            createdAt: new Date(5_300),
            historyVersion: 0,
            payload: {
              messageId: "event-message",
              role: "user",
              text: "Pull request merged.",
            },
            seq: 2,
            type: "message",
          },
          {
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
                  userId: "UPARTICIPANT1",
                  userName: "participant",
                },
                explicitMention: true,
              },
              role: "user",
              text: "@junior make urls clickable",
            },
            seq: 0,
            type: "message",
          },
          {
            conversationId: "slack:C1:shared-thread",
            createdAt: new Date(5_400),
            historyVersion: 0,
            payload: {
              messageId: "1786500342.616840",
              role: "assistant",
              text: "<@UPARTICIPANT1> I updated the links and checked the result.",
            },
            seq: 1,
            type: "message",
          },
        ]);
      await fixture.sql
        .db()
        .insert(juniorConversationParticipants)
        .values({
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
        activityPreview: {
          createdAt: new Date(5_400).toISOString(),
          // Previews resolve mentions like transcript messages do.
          mentions: [
            {
              email: "participant@example.com",
              fullName: "Participant",
              slackUserId: "UPARTICIPANT1",
            },
          ],
          role: "assistant",
          text: "<@UPARTICIPANT1> I updated the links and checked the result.",
        },
        actorIdentity: expect.objectContaining({
          slackUserId: "U-OWNER",
        }),
        conversationId: "slack:C1:shared-thread",
        isParticipant: true,
        participants: [
          expect.objectContaining({
            avatarUrl: avatarPath("identity-google-owner"),
            email: "owner@example.com",
            slackUserId: "U-OWNER",
          }),
          expect.objectContaining({
            avatarUrl: avatarPath("identity-participant-slack"),
            email: "participant@example.com",
            fullName: "Participant",
            slackUserId: "UPARTICIPANT1",
          }),
        ],
      });
    } finally {
      await fixture.close();
    }
  });
});
