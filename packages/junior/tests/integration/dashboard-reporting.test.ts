import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readConversationDetail } from "@/api/conversations/detail";
import { readConversationEventPrivacySnapshot } from "@/chat/conversations/sql/privacy";
import { createSqlConversationEventStore } from "@/chat/conversations/sql/history";
import { purgeConversation } from "@/chat/conversations/retention";
import type { PiMessage } from "@/chat/pi/messages";
import { createPostgresJuniorSqlExecutor } from "@/db/postgres";
import {
  juniorConversationEvents,
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
  const modelMessage = {
    role: "assistant",
    content: [{ type: "text", text: "private model-only duplicate" }],
    api: "responses",
    provider: "openai",
    model: "gpt-5",
    stopReason: "stop",
    timestamp: 11,
    usage: {
      input: 10,
      output: 2,
      cacheRead: 3,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  } as PiMessage;
  await getConversationEventStore().append(conversationId, [
    {
      data: {
        type: "message",
        messageId: `${conversationId}:visible`,
        role: "assistant",
        text,
      },
      createdAtMs: 10,
    },
    {
      data: {
        type: "agent_step",
        message: modelMessage,
      },
      createdAtMs: 11,
    },
    {
      data: {
        type: "tool_execution_started",
        toolCallId: `${conversationId}:tool-call`,
        toolName: "search",
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
        type: "subagent_started",
        subagentInvocationId: `${conversationId}:subagent-call`,
        subagentKind: "review",
        childConversationId: `${conversationId}:child`,
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
  await getConversationEventStore().replaceHistory(conversationId, {
    createdAtMs: 15,
    data: {
      type: "compaction",
      modelProfile: "standard",
      modelId: "private-model-id",
      replacementHistory: [{ message: modelMessage }],
    },
  });
  await getConversationEventStore().replaceHistory(conversationId, {
    createdAtMs: 16,
    data: {
      type: "handoff",
      modelProfile: "fast",
      modelId: "private-handoff-model-id",
      triggeringToolCallId: `${conversationId}:handoff-tool-call`,
      replacementHistory: [],
    },
  });
}

async function createChild(args: {
  childConversationId: string;
  parentConversationId: string;
}): Promise<void> {
  const { getConversationEventStore, getDb } = await import("@/chat/db");
  const at = new Date(3);
  await getDb().insert(juniorConversations).values({
    conversationId: args.childConversationId,
    parentConversationId: args.parentConversationId,
    createdAt: at,
    lastActivityAt: at,
    updatedAt: at,
    executionStatus: "idle",
  });
  await getConversationEventStore().append(args.parentConversationId, [
    {
      data: {
        type: "subagent_started",
        childConversationId: args.childConversationId,
        subagentInvocationId: `${args.childConversationId}:call`,
        subagentKind: "advisor",
      },
      createdAtMs: 2,
    },
    {
      data: {
        type: "subagent_ended",
        subagentInvocationId: `${args.childConversationId}:call`,
        outcome: "success",
      },
      createdAtMs: 3,
    },
  ]);
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
    expect(detail.displayTitle).toBe("Canonical event report");
    expect(detail.modelUsage).toEqual([
      {
        modelId: "openai/gpt-5",
        usage: expect.objectContaining({
          inputTokens: 10,
          outputTokens: 2,
          cachedInputTokens: 3,
        }),
      },
    ]);
    expect(detail.events.map((event) => event.data)).toEqual([
      {
        type: "message",
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
        type: "subagent_started",
        childConversationId: `${conversationId}:child`,
        subagentKind: "review",
      },
      {
        type: "subagent_ended",
        startedSeq: 5,
        outcome: "success",
      },
      { type: "compaction" },
      { type: "handoff" },
    ]);
    const eventSeqs = detail.events.map((event) => event.seq);
    expect(eventSeqs).toEqual(eventSeqs.slice().sort((a, b) => a - b));
    expect(JSON.stringify(detail)).not.toContain(
      "private model-only duplicate",
    );
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

  it("aggregates original model calls without counting replayed history", async () => {
    const conversationId = "slack:C-reporting:model-usage";
    await recordRoot(conversationId, "public");
    const componentUsageMessage = {
      role: "assistant",
      provider: "openai",
      model: "gpt-5",
      usage: { input: 10 },
    };
    const totalOnlyUsageMessage = {
      role: "assistant",
      provider: "openai",
      model: "gpt-5",
      usage: { totalTokens: 7 },
    };
    const { getConversationEventStore } = await import("@/chat/db");
    await getConversationEventStore().append(conversationId, [
      {
        data: { type: "agent_step", message: componentUsageMessage },
        createdAtMs: 10,
      },
      {
        data: { type: "agent_step", message: totalOnlyUsageMessage },
        createdAtMs: 11,
      },
    ]);
    await getConversationEventStore().replaceHistory(conversationId, {
      createdAtMs: 1_000,
      data: {
        type: "compaction",
        modelProfile: "standard",
        modelId: "openai/gpt-5",
        replacementHistory: [
          { message: componentUsageMessage },
          { message: totalOnlyUsageMessage },
        ],
      },
    });

    expect((await requireDetail(conversationId)).modelUsage).toEqual([
      {
        modelId: "openai/gpt-5",
        usage: { inputTokens: 10, totalTokens: 17 },
      },
    ]);
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
      type: "message",
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
    const { getConversationStore, getDb, getSqlExecutor } =
      await import("@/chat/db");
    const [rootRow] = await getDb()
      .select({ destinationId: juniorConversations.destinationId })
      .from(juniorConversations)
      .where(eq(juniorConversations.conversationId, publicRoot));
    if (!rootRow?.destinationId) throw new Error("Missing root destination");
    await getDb()
      .update(juniorDestinations)
      .set({ visibility: "private" })
      .where(eq(juniorDestinations.id, rootRow.destinationId));
    const privateSnapshot = await readConversationEventPrivacySnapshot(
      getSqlExecutor(),
      {
        conversationId: publicChild,
        eventTypes: ["message"],
      },
    );
    expect(privateSnapshot).toMatchObject({
      rootConversationId: publicRoot,
      visibility: "private",
    });
    expect(privateSnapshot?.events.map((event) => event.type)).toEqual([
      "message",
    ]);
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
      expect(detail.modelUsage).toBeUndefined();
    }
  });

  it("deletes child events when an append wins before tree purge", async () => {
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
        "LOCK TABLE junior_conversation_events IN ACCESS EXCLUSIVE MODE",
      );
      tablesLocked.resolve();
      await releaseTables.promise;
    });

    try {
      await tablesLocked.promise;
      const completionOrder: string[] = [];
      const writerPromise = createSqlConversationEventStore(writer)
        .append(childConversationId, [
          {
            data: {
              type: "message",
              messageId: "concurrent-child-message",
              role: "assistant",
              text: "concurrent physical child payload",
            },
            createdAtMs: Date.now(),
          },
        ])
        .then(() => completionOrder.push("writer"));
      await waitUntilApplicationWaitsOnLock(
        observer,
        "junior-append-purge-writer",
        "junior_conversation_events",
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
        expect(events).toEqual([]);
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
});
