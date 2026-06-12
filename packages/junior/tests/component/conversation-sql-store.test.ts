import { describe, expect, it } from "vitest";
import { backfillToSql } from "@/chat/conversations/sql/backfill";
import { createSqlStore, SqlStore } from "@/chat/conversations/sql/store";
import { createStateConversationStore } from "@/chat/conversations/state";
import { appendInboundMessage } from "@/chat/task-execution/store";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { upsertAgentTurnSessionRecord } from "@/chat/state/turn-session";
import type { JuniorSqlMigrationExecutor } from "@/chat/sql/db";
import {
  juniorConversations,
  juniorDestinations,
  juniorIdentities,
} from "@/chat/sql/schema";
import { eq } from "drizzle-orm";
import { listRecentConversationSummaries } from "@/reporting/conversations";
import { CONVERSATION_ID, inboundMessage } from "../fixtures/conversation-work";
import { createLocalJuniorSqlFixture } from "../fixtures/sql";

describe("conversation SQL store", () => {
  it("requires explicit schema migration before store use", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      const store = createSqlStore(fixture.executor);

      await expect(
        store.recordConversationActivity({
          conversationId: CONVERSATION_ID,
          nowMs: 1_000,
        }),
      ).rejects.toThrow("junior_conversations");

      await store.migrate();
      await expect(
        store.recordConversationActivity({
          conversationId: CONVERSATION_ID,
          nowMs: 1_000,
        }),
      ).resolves.toBeUndefined();

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

  it("persists queryable conversation records and linked identities", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      const store = createSqlStore(fixture.executor);
      await store.migrate();

      await store.recordConversationActivity({
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

      const conversations = await store.listConversationsByActivity({
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
      const store = createSqlStore(fixture.executor);
      await store.migrate();
      await fixture.executor.execute(
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
        store.getConversation({ conversationId: "slack:C123:invalid-json" }),
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
      await source.recordConversationActivity({
        conversationId: CONVERSATION_ID,
        channelName: "eng-runtime",
        title: "Backfilled conversation",
        nowMs: 2_000,
      });

      const target = createSqlStore(fixture.executor);
      const result = await backfillToSql({
        source,
        target,
        limit: 10,
      });

      expect(result).toEqual({ copiedCount: 1, hasMore: false });
      const conversation = await target.getConversation({
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

  it("uses turn-session status for plugin conversation summaries", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await disconnectStateAdapter();
      const store = createSqlStore(fixture.executor);
      await store.migrate();
      await store.recordConversationActivity({
        conversationId: CONVERSATION_ID,
        destination: inboundMessage("summary-target").destination,
        nowMs: 1_000,
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
});
