import { describe, expect, it, vi } from "vitest";
import { backfillToSql } from "@/chat/conversations/sql/backfill";
import { createSqlStore, SqlStore } from "@/chat/conversations/sql/store";
import { createStateConversationStore } from "@/chat/conversations/state";
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
      ).resolves.toHaveLength(1);
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
          await context.drainMailbox(async () => {});
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
        inject: async () => {},
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
