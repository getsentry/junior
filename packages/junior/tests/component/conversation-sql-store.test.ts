import { describe, expect, it, vi } from "vitest";
import { backfillToSql } from "@/chat/conversations/sql/backfill";
import { migrateSchema, migrations } from "@/chat/conversations/sql/migrations";
import { createSqlStore, SqlStore } from "@/chat/conversations/sql/store";
import { createStateConversationStore } from "@/chat/conversations/state";
import { upsertIdentity } from "@/chat/identities/sql";
import {
  appendInboundMessage,
  drainConversationMailbox,
  startConversationWork,
} from "@/chat/task-execution/store";
import { processConversationWork } from "@/chat/task-execution/worker";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { upsertAgentTurnSessionRecord } from "@/chat/state/turn-session";
import type { JuniorSqlMigrationExecutor } from "@/chat/sql/db";
import {
  juniorConversations,
  juniorDestinations,
  juniorIdentities,
  juniorUsers,
} from "@/chat/sql/schema";
import { eq } from "drizzle-orm";
import {
  listRecentConversationSummaries,
  readConversationFeed,
} from "@/reporting/conversations";
import {
  CONVERSATION_ID,
  conversationQueueMessage,
  createConversationWorkQueueTestAdapter,
  deferred,
  inboundMessage,
} from "../fixtures/conversation-work";
import { createLocalJuniorSqlFixture } from "../fixtures/sql";

describe("conversation SQL store", () => {
  it("requires explicit schema migration before store use", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      const store = createSqlStore(fixture.sql);

      await expect(
        store.recordActivity({
          conversationId: CONVERSATION_ID,
          nowMs: 1_000,
        }),
      ).rejects.toThrow("junior_conversations");

      await store.migrate();
      await expect(
        store.recordActivity({
          conversationId: CONVERSATION_ID,
          nowMs: 1_000,
        }),
      ).resolves.toBeUndefined();

      await expect(
        fixture.sql.query(
          "SELECT id FROM junior_schema_migrations ORDER BY id ASC",
        ),
      ).resolves.toHaveLength(3);
    } finally {
      await fixture.close();
    }
  });

  it("retries schema migration after a failed first attempt", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      let attempts = 0;
      const migrationExecutor: JuniorSqlMigrationExecutor = {
        db: () => fixture.sql.db(),
        execute: (statement, params) => fixture.sql.execute(statement, params),
        query: <T = unknown>(statement: string, params?: readonly unknown[]) =>
          fixture.sql.query<T>(statement, params),
        transaction: (callback) => fixture.sql.transaction(callback),
        withLock: async (lockName, callback) => {
          attempts++;
          if (attempts === 1) {
            throw new Error("transient schema failure");
          }
          return await fixture.sql.withLock(lockName, callback);
        },
      };
      const store = new SqlStore(fixture.sql, migrationExecutor);

      await expect(store.migrate()).rejects.toThrow("transient schema failure");
      await expect(store.migrate()).resolves.toBeUndefined();
      expect(attempts).toBe(2);
    } finally {
      await fixture.close();
    }
  });

  it("backfills legacy verified identities to shared users", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await fixture.sql.execute(`
CREATE TABLE IF NOT EXISTS junior_schema_migrations (
  id TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
)
`);
      for (const migration of migrations.slice(0, 2)) {
        await fixture.sql.transaction(async () => {
          for (const statement of migration.statements) {
            await fixture.sql.execute(statement);
          }
          await fixture.sql.execute(
            "INSERT INTO junior_schema_migrations (id, checksum) VALUES ($1, $2)",
            [migration.id, migration.checksum],
          );
        });
      }

      await fixture.sql.execute(
        `
INSERT INTO junior_identities (
  id,
  kind,
  provider,
  provider_tenant_id,
  provider_subject_id,
  display_name,
  handle,
  email,
  avatar_url,
  metadata_json,
  created_at,
  updated_at
)
VALUES ($1, 'user', 'slack', 'T123', 'U123', 'Legacy User', 'legacy', 'Legacy@Example.com', NULL, NULL, $2, $2)
`,
        ["legacy-identity", new Date(1_000)],
      );
      await fixture.sql.execute(
        `
INSERT INTO junior_identities (
  id,
  kind,
  provider,
  provider_tenant_id,
  provider_subject_id,
  display_name,
  handle,
  email,
  avatar_url,
  metadata_json,
  created_at,
  updated_at
)
VALUES ($1, 'user', 'manual', '', 'manual-user', 'Manual User', NULL, 'Manual@Example.com', NULL, NULL, $2, $2)
`,
        ["manual-identity", new Date(1_000)],
      );

      await migrateSchema(fixture.sql);

      await expect(
        fixture.sql.db().select().from(juniorUsers),
      ).resolves.toMatchObject([
        {
          displayName: "Legacy User",
          id: "identity:legacy-identity",
          primaryEmail: "Legacy@Example.com",
          primaryEmailNormalized: "legacy@example.com",
        },
      ]);
      await expect(
        fixture.sql
          .db()
          .select({
            emailNormalized: juniorIdentities.emailNormalized,
            emailVerified: juniorIdentities.emailVerified,
            provider: juniorIdentities.provider,
            userId: juniorIdentities.userId,
          })
          .from(juniorIdentities)
          .orderBy(juniorIdentities.id),
      ).resolves.toEqual(
        expect.arrayContaining([
          {
            emailNormalized: "legacy@example.com",
            emailVerified: true,
            provider: "slack",
            userId: "identity:legacy-identity",
          },
          {
            emailNormalized: "manual@example.com",
            emailVerified: false,
            provider: "manual",
            userId: null,
          },
        ]),
      );
    } finally {
      await fixture.close();
    }
  });

  it("persists queryable conversation records and linked identities", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      const store = createSqlStore(fixture.sql);
      await store.migrate();

      await store.recordActivity({
        conversationId: CONVERSATION_ID,
        channelName: "eng-runtime",
        destination: inboundMessage("activity").destination,
        requester: {
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
          destinationId: juniorConversations.destinationId,
          destinationKind: juniorDestinations.kind,
          destinationProvider: juniorDestinations.provider,
          destinationProviderSubject: juniorDestinations.providerDestinationId,
          destinationTenant: juniorDestinations.providerTenantId,
          requesterEmail: juniorIdentities.email,
          requesterHandle: juniorIdentities.handle,
          requesterIdentityId: juniorConversations.requesterIdentityId,
          requesterKind: juniorIdentities.kind,
          requesterProvider: juniorIdentities.provider,
          requesterProviderSubject: juniorIdentities.providerSubjectId,
          requesterTenant: juniorIdentities.providerTenantId,
        })
        .from(juniorConversations)
        .innerJoin(
          juniorDestinations,
          eq(juniorDestinations.id, juniorConversations.destinationId),
        )
        .innerJoin(
          juniorIdentities,
          eq(juniorIdentities.id, juniorConversations.requesterIdentityId),
        )
        .where(eq(juniorConversations.conversationId, CONVERSATION_ID));
      expect(linkedRows).toEqual([
        {
          actorIdentityId: linkedRows[0]?.requesterIdentityId,
          destinationId: linkedRows[0]?.destinationId,
          destinationKind: "channel",
          destinationProvider: "slack",
          destinationProviderSubject: "C123",
          destinationTenant: "T123",
          requesterEmail: "user@example.com",
          requesterHandle: "runtime-user",
          requesterIdentityId: linkedRows[0]?.requesterIdentityId,
          requesterKind: "user",
          requesterProvider: "slack",
          requesterProviderSubject: "U123",
          requesterTenant: "T123",
        },
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("links requester identities to users by case-insensitive verified email", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      const store = createSqlStore(fixture.sql);
      await store.migrate();

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
        requester: {
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

      const requesterConversations = await store.listByActivity({ limit: 5 });
      expect(requesterConversations).toMatchObject([
        {
          conversationId: CONVERSATION_ID,
          requester: {
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
      const store = createSqlStore(fixture.sql);
      await store.migrate();

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

  it("fills missing requester identity from later trusted profile observations", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      const store = createSqlStore(fixture.sql);
      await store.migrate();

      await store.recordActivity({
        conversationId: CONVERSATION_ID,
        destination: inboundMessage("identity-fill").destination,
        requester: {
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
        requester: {
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
          requester: {
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
      await store.migrate();
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
      await store.migrate();

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

  it("migrates historical Slack public visibility guesses to private", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateSchema(fixture.sql, [migrations[0]]);
      await fixture.sql.execute(
        `
INSERT INTO junior_destinations (
  id, provider, provider_tenant_id, provider_destination_id,
  kind, visibility, created_at, updated_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
`,
        [
          "historical-public-destination",
          "slack",
          "T999",
          "C0LEGACY",
          "channel",
          "public",
          new Date(1_000).toISOString(),
          new Date(1_000).toISOString(),
        ],
      );

      const store = createSqlStore(fixture.sql);
      await store.migrate();

      await expect(
        store.getDestinationVisibility({
          provider: "slack",
          providerTenantId: "T999",
          providerDestinationId: "C0LEGACY",
        }),
      ).resolves.toBe("private");
    } finally {
      await fixture.close();
    }
  });

  it("rejects invalid serialized provider fields", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      const store = createSqlStore(fixture.sql);
      await store.migrate();
      await fixture.sql.execute(
        `
INSERT INTO junior_conversations (
  conversation_id,
  destination_json,
  requester_json,
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

      await expect(
        store.get({ conversationId: "slack:C123:invalid-json" }),
      ).rejects.toThrow("Conversation record destination is invalid");
    } finally {
      await fixture.close();
    }
  });

  it("backfills state-backed conversations without copying pending input", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await disconnectStateAdapter();
      const state = getStateAdapter();
      const source = createStateConversationStore(state);
      await appendInboundMessage({
        message: inboundMessage("backfill"),
        nowMs: 1_000,
        state,
      });
      await source.recordActivity({
        conversationId: CONVERSATION_ID,
        channelName: "eng-runtime",
        title: "Backfilled conversation",
        nowMs: 2_000,
      });

      const target = createSqlStore(fixture.sql);
      const result = await backfillToSql({
        source,
        target,
        limit: 10,
      });

      expect(result).toEqual({ copiedCount: 1 });
      const conversation = await target.get({
        conversationId: CONVERSATION_ID,
      });
      expect(conversation).toMatchObject({
        conversationId: CONVERSATION_ID,
        channelName: "eng-runtime",
        title: "Backfilled conversation",
        execution: {
          status: "pending",
        },
      });
      expect(conversation?.execution).not.toHaveProperty("pendingCount");
      expect(conversation?.execution).not.toHaveProperty("pendingMessages");
    } finally {
      await disconnectStateAdapter();
      await fixture.close();
    }
  });

  it("keeps newer SQL execution when a stale mirror arrives later", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      const store = createSqlStore(fixture.sql);
      await store.migrate();

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

  it("keeps SQL execution timestamps when a fresh summary omits them", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      const store = createSqlStore(fixture.sql);
      await store.migrate();

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
      await store.migrate();

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

  it("uses turn-session status for plugin conversation summaries", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await disconnectStateAdapter();
      const store = createSqlStore(fixture.sql);
      await store.migrate();
      await store.recordActivity({
        conversationId: CONVERSATION_ID,
        destination: inboundMessage("summary-target").destination,
        nowMs: 1_000,
      });
      await upsertAgentTurnSessionRecord({
        conversationStore: store,
        conversationId: CONVERSATION_ID,
        destination: inboundMessage("summary-target").destination,
        lastProgressAtMs: 1_200,
        piMessages: [],
        sessionId: "turn-failed",
        sliceId: 1,
        state: "failed",
        surface: "slack",
      });

      await expect(
        listRecentConversationSummaries({
          limit: 1,
          conversationStore: store,
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          conversationId: CONVERSATION_ID,
          status: "failed",
        }),
      ]);
    } finally {
      await disconnectStateAdapter();
      await fixture.close();
    }
  });

  it("keeps active turn-session status over idle SQL execution", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      vi.useFakeTimers({ now: 2_000 });
      await disconnectStateAdapter();
      const store = createSqlStore(fixture.sql);
      await store.migrate();
      await store.recordActivity({
        conversationId: CONVERSATION_ID,
        destination: inboundMessage("active-target").destination,
        nowMs: 1_000,
      });
      await upsertAgentTurnSessionRecord({
        conversationStore: store,
        conversationId: CONVERSATION_ID,
        destination: inboundMessage("active-target").destination,
        lastProgressAtMs: 1_500,
        piMessages: [],
        sessionId: "turn-active",
        sliceId: 1,
        state: "running",
        surface: "slack",
      });

      await expect(
        listRecentConversationSummaries({
          limit: 1,
          conversationStore: store,
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          conversationId: CONVERSATION_ID,
          status: "active",
        }),
      ]);
    } finally {
      vi.useRealTimers();
      await disconnectStateAdapter();
      await fixture.close();
    }
  });

  it("keeps completed turn-session status over running SQL execution", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      vi.useFakeTimers({ now: 2_000 });
      await disconnectStateAdapter();
      const store = createSqlStore(fixture.sql);
      await store.migrate();
      await store.recordExecution({
        conversationId: CONVERSATION_ID,
        createdAtMs: 1_000,
        destination: inboundMessage("completed-target").destination,
        execution: {
          runId: "run-completed",
          status: "running",
          updatedAtMs: 2_000,
        },
        lastActivityAtMs: 2_000,
        updatedAtMs: 2_000,
      });
      await upsertAgentTurnSessionRecord({
        conversationStore: store,
        conversationId: CONVERSATION_ID,
        destination: inboundMessage("completed-target").destination,
        lastProgressAtMs: 1_500,
        piMessages: [],
        sessionId: "turn-completed",
        sliceId: 1,
        state: "completed",
        surface: "slack",
      });

      await expect(
        listRecentConversationSummaries({
          limit: 1,
          conversationStore: store,
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          conversationId: CONVERSATION_ID,
          status: "completed",
        }),
      ]);
    } finally {
      vi.useRealTimers();
      await disconnectStateAdapter();
      await fixture.close();
    }
  });

  it("keeps hung turn-session progress over fresh SQL check-ins", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      vi.useFakeTimers({ now: 600_000 });
      await disconnectStateAdapter();
      const store = createSqlStore(fixture.sql);
      await store.migrate();
      await store.recordExecution({
        conversationId: CONVERSATION_ID,
        createdAtMs: 1_000,
        destination: inboundMessage("hung-target").destination,
        execution: {
          runId: "run-hung",
          status: "running",
          updatedAtMs: 600_000,
        },
        lastActivityAtMs: 600_000,
        updatedAtMs: 600_000,
      });
      await upsertAgentTurnSessionRecord({
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
        readConversationFeed({ conversationStore: store }),
      ).resolves.toMatchObject({
        conversations: [
          {
            conversationId: CONVERSATION_ID,
            lastProgressAt: new Date(1_000).toISOString(),
            lastSeenAt: new Date(600_000).toISOString(),
            status: "hung",
          },
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
      await store.migrate();
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
      await store.migrate();
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
