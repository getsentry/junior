import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readConversationDetail } from "@/api/conversations/detail";
import { createSqlConversationEventStore } from "@/chat/conversations/sql/history";
import { createSqlConversationMessageStore } from "@/chat/conversations/sql/messages";
import { purgeConversation } from "@/chat/conversations/retention";
import type { PiMessage } from "@/chat/pi/messages";
import { createPostgresJuniorSqlExecutor } from "@/db/postgres";
import {
  juniorConversationEvents,
  juniorConversationMessages,
  juniorConversations,
  juniorDestinations,
} from "@/db/schema";

const ORIGINAL_ENV = { ...process.env };
const TEST_DATABASE_URL = ORIGINAL_ENV.DATABASE_URL;

if (!TEST_DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is required for dashboard reporting integration tests",
  );
}

async function recordRoot(
  conversationId: string,
  visibility: "private" | "public",
): Promise<void> {
  const { getConversationStore } = await import("@/chat/db");
  await getConversationStore().recordActivity({
    conversationId,
    destination: {
      platform: "slack",
      teamId: "T-reporting",
      channelId: `C-${conversationId}`,
    },
    nowMs: 1,
    source: "slack",
    title: "Canonical event report",
    visibility,
  });
}

async function appendVisibleHistory(
  conversationId: string,
  text = "Visible answer",
): Promise<void> {
  const { getConversationEventStore } = await import("@/chat/db");
  await getConversationEventStore().append(conversationId, [
    {
      data: {
        type: "visible_message_recorded",
        messageId: `${conversationId}:visible`,
        role: "assistant",
        text,
      },
      createdAtMs: 10,
    },
    {
      data: {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "private model-only duplicate" }],
          timestamp: 11,
        } as PiMessage,
      },
      createdAtMs: 11,
    },
    {
      data: {
        type: "tool_execution_started",
        toolCallId: `${conversationId}:tool-call`,
        toolName: "search",
        args: { secret: "must not leave persistence" },
      },
      createdAtMs: 12,
    },
    {
      data: {
        type: "turn_started",
        turnId: `${conversationId}:turn`,
        inputMessageIds: [`${conversationId}:visible`],
        surface: "internal",
      },
      createdAtMs: 13,
    },
    {
      data: {
        type: "turn_completed",
        turnId: `${conversationId}:turn`,
        outcome: "success",
      },
      createdAtMs: 14,
    },
    {
      data: {
        type: "delivery_intended",
        deliveryId: `${conversationId.replaceAll(":", "_")}_delivery`,
        correlation: { kind: "turn", turnId: `${conversationId}:turn` },
        messageId: `${conversationId}:visible`,
        deliveryKind: "assistant_reply",
        provider: "slack",
        partCount: 1,
      },
      createdAtMs: 15,
    },
    {
      data: {
        type: "delivery_accepted",
        deliveryId: `${conversationId.replaceAll(":", "_")}_delivery`,
        providerMessageIds: ["123.456"],
      },
      createdAtMs: 16,
    },
    {
      data: {
        type: "subagent_started",
        subagentInvocationId: `${conversationId}:subagent-call`,
        subagentKind: "review",
        childConversationId: `${conversationId}:child`,
        historyMode: "isolated",
      },
      createdAtMs: 17,
    },
    {
      data: {
        type: "subagent_ended",
        subagentInvocationId: `${conversationId}:subagent-call`,
        outcome: "success",
      },
      createdAtMs: 18,
    },
  ]);
  await getConversationEventStore().startEpoch(conversationId, {
    reason: "compaction",
    modelProfile: "standard",
    modelId: "private-model-id",
    messages: [],
  });
  await getConversationEventStore().startEpoch(conversationId, {
    reason: "handoff",
    modelProfile: "fast",
    modelId: "private-handoff-model-id",
    messages: [],
  });
}

async function createChild(args: {
  childConversationId: string;
  parentConversationId: string;
}): Promise<void> {
  const { getConversationEventStore, getSubagentLineageService } =
    await import("@/chat/db");
  await getConversationEventStore().append(args.parentConversationId, [
    {
      data: {
        type: "turn_started",
        turnId: `${args.parentConversationId}:turn`,
        inputMessageIds: [`${args.parentConversationId}:input`],
        surface: "internal",
      },
      createdAtMs: 2,
    },
  ]);
  await getSubagentLineageService().start({
    childConversationId: args.childConversationId,
    historyMode: "isolated",
    parentConversationId: args.parentConversationId,
    parentTurnId: `${args.parentConversationId}:turn`,
    subagentInvocationId: `${args.childConversationId}:call`,
    subagentKind: "task",
    nowMs: 3,
  });
  await appendVisibleHistory(args.childConversationId, "Child answer");
}

async function requireDetail(conversationId: string) {
  const detail = await readConversationDetail(conversationId);
  if (!detail) throw new Error(`Missing detail for ${conversationId}`);
  return detail;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitUntilWaitingOnEventTable(
  observer: ReturnType<typeof createPostgresJuniorSqlExecutor>,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const [row] = await observer.query<{ count: number }>(`
      select count(*)::integer as count
      from pg_stat_activity
      where datname = current_database()
        and pid <> pg_backend_pid()
        and wait_event_type = 'Lock'
        and query ilike '%junior_conversation_events%'
    `);
    if ((row?.count ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Detail read did not block while loading event history");
}

async function waitUntilApplicationWaitsOnLock(
  observer: ReturnType<typeof createPostgresJuniorSqlExecutor>,
  applicationName: string,
  queryFragment: string,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const [row] = await observer.query<{ count: number }>(
      `
        select count(*)::integer as count
        from pg_stat_activity
        where datname = current_database()
          and pid <> pg_backend_pid()
          and wait_event_type = 'Lock'
          and query ilike $1
      `,
      [`%${queryFragment}%`],
    );
    if ((row?.count ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${applicationName} did not reach the expected lock wait`);
}

describe("dashboard canonical event reporting", () => {
  beforeEach(async () => {
    process.env = {
      ...ORIGINAL_ENV,
      DATABASE_URL: TEST_DATABASE_URL,
      JUNIOR_STATE_ADAPTER: "memory",
    };
    vi.resetModules();
  });

  afterEach(async () => {
    const { disconnectStateAdapter } = await import("@/chat/state/adapter");
    const { closeDb } = await import("@/chat/db");
    await closeDb();
    await disconnectStateAdapter();
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
  });

  it("returns one ordered safe event log without legacy detail projections", async () => {
    const conversationId = "slack:C-reporting:canonical-detail";
    await recordRoot(conversationId, "public");
    await appendVisibleHistory(conversationId);

    const detail = await requireDetail(conversationId);

    expect(detail.eventHistory).toEqual({ status: "available" });
    expect(detail.events.map((event) => event.data)).toEqual([
      {
        type: "visible_message",
        messageId: `${conversationId}:visible`,
        role: "assistant",
        text: "Visible answer",
      },
      { type: "tool_started", name: "search" },
      {
        type: "turn_lifecycle",
        turnId: `${conversationId}:turn`,
        state: "started",
      },
      {
        type: "turn_lifecycle",
        turnId: `${conversationId}:turn`,
        state: "succeeded",
      },
      {
        type: "delivery",
        deliveryId: `${conversationId.replaceAll(":", "_")}_delivery`,
        state: "intended",
      },
      {
        type: "delivery",
        deliveryId: `${conversationId.replaceAll(":", "_")}_delivery`,
        state: "accepted",
      },
      {
        type: "subagent_started",
        childConversationId: `${conversationId}:child`,
        subagentKind: "review",
        historyMode: "isolated",
      },
      {
        type: "subagent_ended",
        childConversationId: `${conversationId}:child`,
        subagentKind: "review",
        historyMode: "isolated",
        outcome: "success",
      },
      { type: "context_compacted" },
      { type: "model_handoff" },
    ]);
    const eventSeqs = detail.events.map((event) => event.seq);
    expect(eventSeqs).toEqual(eventSeqs.slice().sort((a, b) => a - b));
    expect(JSON.stringify(detail)).not.toContain(
      "private model-only duplicate",
    );
    expect(JSON.stringify(detail)).not.toContain("must not leave persistence");
    expect(JSON.stringify(detail)).not.toContain("private-model-id");
    for (const removed of [
      "activity",
      "contextEvents",
      "modelId",
      "reasoningLevel",
      "transcript",
      "transcriptAvailable",
      "transcriptMetadata",
      "transcriptMessageCount",
    ]) {
      expect(detail).not.toHaveProperty(removed);
    }
  });

  it("redacts visible content for a private root while retaining structure", async () => {
    const conversationId = "slack:C-reporting:private-detail";
    await recordRoot(conversationId, "private");
    await appendVisibleHistory(conversationId);

    const detail = await requireDetail(conversationId);

    expect(detail.eventHistory).toEqual({
      status: "redacted",
      reason: "non_public_conversation",
    });
    expect(detail.events[0]?.data).toEqual({
      type: "visible_message",
      messageId: `${conversationId}:visible`,
      role: "assistant",
      redacted: true,
    });
    expect(detail.events[1]?.data).toEqual({
      type: "tool_started",
      name: "search",
    });
    expect(JSON.stringify(detail)).not.toContain("Visible answer");
  });

  it("authorizes children from their persisted root and rejects forged or malformed lineage", async () => {
    const publicRoot = "slack:C-reporting:public-root";
    const publicChild = "child:reporting-public";
    await recordRoot(publicRoot, "public");
    await createChild({
      childConversationId: publicChild,
      parentConversationId: publicRoot,
    });
    expect((await requireDetail(publicChild)).eventHistory).toEqual({
      status: "available",
    });
    const { getConversationStore, getDb } = await import("@/chat/db");
    const [rootRow] = await getDb()
      .select({ destinationId: juniorConversations.destinationId })
      .from(juniorConversations)
      .where(eq(juniorConversations.conversationId, publicRoot));
    if (!rootRow?.destinationId) throw new Error("Missing root destination");
    await getDb()
      .update(juniorDestinations)
      .set({ visibility: "private" })
      .where(eq(juniorDestinations.id, rootRow.destinationId));
    expect((await requireDetail(publicChild)).eventHistory.status).toBe(
      "redacted",
    );
    await getDb()
      .update(juniorDestinations)
      .set({ visibility: "public" })
      .where(eq(juniorDestinations.id, rootRow.destinationId));
    expect((await requireDetail(publicChild)).eventHistory.status).toBe(
      "available",
    );

    const privateRoot = "slack:C-reporting:private-root";
    const privateChild = "child:reporting-private";
    await recordRoot(privateRoot, "private");
    await createChild({
      childConversationId: privateChild,
      parentConversationId: privateRoot,
    });
    await getConversationStore().recordActivity({
      conversationId: privateChild,
      channelName: "forged-public-child-channel",
      destination: {
        platform: "slack",
        teamId: "T-reporting",
        channelId: "C-forged-child",
      },
      title: "Forged public child title",
      visibility: "public",
    });
    const privateChildDetail = await requireDetail(privateChild);
    expect(privateChildDetail.eventHistory.status).toBe("redacted");
    expect(JSON.stringify(privateChildDetail)).not.toContain(
      "Forged public child title",
    );
    expect(JSON.stringify(privateChildDetail)).not.toContain(
      "forged-public-child-channel",
    );

    const forgedRoot = "slack:C-reporting:forged-root";
    await recordRoot(forgedRoot, "public");
    await getDb()
      .update(juniorConversations)
      .set({ rootConversationId: forgedRoot })
      .where(eq(juniorConversations.conversationId, publicChild));
    expect((await requireDetail(publicChild)).eventHistory.status).toBe(
      "redacted",
    );
  });

  it("lets requested-row expiry win and stamps both root and child purges", async () => {
    const rootConversationId = "slack:C-reporting:purged-root";
    const childConversationId = "child:reporting-purged";
    await recordRoot(rootConversationId, "public");
    await createChild({
      childConversationId,
      parentConversationId: rootConversationId,
    });
    const { getSqlExecutor } = await import("@/chat/db");

    await purgeConversation(getSqlExecutor(), rootConversationId, {
      nowMs: 50,
    });

    for (const conversationId of [rootConversationId, childConversationId]) {
      const detail = await requireDetail(conversationId);
      expect(detail.eventHistory).toEqual({
        status: "expired",
        expiredAt: new Date(50).toISOString(),
      });
      expect(detail.events).toEqual([]);
    }
  });

  it("linearizes detail reads before concurrent appends, privacy flips, and purges", async () => {
    const rootConversationId = "slack:C-reporting:concurrent-detail";
    const childConversationId = "child:reporting-concurrent-detail";
    await recordRoot(rootConversationId, "public");
    await createChild({
      childConversationId,
      parentConversationId: rootConversationId,
    });

    const blocker = createPostgresJuniorSqlExecutor({
      applicationName: "junior-reporting-table-blocker",
      connectionString: TEST_DATABASE_URL,
    });
    const observer = createPostgresJuniorSqlExecutor({
      applicationName: "junior-reporting-lock-observer",
      connectionString: TEST_DATABASE_URL,
    });
    const mutator = createPostgresJuniorSqlExecutor({
      applicationName: "junior-reporting-mutator",
      connectionString: TEST_DATABASE_URL,
    });
    const appender = createPostgresJuniorSqlExecutor({
      applicationName: "junior-reporting-appender",
      connectionString: TEST_DATABASE_URL,
    });
    const purger = createPostgresJuniorSqlExecutor({
      applicationName: "junior-reporting-purger",
      connectionString: TEST_DATABASE_URL,
    });
    const tableLocked = deferred();
    const releaseTable = deferred();
    const blockerDone = blocker.transaction(async () => {
      await blocker.execute(
        "LOCK TABLE junior_conversation_events IN ACCESS EXCLUSIVE MODE",
      );
      tableLocked.resolve();
      await releaseTable.promise;
    });

    try {
      await tableLocked.promise;
      const completionOrder: string[] = [];
      const detailPromise = requireDetail(childConversationId).then(
        (detail) => {
          completionOrder.push("read");
          return detail;
        },
      );
      await waitUntilWaitingOnEventTable(observer);

      const [rootRow] = await observer
        .db()
        .select({ destinationId: juniorConversations.destinationId })
        .from(juniorConversations)
        .where(eq(juniorConversations.conversationId, rootConversationId));
      if (!rootRow?.destinationId) throw new Error("Missing destination");

      const flipPromise = mutator
        .db()
        .update(juniorDestinations)
        .set({ visibility: "private" })
        .where(eq(juniorDestinations.id, rootRow.destinationId))
        .then(() => {
          completionOrder.push("privacy-flip");
        });
      const appendPromise = createSqlConversationEventStore(appender)
        .append(childConversationId, [
          {
            data: {
              type: "visible_message_recorded",
              messageId: `${childConversationId}:late-visible`,
              role: "assistant",
              text: "Late private payload",
            },
            createdAtMs: 100,
          },
        ])
        .then(() => {
          completionOrder.push("append");
        });
      const purgePromise = purgeConversation(purger, rootConversationId, {
        nowMs: 200,
      }).then(() => {
        completionOrder.push("purge");
      });

      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(completionOrder).toEqual([]);

      releaseTable.resolve();
      await blockerDone;
      const [detail] = await Promise.all([
        detailPromise,
        flipPromise,
        appendPromise,
        purgePromise,
      ]);

      expect(completionOrder[0]).toBe("read");
      expect(detail.eventHistory).toEqual({ status: "available" });
      expect(JSON.stringify(detail)).toContain("Child answer");

      const finalDetail = await requireDetail(childConversationId);
      expect(["expired", "redacted"]).toContain(
        finalDetail.eventHistory.status,
      );
      expect(JSON.stringify(finalDetail)).not.toContain("Late private payload");
    } finally {
      releaseTable.resolve();
      await blockerDone.catch(() => undefined);
      await Promise.all([
        blocker.close(),
        observer.close(),
        mutator.close(),
        appender.close(),
        purger.close(),
      ]);
    }
  }, 15_000);

  it("deletes physical child event and message rows when an append wins before tree purge", async () => {
    const rootConversationId = "slack:C-reporting:append-purge-root";
    const childConversationId = "child:reporting-append-purge";
    await recordRoot(rootConversationId, "public");
    await createChild({
      childConversationId,
      parentConversationId: rootConversationId,
    });

    const blocker = createPostgresJuniorSqlExecutor({
      applicationName: "junior-append-purge-table-blocker",
      connectionString: TEST_DATABASE_URL,
    });
    const observer = createPostgresJuniorSqlExecutor({
      applicationName: "junior-append-purge-observer",
      connectionString: TEST_DATABASE_URL,
    });
    const writer = createPostgresJuniorSqlExecutor({
      applicationName: "junior-append-purge-writer",
      connectionString: TEST_DATABASE_URL,
    });
    const purger = createPostgresJuniorSqlExecutor({
      applicationName: "junior-append-purge-purger",
      connectionString: TEST_DATABASE_URL,
    });
    const tablesLocked = deferred();
    const releaseTables = deferred();
    const blockerDone = blocker.transaction(async () => {
      await blocker.execute(
        "LOCK TABLE junior_conversation_events, junior_conversation_messages IN ACCESS EXCLUSIVE MODE",
      );
      tablesLocked.resolve();
      await releaseTables.promise;
    });

    try {
      await tablesLocked.promise;
      const completionOrder: string[] = [];
      const writerPromise = createSqlConversationMessageStore(writer)
        .record(childConversationId, [
          {
            messageId: "concurrent-child-message",
            role: "assistant",
            text: "concurrent physical child payload",
            createdAtMs: Date.now(),
          },
        ])
        .then(() => completionOrder.push("writer"));
      await waitUntilApplicationWaitsOnLock(
        observer,
        "junior-append-purge-writer",
        "junior_conversation_messages",
      );

      const purgePromise = purgeConversation(purger, rootConversationId, {
        nowMs: Date.now(),
      }).then(() => completionOrder.push("purge"));
      await waitUntilApplicationWaitsOnLock(
        observer,
        "junior-append-purge-purger",
        "pg_advisory_xact_lock",
      );
      expect(completionOrder).toEqual([]);

      releaseTables.resolve();
      await blockerDone;
      await Promise.all([writerPromise, purgePromise]);
      expect(completionOrder).toEqual(["writer", "purge"]);

      for (const conversationId of [rootConversationId, childConversationId]) {
        const events = await observer
          .db()
          .select()
          .from(juniorConversationEvents)
          .where(eq(juniorConversationEvents.conversationId, conversationId));
        const messages = await observer
          .db()
          .select()
          .from(juniorConversationMessages)
          .where(eq(juniorConversationMessages.conversationId, conversationId));
        expect(events).toEqual([]);
        expect(messages).toEqual([]);
      }
    } finally {
      releaseTables.resolve();
      await blockerDone.catch(() => undefined);
      await Promise.all([
        blocker.close(),
        observer.close(),
        writer.close(),
        purger.close(),
      ]);
    }
  }, 15_000);

  it("rediscovers a child attached while known descendants are being locked", async () => {
    const rootConversationId = "slack:C-reporting:membership-race-root";
    const firstChildId = "child:a-reporting-membership-race";
    const secondChildId = "child:z-reporting-membership-race";
    const lateGrandchildId = "child:late-reporting-membership-race";
    await recordRoot(rootConversationId, "public");
    await createChild({
      childConversationId: firstChildId,
      parentConversationId: rootConversationId,
    });
    await createChild({
      childConversationId: secondChildId,
      parentConversationId: rootConversationId,
    });

    const blocker = createPostgresJuniorSqlExecutor({
      applicationName: "junior-membership-race-blocker",
      connectionString: TEST_DATABASE_URL,
    });
    const observer = createPostgresJuniorSqlExecutor({
      applicationName: "junior-membership-race-observer",
      connectionString: TEST_DATABASE_URL,
    });
    const creator = createPostgresJuniorSqlExecutor({
      applicationName: "junior-membership-race-creator",
      connectionString: TEST_DATABASE_URL,
    });
    const purger = createPostgresJuniorSqlExecutor({
      applicationName: "junior-membership-race-purger",
      connectionString: TEST_DATABASE_URL,
    });
    const childLocked = deferred();
    const releaseChild = deferred();
    const blockerDone = blocker.transaction(async () => {
      await blocker
        .db()
        .select()
        .from(juniorConversations)
        .where(eq(juniorConversations.conversationId, firstChildId))
        .for("update");
      childLocked.resolve();
      await releaseChild.promise;
    });

    try {
      await childLocked.promise;
      const purgePromise = purgeConversation(purger, rootConversationId, {
        nowMs: Date.now(),
      });
      await waitUntilApplicationWaitsOnLock(
        observer,
        "junior-membership-race-purger",
        "junior_conversations",
      );

      const now = new Date();
      await creator.db().insert(juniorConversations).values({
        conversationId: lateGrandchildId,
        parentConversationId: secondChildId,
        createdAt: now,
        lastActivityAt: now,
        updatedAt: now,
        executionStatus: "idle",
      });
      await createSqlConversationMessageStore(creator).record(
        lateGrandchildId,
        [
          {
            messageId: "late-grandchild-message",
            role: "assistant",
            text: "late grandchild payload",
            createdAtMs: now.getTime(),
          },
        ],
      );

      releaseChild.resolve();
      await blockerDone;
      await purgePromise;

      const events = await observer
        .db()
        .select()
        .from(juniorConversationEvents)
        .where(eq(juniorConversationEvents.conversationId, lateGrandchildId));
      const messages = await observer
        .db()
        .select()
        .from(juniorConversationMessages)
        .where(eq(juniorConversationMessages.conversationId, lateGrandchildId));
      const [conversation] = await observer
        .db()
        .select({ transcriptPurgedAt: juniorConversations.transcriptPurgedAt })
        .from(juniorConversations)
        .where(eq(juniorConversations.conversationId, lateGrandchildId));
      expect(events).toEqual([]);
      expect(messages).toEqual([]);
      expect(conversation?.transcriptPurgedAt).toBeInstanceOf(Date);
    } finally {
      releaseChild.resolve();
      await blockerDone.catch(() => undefined);
      await Promise.all([
        blocker.close(),
        observer.close(),
        creator.close(),
        purger.close(),
      ]);
    }
  }, 15_000);
});
