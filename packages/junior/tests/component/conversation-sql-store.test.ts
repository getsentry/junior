import { describe, expect, it, vi } from "vitest";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { upsertIdentity } from "@/chat/identities/sql";
import {
  appendInboundMessage,
  drainConversationMailbox,
  startConversationWork,
} from "@/chat/task-execution/store";
import { processConversationWork } from "@/chat/task-execution/worker";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { upsertAgentTurnSessionRecord } from "@/chat/state/turn-session";
import {
  juniorConversations,
  juniorDestinations,
  juniorIdentities,
  juniorUsers,
} from "@/db/schema";
import { eq } from "drizzle-orm";
import { readConversationFeedFromSql } from "@/api/conversations/list";
import {
  CONVERSATION_ID,
  conversationQueueMessage,
  createConversationWorkQueueTestAdapter,
  deferred,
  inboundMessage,
} from "../fixtures/conversation-work";
import {
  createConfiguredJuniorSqlFixture,
  createLocalJuniorSqlFixture,
} from "../fixtures/sql";

describe("conversation SQL store", () => {
  it("persists queryable conversation records and linked identities", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      const store = createSqlStore(fixture.sql);
      await migrateSchema(fixture.sql);

      await store.recordActivity({
        conversationId: CONVERSATION_ID,
        channelName: "eng-runtime",
        destination: inboundMessage("activity").destination,
        actor: {
          email: "user@example.com",
          fullName: "Runtime User",
          platform: "slack",
          slackUserId: "U123",
          slackUserName: "runtime-user",
          teamId: "T123",
        },
        source: "slack",
        title: "SQL conversation store",
        nowMs: 3_000,
      });

      const conversations = await store.listByActivity({
        limit: 5,
      });
      expect(conversations).toMatchObject([
        {
          conversationId: CONVERSATION_ID,
          channelName: "eng-runtime",
          destination: {
            platform: "slack",
            teamId: "T123",
            channelId: "C123",
          },
          actor: {
            platform: "slack",
            teamId: "T123",
            slackUserId: "U123",
          },
          title: "SQL conversation store",
          execution: {
            status: "idle",
          },
        },
      ]);
      expect(conversations[0]?.execution).not.toHaveProperty("pendingCount");
      expect(conversations[0]?.execution).not.toHaveProperty("pendingMessages");

      const linkedRows = await fixture.sql
        .db()
        .select({
          actorIdentityId: juniorConversations.actorIdentityId,
          actorJson: juniorConversations.actor,
          destinationId: juniorConversations.destinationId,
          destinationJson: juniorConversations.destination,
          destinationKind: juniorDestinations.kind,
          destinationProvider: juniorDestinations.provider,
          destinationProviderSubject: juniorDestinations.providerDestinationId,
          destinationTenant: juniorDestinations.providerTenantId,
          actorEmail: juniorIdentities.email,
          actorHandle: juniorIdentities.handle,
          actorKind: juniorIdentities.kind,
          actorProvider: juniorIdentities.provider,
          actorProviderSubject: juniorIdentities.providerSubjectId,
          actorTenant: juniorIdentities.providerTenantId,
        })
        .from(juniorConversations)
        .innerJoin(
          juniorDestinations,
          eq(juniorDestinations.id, juniorConversations.destinationId),
        )
        .innerJoin(
          juniorIdentities,
          eq(juniorIdentities.id, juniorConversations.actorIdentityId),
        )
        .where(eq(juniorConversations.conversationId, CONVERSATION_ID));
      expect(linkedRows).toEqual([
        {
          actorIdentityId: linkedRows[0]?.actorIdentityId,
          actorJson: null,
          destinationId: linkedRows[0]?.destinationId,
          destinationJson: null,
          destinationKind: "channel",
          destinationProvider: "slack",
          destinationProviderSubject: "C123",
          destinationTenant: "T123",
          actorEmail: "user@example.com",
          actorHandle: "runtime-user",
          actorKind: "user",
          actorProvider: "slack",
          actorProviderSubject: "U123",
          actorTenant: "T123",
        },
      ]);

      await fixture.sql
        .db()
        .update(juniorConversations)
        .set({
          destination: {
            platform: "slack",
            teamId: "T-stale",
            channelId: "C-stale",
          },
          actor: {
            platform: "slack",
            teamId: "T-stale",
            slackUserId: "U-stale",
          },
        })
        .where(eq(juniorConversations.conversationId, CONVERSATION_ID));

      await expect(
        store.get({ conversationId: CONVERSATION_ID }),
      ).resolves.toMatchObject({
        destination: {
          platform: "slack",
          teamId: "T123",
          channelId: "C123",
        },
        actor: {
          platform: "slack",
          teamId: "T123",
          slackUserId: "U123",
        },
      });
    } finally {
      await fixture.close();
    }
  });

  it("links actor identities to users by case-insensitive verified email", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      const store = createSqlStore(fixture.sql);
      await migrateSchema(fixture.sql);

      const identity = await upsertIdentity(
        fixture.sql,
        {
          kind: "user",
          provider: "slack",
          providerTenantId: "T123",
          providerSubjectId: "U123",
          email: "Alice@Example.COM",
          emailVerified: true,
          displayName: "Alice Example",
          handle: "alice",
        },
        1_000,
      );

      await upsertIdentity(
        fixture.sql,
        {
          kind: "user",
          provider: "slack",
          providerTenantId: "T123",
          providerSubjectId: "U123",
          email: "alice@example.com",
          emailVerified: true,
          displayName: "Changed Name",
        },
        2_000,
      );
      const secondIdentity = await upsertIdentity(
        fixture.sql,
        {
          kind: "user",
          provider: "slack",
          providerTenantId: "T123",
          providerSubjectId: "U456",
          email: "ALICE@example.com",
          emailVerified: true,
          displayName: "Alice Other Device",
        },
        2_500,
      );

      await store.recordActivity({
        conversationId: CONVERSATION_ID,
        destination: inboundMessage("identity").destination,
        actor: {
          platform: "slack",
          slackUserId: "U123",
          teamId: "T123",
        },
        source: "slack",
        nowMs: 3_000,
      });

      const users = await fixture.sql
        .db()
        .select({
          displayName: juniorUsers.displayName,
          email: juniorUsers.primaryEmail,
          emailNormalized: juniorUsers.primaryEmailNormalized,
          id: juniorUsers.id,
        })
        .from(juniorUsers);
      expect(users).toEqual([
        {
          displayName: "Alice Example",
          email: "Alice@Example.COM",
          emailNormalized: "alice@example.com",
          id: identity.userId,
        },
      ]);
      expect(secondIdentity.userId).toBe(identity.userId);

      const actorConversations = await store.listByActivity({ limit: 5 });
      expect(actorConversations).toMatchObject([
        {
          conversationId: CONVERSATION_ID,
          actor: {
            email: "alice@example.com",
            fullName: "Alice Example",
            slackUserId: "U123",
            slackUserName: "alice",
          },
        },
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("preserves an existing verified identity email when linking its user", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateSchema(fixture.sql);

      await fixture.sql
        .db()
        .insert(juniorIdentities)
        .values({
          id: "legacy-identity",
          kind: "user",
          provider: "slack",
          providerTenantId: "T123",
          providerSubjectId: "U123",
          displayName: "Legacy Name",
          handle: "legacy",
          email: "Legacy@Example.com",
          emailNormalized: "legacy@example.com",
          emailVerified: true,
          avatarUrl: null,
          metadata: null,
          createdAt: new Date(1_000),
          updatedAt: new Date(1_000),
          userId: null,
        });

      const identity = await upsertIdentity(
        fixture.sql,
        {
          kind: "user",
          provider: "slack",
          providerTenantId: "T123",
          providerSubjectId: "U123",
          email: "changed@example.com",
          emailVerified: true,
          displayName: "Changed Name",
        },
        2_000,
      );

      await expect(
        fixture.sql.db().select().from(juniorUsers),
      ).resolves.toMatchObject([
        {
          displayName: "Legacy Name",
          primaryEmail: "Legacy@Example.com",
          primaryEmailNormalized: "legacy@example.com",
        },
      ]);
      await expect(
        fixture.sql
          .db()
          .select({
            email: juniorIdentities.email,
            emailNormalized: juniorIdentities.emailNormalized,
            userId: juniorIdentities.userId,
          })
          .from(juniorIdentities)
          .where(eq(juniorIdentities.id, "legacy-identity")),
      ).resolves.toEqual([
        {
          email: "Legacy@Example.com",
          emailNormalized: "legacy@example.com",
          userId: identity.userId,
        },
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("fills missing actor identity from later trusted profile observations", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      const store = createSqlStore(fixture.sql);
      await migrateSchema(fixture.sql);

      await store.recordActivity({
        conversationId: CONVERSATION_ID,
        destination: inboundMessage("identity-fill").destination,
        actor: {
          platform: "slack",
          slackUserId: "U123",
          teamId: "T123",
        },
        source: "slack",
        nowMs: 1_000,
      });
      await store.recordActivity({
        conversationId: CONVERSATION_ID,
        destination: inboundMessage("identity-fill").destination,
        actor: {
          email: "Casey@Example.com",
          fullName: "Casey Example",
          platform: "slack",
          slackUserId: "U123",
          teamId: "T123",
        },
        source: "slack",
        nowMs: 2_000,
      });

      await expect(store.listByActivity({ limit: 5 })).resolves.toMatchObject([
        {
          conversationId: CONVERSATION_ID,
          actor: {
            email: "casey@example.com",
            fullName: "Casey Example",
            slackUserId: "U123",
          },
        },
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("persists visibility from source signals and converges on newer signals", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      const store = createSqlStore(fixture.sql);
      await migrateSchema(fixture.sql);
      const destination = inboundMessage("visibility").destination;

      // Slack reports this C-prefixed channel private (channel_type: group).
      await store.recordActivity({
        conversationId: CONVERSATION_ID,
        destination,
        visibility: "private",
        nowMs: 1_000,
      });
      await expect(
        store.get({ conversationId: CONVERSATION_ID }),
      ).resolves.toMatchObject({ visibility: "private" });
      await expect(
        store.getDestinationVisibility({
          provider: "slack",
          providerTenantId: "T123",
          providerDestinationId: "C123",
        }),
      ).resolves.toBe("private");

      // A signal-less write must not clobber the stored value.
      await store.recordActivity({
        conversationId: CONVERSATION_ID,
        destination,
        nowMs: 2_000,
      });
      await expect(
        store.get({ conversationId: CONVERSATION_ID }),
      ).resolves.toMatchObject({ visibility: "private" });

      // A channel converted private -> public converges on the next signal.
      await store.recordActivity({
        conversationId: CONVERSATION_ID,
        destination,
        visibility: "public",
        nowMs: 3_000,
      });
      await expect(
        store.get({ conversationId: CONVERSATION_ID }),
      ).resolves.toMatchObject({ visibility: "public" });
      await expect(
        store.getDestinationVisibility({
          provider: "slack",
          providerTenantId: "T123",
          providerDestinationId: "C123",
        }),
      ).resolves.toBe("public");

      await store.recordActivity({
        conversationId: CONVERSATION_ID,
        destination,
        nowMs: 4_000,
      });
      await expect(
        store.get({ conversationId: CONVERSATION_ID }),
      ).resolves.toMatchObject({ visibility: "public" });
    } finally {
      await fixture.close();
    }
  });

  it("defaults unsigned Slack destinations to private", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      const store = createSqlStore(fixture.sql);
      await migrateSchema(fixture.sql);

      // A write without a live source signal fails closed to private even
      // though the channel id is C-prefixed.
      await store.recordActivity({
        conversationId: CONVERSATION_ID,
        destination: inboundMessage("unsigned").destination,
        nowMs: 1_000,
      });
      const conversation = await store.get({
        conversationId: CONVERSATION_ID,
      });
      expect(conversation?.visibility).toBe("private");
      await expect(
        store.getDestinationVisibility({
          provider: "slack",
          providerTenantId: "T123",
          providerDestinationId: "C123",
        }),
      ).resolves.toBe("private");
    } finally {
      await fixture.close();
    }
  });

  it("rejects legacy JSON metadata that was not migrated to foreign keys", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      const store = createSqlStore(fixture.sql);
      await migrateSchema(fixture.sql);
      await fixture.sql.execute(
        `
INSERT INTO junior_conversations (
  conversation_id,
  destination_json,
  actor_json,
  created_at,
  last_activity_at,
  updated_at,
  execution_status
) VALUES ($1, $2::jsonb, $3::jsonb, $4, $5, $6, $7)
`,
        [
          "slack:C123:invalid-json",
          JSON.stringify({ platform: "slack", teamId: "T123" }),
          JSON.stringify({ platform: "slack", teamId: "T123" }),
          new Date(1_000).toISOString(),
          new Date(1_000).toISOString(),
          new Date(1_000).toISOString(),
          "idle",
        ],
      );
      await fixture.sql.execute(
        `
INSERT INTO junior_conversations (
  conversation_id,
  actor_json,
  created_at,
  last_activity_at,
  updated_at,
  execution_status
) VALUES ($1, $2::jsonb, $3, $4, $5, $6)
`,
        [
          "slack:C123:legacy-actor",
          JSON.stringify({ platform: "slack", slackUserId: "U123" }),
          new Date(1_000).toISOString(),
          new Date(1_000).toISOString(),
          new Date(1_000).toISOString(),
          "idle",
        ],
      );

      await expect(
        store.get({ conversationId: "slack:C123:invalid-json" }),
      ).rejects.toThrow("Conversation legacy destination is not migrated");
      await expect(
        store.get({ conversationId: "slack:C123:legacy-actor" }),
      ).rejects.toThrow("Conversation legacy actor is not migrated");
    } finally {
      await fixture.close();
    }
  });

  it("keeps newer SQL execution when a stale mirror arrives later", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      const store = createSqlStore(fixture.sql);
      await migrateSchema(fixture.sql);

      await store.recordExecution({
        conversationId: CONVERSATION_ID,
        createdAtMs: 1_000,
        execution: {
          lastCheckpointAtMs: 5_000,
          lastEnqueuedAtMs: 4_000,
          runId: "run-new",
          status: "running",
          updatedAtMs: 5_000,
        },
        metrics: null,
        lastActivityAtMs: 5_000,
        title: "Fresh execution",
        updatedAtMs: 5_000,
      });
      await store.recordExecution({
        conversationId: CONVERSATION_ID,
        createdAtMs: 1_000,
        execution: {
          runId: "run-old",
          status: "idle",
          updatedAtMs: 4_000,
        },
        metrics: null,
        lastActivityAtMs: 6_000,
        title: "Stale execution",
        updatedAtMs: 4_000,
      });

      await expect(
        store.get({ conversationId: CONVERSATION_ID }),
      ).resolves.toMatchObject({
        lastActivityAtMs: 6_000,
        execution: {
          lastCheckpointAtMs: 5_000,
          lastEnqueuedAtMs: 4_000,
          runId: "run-new",
          status: "running",
          updatedAtMs: 5_000,
        },
      });
    } finally {
      await fixture.close();
    }
  });

  it("replaces the matching run metrics after execution cursor changes", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      const store = createSqlStore(fixture.sql);
      await migrateSchema(fixture.sql);
      await store.recordExecution({
        conversationId: CONVERSATION_ID,
        createdAtMs: 1_000,
        execution: {
          runId: "run-1",
          status: "running",
          updatedAtMs: 2_000,
        },
        metrics: {
          durationMs: 1_000,
          usage: { totalTokens: 10, cost: { total: 0.01 } },
        },
        lastActivityAtMs: 2_000,
        updatedAtMs: 2_000,
      });
      await store.recordExecution({
        conversationId: CONVERSATION_ID,
        createdAtMs: 1_000,
        execution: {
          runId: "run-2",
          status: "running",
          updatedAtMs: 3_000,
        },
        metrics: null,
        lastActivityAtMs: 3_000,
        updatedAtMs: 3_000,
      });
      await store.recordExecution({
        conversationId: CONVERSATION_ID,
        createdAtMs: 1_000,
        execution: {
          runId: "run-1",
          status: "idle",
          updatedAtMs: 4_000,
        },
        metrics: {
          durationMs: 1_500,
          usage: { totalTokens: 15, cost: { total: 0.015 } },
        },
        lastActivityAtMs: 4_000,
        updatedAtMs: 4_000,
      });

      const [metrics] = await fixture.sql.query<{
        durationMs: number;
        executionDurationMs: number;
        metricRunId: string | null;
        usage: { cost?: { total?: number }; totalTokens?: number } | null;
      }>(
        `
SELECT
  duration_ms AS "durationMs",
  execution_duration_ms AS "executionDurationMs",
  metric_run_id AS "metricRunId",
  usage_json AS usage
FROM junior_conversations
WHERE conversation_id = $1
`,
        [CONVERSATION_ID],
      );
      expect(metrics).toMatchObject({
        durationMs: 1_500,
        executionDurationMs: 1_500,
        metricRunId: "run-1",
        usage: { cost: { total: 0.015 }, totalTokens: 15 },
      });
    } finally {
      await fixture.close();
    }
  });

  it("backfills totals without replacing a newer execution cursor", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      const store = createSqlStore(fixture.sql);
      await migrateSchema(fixture.sql);
      await store.recordExecution({
        conversationId: CONVERSATION_ID,
        createdAtMs: 1_000,
        execution: {
          runId: "run-old",
          status: "idle",
          updatedAtMs: 4_000,
        },
        metrics: null,
        lastActivityAtMs: 4_000,
        updatedAtMs: 4_000,
      });
      const stale = await store.get({ conversationId: CONVERSATION_ID });
      expect(stale).toBeDefined();
      await store.recordExecution({
        conversationId: CONVERSATION_ID,
        createdAtMs: 1_000,
        execution: {
          runId: "run-new",
          status: "running",
          updatedAtMs: 5_000,
        },
        metrics: null,
        lastActivityAtMs: 5_000,
        updatedAtMs: 5_000,
      });

      await store.backfillConversation(stale!, {
        durationMs: 1_000,
        executionDurationMs: 1_000,
        executionUsage: { totalTokens: 10 },
        usage: { totalTokens: 10 },
      });
      await store.recordExecution({
        conversationId: CONVERSATION_ID,
        createdAtMs: 1_000,
        execution: {
          runId: "run-new",
          status: "idle",
          updatedAtMs: 6_000,
        },
        metrics: {
          durationMs: 200,
          usage: { totalTokens: 2 },
        },
        lastActivityAtMs: 6_000,
        updatedAtMs: 6_000,
      });

      const [metrics] = await fixture.sql.query<{
        durationMs: number;
        executionDurationMs: number;
        runId: string | null;
        usage: { totalTokens?: number } | null;
      }>(
        `
SELECT
  duration_ms AS "durationMs",
  execution_duration_ms AS "executionDurationMs",
  run_id AS "runId",
  usage_json AS usage
FROM junior_conversations
WHERE conversation_id = $1
`,
        [CONVERSATION_ID],
      );
      expect(metrics).toMatchObject({
        durationMs: 1_200,
        executionDurationMs: 200,
        runId: "run-new",
        usage: { totalTokens: 12 },
      });
    } finally {
      await fixture.close();
    }
  });

  it("keeps SQL execution timestamps when a fresh summary omits them", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      const store = createSqlStore(fixture.sql);
      await migrateSchema(fixture.sql);

      await store.recordExecution({
        conversationId: CONVERSATION_ID,
        createdAtMs: 1_000,
        execution: {
          lastCheckpointAtMs: 5_000,
          lastEnqueuedAtMs: 4_000,
          runId: "run-worker",
          status: "running",
          updatedAtMs: 5_000,
        },
        metrics: null,
        lastActivityAtMs: 5_000,
        updatedAtMs: 5_000,
      });
      await store.recordExecution({
        conversationId: CONVERSATION_ID,
        createdAtMs: 1_000,
        execution: {
          runId: "run-summary",
          status: "failed",
          updatedAtMs: 6_000,
        },
        metrics: null,
        lastActivityAtMs: 6_000,
        updatedAtMs: 6_000,
      });

      await expect(
        store.get({ conversationId: CONVERSATION_ID }),
      ).resolves.toMatchObject({
        execution: {
          lastCheckpointAtMs: 5_000,
          lastEnqueuedAtMs: 4_000,
          runId: "run-summary",
          status: "failed",
          updatedAtMs: 6_000,
        },
      });
    } finally {
      await fixture.close();
    }
  });

  it("keeps the earliest creation time across SQL metadata updates", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      const store = createSqlStore(fixture.sql);
      await migrateSchema(fixture.sql);

      await store.recordActivity({
        conversationId: CONVERSATION_ID,
        nowMs: 5_000,
      });
      await store.recordExecution({
        conversationId: CONVERSATION_ID,
        createdAtMs: 1_000,
        execution: {
          status: "running",
          updatedAtMs: 6_000,
        },
        metrics: null,
        lastActivityAtMs: 6_000,
        updatedAtMs: 6_000,
      });

      await expect(
        store.get({ conversationId: CONVERSATION_ID }),
      ).resolves.toMatchObject({
        createdAtMs: 1_000,
        lastActivityAtMs: 6_000,
        updatedAtMs: 6_000,
      });
    } finally {
      await fixture.close();
    }
  });

  it("uses SQL execution status for plugin conversation summaries", async () => {
    const fixture = createConfiguredJuniorSqlFixture();

    try {
      await disconnectStateAdapter();
      const store = createSqlStore(fixture.sql);
      await migrateSchema(fixture.sql);
      await store.recordExecution({
        conversationId: CONVERSATION_ID,
        createdAtMs: 1_000,
        destination: inboundMessage("summary-target").destination,
        execution: { status: "failed", updatedAtMs: 1_200 },
        metrics: null,
        lastActivityAtMs: 1_200,
        updatedAtMs: 1_200,
      });

      await expect(
        readConversationFeedFromSql({ limit: 1 }),
      ).resolves.toMatchObject({
        conversations: [
          expect.objectContaining({
            conversationId: CONVERSATION_ID,
            status: "failed",
          }),
        ],
      });
    } finally {
      await disconnectStateAdapter();
      await fixture.close();
    }
  });

  it("reports stale running SQL execution status as active", async () => {
    const fixture = createConfiguredJuniorSqlFixture();

    try {
      vi.useFakeTimers({ now: 302_000 });
      await disconnectStateAdapter();
      const store = createSqlStore(fixture.sql);
      await migrateSchema(fixture.sql);
      await store.recordExecution({
        conversationId: CONVERSATION_ID,
        createdAtMs: 1_000,
        destination: inboundMessage("active-target").destination,
        execution: { status: "running", updatedAtMs: 1_500 },
        metrics: null,
        lastActivityAtMs: 1_500,
        updatedAtMs: 1_500,
      });

      await expect(
        readConversationFeedFromSql({ limit: 1 }),
      ).resolves.toMatchObject({
        conversations: [
          expect.objectContaining({
            conversationId: CONVERSATION_ID,
            status: "active",
          }),
        ],
      });
    } finally {
      vi.useRealTimers();
      await disconnectStateAdapter();
      await fixture.close();
    }
  });

  it("maps idle SQL execution status to completed", async () => {
    const fixture = createConfiguredJuniorSqlFixture();

    try {
      vi.useFakeTimers({ now: 2_000 });
      await disconnectStateAdapter();
      const store = createSqlStore(fixture.sql);
      await migrateSchema(fixture.sql);
      await store.recordExecution({
        conversationId: CONVERSATION_ID,
        createdAtMs: 1_000,
        destination: inboundMessage("completed-target").destination,
        execution: {
          runId: "run-completed",
          status: "idle",
          updatedAtMs: 2_000,
        },
        metrics: null,
        lastActivityAtMs: 2_000,
        updatedAtMs: 2_000,
      });
      await expect(
        readConversationFeedFromSql({ limit: 1 }),
      ).resolves.toMatchObject({
        conversations: [
          expect.objectContaining({
            conversationId: CONVERSATION_ID,
            status: "completed",
          }),
        ],
      });
    } finally {
      vi.useRealTimers();
      await disconnectStateAdapter();
      await fixture.close();
    }
  });

  it("keeps fresh SQL progress over stale turn-session state", async () => {
    const fixture = createConfiguredJuniorSqlFixture();

    try {
      vi.useFakeTimers({ now: 600_000 });
      await disconnectStateAdapter();
      const store = createSqlStore(fixture.sql);
      await migrateSchema(fixture.sql);
      await store.recordExecution({
        conversationId: CONVERSATION_ID,
        createdAtMs: 1_000,
        destination: inboundMessage("hung-target").destination,
        execution: {
          runId: "run-hung",
          status: "running",
          updatedAtMs: 600_000,
        },
        metrics: null,
        lastActivityAtMs: 600_000,
        updatedAtMs: 600_000,
      });
      await upsertAgentTurnSessionRecord({
        modelId: "test/model",
        conversationStore: store,
        conversationId: CONVERSATION_ID,
        destination: inboundMessage("hung-target").destination,
        lastProgressAtMs: 1_000,
        piMessages: [],
        sessionId: "turn-hung",
        sliceId: 1,
        state: "running",
        surface: "slack",
      });

      await expect(
        readConversationFeedFromSql({ limit: 1 }),
      ).resolves.toMatchObject({
        conversations: [
          expect.objectContaining({
            conversationId: CONVERSATION_ID,
            lastProgressAt: new Date(600_000).toISOString(),
            lastSeenAt: new Date(600_000).toISOString(),
            status: "active",
          }),
        ],
      });
    } finally {
      vi.useRealTimers();
      await disconnectStateAdapter();
      await fixture.close();
    }
  });

  it("mirrors worker check-ins into SQL execution progress", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      vi.useFakeTimers({ now: 1_000 });
      await disconnectStateAdapter();
      const state = getStateAdapter();
      const store = createSqlStore(fixture.sql);
      await migrateSchema(fixture.sql);
      await appendInboundMessage({
        message: inboundMessage("check-in"),
        conversationStore: store,
        nowMs: 1_000,
        state,
      });
      const queue = createConversationWorkQueueTestAdapter();
      const entered = deferred<void>();
      const finish = deferred<void>();

      const running = processConversationWork(conversationQueueMessage(), {
        checkInIntervalMs: 15_000,
        conversationStore: store,
        queue,
        run: async (context) => {
          await context.attempt.drain(async () => {});
          entered.resolve();
          await finish.promise;
          return { status: "completed" };
        },
        state,
      });
      await entered.promise;

      await vi.advanceTimersByTimeAsync(15_000);
      await vi.waitFor(async () => {
        await expect(
          store.get({ conversationId: CONVERSATION_ID }),
        ).resolves.toMatchObject({
          execution: {
            status: "running",
            updatedAtMs: 16_000,
          },
        });
      });

      finish.resolve();
      await expect(running).resolves.toEqual({ status: "completed" });
    } finally {
      vi.useRealTimers();
      await disconnectStateAdapter();
      await fixture.close();
    }
  });

  it("mirrors mailbox drains into SQL execution progress", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await disconnectStateAdapter();
      const state = getStateAdapter();
      const store = createSqlStore(fixture.sql);
      await migrateSchema(fixture.sql);
      await appendInboundMessage({
        message: inboundMessage("drain-sql"),
        conversationStore: store,
        nowMs: 1_000,
        state,
      });
      const lease = await startConversationWork({
        conversationId: CONVERSATION_ID,
        conversationStore: store,
        nowMs: 2_000,
        state,
      });
      expect(lease.status).toBe("acquired");
      if (lease.status !== "acquired") {
        throw new Error("Expected conversation work lease");
      }

      await drainConversationMailbox({
        conversationId: CONVERSATION_ID,
        conversationStore: store,
        handle: async () => {},
        leaseToken: lease.leaseToken,
        nowMs: 3_000,
        state,
      });

      await expect(
        store.get({ conversationId: CONVERSATION_ID }),
      ).resolves.toMatchObject({
        execution: {
          status: "running",
          updatedAtMs: 3_000,
        },
      });
    } finally {
      await disconnectStateAdapter();
      await fixture.close();
    }
  });
});
