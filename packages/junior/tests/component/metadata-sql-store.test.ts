import { describe, expect, it } from "vitest";
import { backfillToSql } from "@/chat/metadata/sql/backfill";
import { createSqlStore, SqlStore } from "@/chat/metadata/sql/store";
import { createStateConversationMetadataStore } from "@/chat/metadata/state-store";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { upsertAgentTurnSessionRecord } from "@/chat/state/turn-session";
import type { JuniorSqlMigrationExecutor } from "@/chat/sql/db";
import {
  juniorConversationInboundMessages,
  juniorConversations,
  juniorDestinations,
  juniorIdentities,
} from "@/chat/sql/schema";
import { and, eq } from "drizzle-orm";
import { listRecentConversationSummaries } from "@/reporting/conversations";
import { CONVERSATION_ID, inboundMessage } from "../fixtures/conversation-work";
import { createLocalJuniorSqlFixture } from "../fixtures/sql";

describe("conversation metadata SQL store", () => {
  it("requires explicit schema migration before store use", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      const store = createSqlStore(fixture.executor);

      await expect(
        store.markConversationWorkEnqueued({
          conversationId: CONVERSATION_ID,
          nowMs: 1_000,
        }),
      ).rejects.toThrow("junior_conversations");

      await store.migrate();
      await expect(
        store.markConversationWorkEnqueued({
          conversationId: CONVERSATION_ID,
          nowMs: 1_000,
        }),
      ).resolves.toBeUndefined();
      await expect(
        store.clearExpiredConversationLease({
          conversationId: CONVERSATION_ID,
          nowMs: 1_000,
        }),
      ).resolves.toBe(false);

      await expect(
        fixture.executor.query(
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
        db: () => fixture.executor.db(),
        execute: (statement, params) =>
          fixture.executor.execute(statement, params),
        query: <T = unknown>(statement: string, params?: readonly unknown[]) =>
          fixture.executor.query<T>(statement, params),
        transaction: (callback) => fixture.executor.transaction(callback),
        withLock: async (lockName, callback) => {
          attempts++;
          if (attempts === 1) {
            throw new Error("transient schema failure");
          }
          return await fixture.executor.withLock(lockName, callback);
        },
      };
      const store = new SqlStore(fixture.executor, migrationExecutor);

      await expect(store.migrate()).rejects.toThrow("transient schema failure");
      await expect(store.migrate()).resolves.toBeUndefined();
      expect(attempts).toBe(2);
    } finally {
      await fixture.close();
    }
  });

  it("persists runnable conversation metadata through the SQL store", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      const store = createSqlStore(fixture.executor);
      await store.migrate();

      await expect(
        store.appendInboundMessage({
          message: inboundMessage("m1"),
          nowMs: 1_000,
        }),
      ).resolves.toEqual({ status: "appended" });
      await expect(
        store.appendInboundMessage({
          message: inboundMessage("m1"),
          nowMs: 2_000,
        }),
      ).resolves.toEqual({ status: "duplicate" });

      await store.recordConversationActivity({
        conversationId: CONVERSATION_ID,
        channelName: "eng-runtime",
        title: "SQL metadata store",
        requester: {
          email: "user@example.com",
          fullName: "Runtime User",
          platform: "slack",
          slackUserId: "U123",
          slackUserName: "runtime-user",
          teamId: "T123",
        },
        source: "slack",
        nowMs: 3_000,
      });

      await expect(
        store.listConversationsByActivity({ limit: 5 }),
      ).resolves.toMatchObject([
        {
          conversationId: CONVERSATION_ID,
          channelName: "eng-runtime",
          title: "SQL metadata store",
          execution: {
            status: "pending",
            pendingCount: 1,
          },
        },
      ]);
      await expect(store.listActiveConversationIds()).resolves.toEqual([
        CONVERSATION_ID,
      ]);

      await store.markConversationWorkEnqueued({
        conversationId: CONVERSATION_ID,
        nowMs: 3_500,
      });
      const started = await store.startConversationWork({
        conversationId: CONVERSATION_ID,
        nowMs: 4_000,
      });
      expect(started.status).toBe("acquired");
      if (started.status !== "acquired") {
        return;
      }
      await expect(
        store.getConversation({ conversationId: CONVERSATION_ID }),
      ).resolves.toMatchObject({
        execution: {
          lastEnqueuedAtMs: undefined,
        },
      });
      await store.recordConversationActivity({
        conversationId: CONVERSATION_ID,
        title: "Visible activity should not refresh execution staleness",
        nowMs: 10_000,
      });
      await expect(
        store.listActiveConversationIds({ staleBeforeMs: 5_000 }),
      ).resolves.toEqual([CONVERSATION_ID]);

      await expect(
        store.checkInConversationWork({
          conversationId: CONVERSATION_ID,
          leaseToken: started.leaseToken,
          nowMs: 5_000,
        }),
      ).resolves.toBe(true);

      const injectedMessages: string[] = [];
      await expect(
        store.drainConversationMailbox({
          conversationId: CONVERSATION_ID,
          leaseToken: started.leaseToken,
          nowMs: 6_000,
          inject: async (messages) => {
            injectedMessages.push(
              ...messages.map((message) => message.input.text),
            );
          },
        }),
      ).resolves.toHaveLength(1);
      expect(injectedMessages).toEqual(["message m1"]);

      await expect(
        store.completeConversationWork({
          conversationId: CONVERSATION_ID,
          leaseToken: started.leaseToken,
          nowMs: 7_000,
        }),
      ).resolves.toBe("completed");
      await expect(store.listActiveConversationIds()).resolves.toEqual([]);

      const inboundRows = await fixture.executor
        .db()
        .select({
          destinationId: juniorConversationInboundMessages.destinationId,
          injectedAt: juniorConversationInboundMessages.injectedAt,
          input: juniorConversationInboundMessages.input,
        })
        .from(juniorConversationInboundMessages)
        .where(
          and(
            eq(
              juniorConversationInboundMessages.conversationId,
              CONVERSATION_ID,
            ),
            eq(juniorConversationInboundMessages.inboundMessageId, "m1"),
          ),
        );
      expect(inboundRows).toMatchObject([{ input: null }]);
      expect(inboundRows[0]?.injectedAt).not.toBeNull();

      const linkedRows = await fixture.executor
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
          destinationId: inboundRows[0]?.destinationId,
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

  it("backfills state-backed conversation metadata into SQL", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await disconnectStateAdapter();
      const state = getStateAdapter();
      const source = createStateConversationMetadataStore(state);
      await source.appendInboundMessage({
        message: inboundMessage("backfill"),
        nowMs: 1_000,
      });
      const started = await source.startConversationWork({
        conversationId: CONVERSATION_ID,
        nowMs: 1_500,
      });
      expect(started.status).toBe("acquired");
      if (started.status !== "acquired") {
        return;
      }
      await source.drainConversationMailbox({
        conversationId: CONVERSATION_ID,
        leaseToken: started.leaseToken,
        nowMs: 1_750,
        inject: async () => {},
      });
      await source.completeConversationWork({
        conversationId: CONVERSATION_ID,
        leaseToken: started.leaseToken,
        nowMs: 1_900,
      });
      await source.recordConversationActivity({
        conversationId: CONVERSATION_ID,
        channelName: "eng-runtime",
        title: "Backfilled metadata",
        nowMs: 2_000,
      });

      const target = createSqlStore(fixture.executor);
      const result = await backfillToSql({
        source,
        target,
        limit: 10,
      });

      expect(result).toEqual({ copiedCount: 1, hasMore: false });
      await expect(
        target.getConversationWorkState({ conversationId: CONVERSATION_ID }),
      ).resolves.toMatchObject({
        conversationId: CONVERSATION_ID,
        channelName: "eng-runtime",
        title: "Backfilled metadata",
        execution: {
          status: "idle",
          pendingCount: 0,
        },
      });
      await expect(
        target.appendInboundMessage({
          message: inboundMessage("backfill"),
          nowMs: 3_000,
        }),
      ).resolves.toEqual({ status: "duplicate" });
    } finally {
      await disconnectStateAdapter();
      await fixture.close();
    }
  });

  it("links local conversations to local destinations and system actors", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      const store = createSqlStore(fixture.executor);
      await store.migrate();
      await store.recordConversationActivity({
        conversationId: "local:workspace:run-123",
        destination: {
          platform: "local",
          conversationId: "local:workspace:run-123",
        },
        nowMs: 1_000,
        source: "local",
        title: "Local run",
      });

      const rows = await fixture.executor
        .db()
        .select({
          actorKind: juniorIdentities.kind,
          actorProvider: juniorIdentities.provider,
          actorSubject: juniorIdentities.providerSubjectId,
          destinationKind: juniorDestinations.kind,
          destinationProvider: juniorDestinations.provider,
          destinationSubject: juniorDestinations.providerDestinationId,
          destinationTenant: juniorDestinations.providerTenantId,
          source: juniorConversations.source,
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
        .where(
          eq(juniorConversations.conversationId, "local:workspace:run-123"),
        );

      expect(rows).toEqual([
        {
          actorKind: "system",
          actorProvider: "junior",
          actorSubject: "local-cli",
          destinationKind: "local_conversation",
          destinationProvider: "local",
          destinationSubject: "local:workspace:run-123",
          destinationTenant: "workspace",
          source: "local",
        },
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("refreshes existing SQL execution state during backfill", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await disconnectStateAdapter();
      const state = getStateAdapter();
      const source = createStateConversationMetadataStore(state);
      await source.appendInboundMessage({
        message: inboundMessage("backfill-existing"),
        nowMs: 1_000,
      });
      await source.recordConversationActivity({
        conversationId: CONVERSATION_ID,
        channelName: "state-channel",
        title: "Stale state metadata",
        nowMs: 1_500,
      });

      const target = createSqlStore(fixture.executor);
      await target.migrate();
      await target.requestConversationWork({
        conversationId: CONVERSATION_ID,
        destination: inboundMessage("target").destination,
        nowMs: 500,
      });
      await target.recordConversationActivity({
        conversationId: CONVERSATION_ID,
        channelName: "sql-channel",
        title: "Current SQL metadata",
        nowMs: 600,
      });
      const started = await target.startConversationWork({
        conversationId: CONVERSATION_ID,
        nowMs: 700,
      });
      expect(started.status).toBe("acquired");
      if (started.status !== "acquired") {
        return;
      }

      const result = await backfillToSql({
        source,
        target,
        limit: 10,
      });

      expect(result).toEqual({ copiedCount: 1, hasMore: false });
      await expect(
        target.getConversationWorkState({ conversationId: CONVERSATION_ID }),
      ).resolves.toMatchObject({
        channelName: "sql-channel",
        title: "Current SQL metadata",
        execution: {
          status: "pending",
          pendingCount: 1,
        },
        messages: [
          expect.objectContaining({
            inboundMessageId:
              inboundMessage("backfill-existing").inboundMessageId,
          }),
        ],
      });
      await expect(
        target.appendInboundMessage({
          message: inboundMessage("backfill-existing"),
          nowMs: 7_000,
        }),
      ).resolves.toEqual({ status: "duplicate" });
    } finally {
      await disconnectStateAdapter();
      await fixture.close();
    }
  });

  it("preserves newer SQL execution state during backfill", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await disconnectStateAdapter();
      const state = getStateAdapter();
      const source = createStateConversationMetadataStore(state);
      await source.appendInboundMessage({
        message: inboundMessage("backfill-stale"),
        nowMs: 1_000,
      });
      await source.recordConversationActivity({
        conversationId: CONVERSATION_ID,
        channelName: "state-channel",
        title: "Stale state metadata",
        nowMs: 1_500,
      });

      const target = createSqlStore(fixture.executor);
      await target.migrate();
      await target.requestConversationWork({
        conversationId: CONVERSATION_ID,
        destination: inboundMessage("target").destination,
        nowMs: 5_000,
      });
      await target.recordConversationActivity({
        conversationId: CONVERSATION_ID,
        channelName: "sql-channel",
        title: "Current SQL metadata",
        nowMs: 6_000,
      });
      const started = await target.startConversationWork({
        conversationId: CONVERSATION_ID,
        nowMs: 6_500,
      });
      expect(started.status).toBe("acquired");
      if (started.status !== "acquired") {
        return;
      }

      const result = await backfillToSql({
        source,
        target,
        limit: 10,
      });

      expect(result).toEqual({ copiedCount: 1, hasMore: false });
      await expect(
        target.getConversationWorkState({ conversationId: CONVERSATION_ID }),
      ).resolves.toMatchObject({
        channelName: "sql-channel",
        title: "Current SQL metadata",
        execution: {
          lease: {
            token: started.leaseToken,
          },
          pendingCount: 0,
          status: "running",
        },
        messages: [],
      });
    } finally {
      await disconnectStateAdapter();
      await fixture.close();
    }
  });

  it("preserves newer activity timestamp during older inbound upsert", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      const store = createSqlStore(fixture.executor);
      await store.migrate();
      await store.requestConversationWork({
        conversationId: CONVERSATION_ID,
        destination: inboundMessage("activity-target").destination,
        nowMs: 1_000,
      });
      await store.recordConversationActivity({
        conversationId: CONVERSATION_ID,
        nowMs: 5_000,
      });

      await store.appendInboundMessage({
        message: inboundMessage("older-activity"),
        nowMs: 2_000,
      });

      await expect(
        store.getConversationWorkState({ conversationId: CONVERSATION_ID }),
      ).resolves.toMatchObject({
        lastActivityAtMs: 5_000,
        messages: [
          expect.objectContaining({
            inboundMessageId: "older-activity",
          }),
        ],
      });
    } finally {
      await fixture.close();
    }
  });

  it("uses turn-session status for plugin metadata summaries", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await disconnectStateAdapter();
      const store = createSqlStore(fixture.executor);
      await store.migrate();
      await store.requestConversationWork({
        conversationId: CONVERSATION_ID,
        destination: inboundMessage("summary-target").destination,
        nowMs: 1_000,
      });
      const started = await store.startConversationWork({
        conversationId: CONVERSATION_ID,
        nowMs: 1_100,
      });
      expect(started.status).toBe("acquired");
      if (started.status !== "acquired") {
        return;
      }
      await store.completeConversationWork({
        conversationId: CONVERSATION_ID,
        leaseToken: started.leaseToken,
        nowMs: 1_200,
      });
      await upsertAgentTurnSessionRecord({
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
          metadataStore: store,
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
});
