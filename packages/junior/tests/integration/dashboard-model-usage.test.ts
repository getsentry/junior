import { and, eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { readConversationFeedFromSql } from "@/api/conversations/list";
import { purgeConversation } from "@/chat/conversations/retention";
import {
  closeDb,
  getConversationEventStore,
  getDb,
  getSqlExecutor,
} from "@/chat/db";
import { historyItemFromPiMessage } from "@/chat/pi/conversation-events";
import type { PiMessage } from "@/chat/pi/messages";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { juniorConversationEvents, juniorConversations } from "@/db/schema";
import {
  appendVisibleHistory,
  recordRoot,
  replacement,
  requireDetail,
} from "../fixtures/dashboard-reporting";

/**
 * Change the stored assistant calls of a Conversation by hand. Events are
 * append-only, so only a read that sums these calls again shows the change.
 */
async function changeStoredCallInput(conversationId: string): Promise<void> {
  await getDb()
    .update(juniorConversationEvents)
    .set({
      payload: sql`jsonb_set(${juniorConversationEvents.payload}, '{usage,input}', '1000')`,
    })
    .where(
      and(
        eq(juniorConversationEvents.conversationId, conversationId),
        eq(juniorConversationEvents.type, "assistant_message"),
      ),
    );
}

describe("dashboard model usage reporting", () => {
  afterEach(async () => {
    await closeDb();
    await disconnectStateAdapter();
  });

  it("aggregates per-model tokens and costs without counting replayed history", async () => {
    const conversationId = "slack:C-reporting:model-usage";
    await recordRoot(conversationId, "public");
    // @ts-expect-error non-overlapping boundary cast; rule forbids as-unknown-as chains
    const componentUsageMessage = {
      role: "assistant",
      api: "responses",
      provider: "openai",
      model: "gpt-5",
      content: [],
      stopReason: "stop",
      timestamp: 10,
      usage: {
        input: 10,
        cost: {
          input: 0.01,
          output: 0.02,
          cacheRead: 0.003,
          cacheWrite: 0.004,
          total: 0.037,
        },
      },
    } as PiMessage;
    // @ts-expect-error non-overlapping boundary cast; rule forbids as-unknown-as chains
    const totalOnlyUsageMessage = {
      role: "assistant",
      api: "responses",
      provider: "openai",
      model: "gpt-5",
      content: [],
      stopReason: "stop",
      timestamp: 11,
      usage: { totalTokens: 7, cost: { total: 0.005 } },
    } as PiMessage;
    await getConversationEventStore().append(conversationId, [
      {
        data: historyItemFromPiMessage(componentUsageMessage, {
          authority: "context",
        }),
        createdAtMs: 10,
      },
      {
        data: historyItemFromPiMessage(totalOnlyUsageMessage, {
          authority: "context",
        }),
        createdAtMs: 11,
      },
    ]);
    await getConversationEventStore().replaceHistory(conversationId, {
      createdAtMs: 1_000,
      data: {
        type: "compaction",
        modelId: "openai/gpt-5",
        replacementHistory: [
          replacement(componentUsageMessage),
          replacement(totalOnlyUsageMessage),
        ],
      },
    });

    expect((await requireDetail(conversationId)).modelUsage).toEqual([
      {
        modelId: "openai/gpt-5",
        usage: {
          inputTokens: 10,
          totalTokens: 17,
          cost: {
            input: 0.01,
            output: 0.02,
            cacheRead: 0.003,
            cacheWrite: 0.004,
            total: 0.042,
          },
        },
      },
    ]);

    // A later read adds the calls after the first read to its totals.
    await getConversationEventStore().append(conversationId, [
      {
        data: historyItemFromPiMessage(
          { ...componentUsageMessage, timestamp: 1_001 },
          { authority: "context" },
        ),
        createdAtMs: 1_001,
      },
    ]);
    expect((await requireDetail(conversationId)).modelUsage).toEqual([
      {
        modelId: "openai/gpt-5",
        usage: {
          inputTokens: 20,
          totalTokens: 27,
          cost: {
            input: 0.02,
            output: 0.04,
            cacheRead: 0.006,
            cacheWrite: 0.008,
            total: 0.079,
          },
        },
      },
    ]);
  });

  it("keys gateway assistant usage by the vendor model id", async () => {
    const conversationId = "slack:C-reporting:gateway-model-usage";
    await recordRoot(conversationId, "public");
    // @ts-expect-error non-overlapping boundary cast; rule forbids as-unknown-as chains
    const gatewayUsageMessage = {
      role: "assistant",
      api: "responses",
      provider: "vercel-ai-gateway",
      model: "openai/gpt-5.6-sol",
      content: [],
      stopReason: "stop",
      timestamp: 10,
      usage: {
        input: 12,
        output: 4,
        totalTokens: 16,
        cost: { total: 0.03 },
      },
    } as PiMessage;
    await getConversationEventStore().append(conversationId, [
      {
        data: historyItemFromPiMessage(gatewayUsageMessage, {
          authority: "context",
        }),
        createdAtMs: 10,
      },
    ]);

    expect((await requireDetail(conversationId)).modelUsage).toEqual([
      {
        modelId: "openai/gpt-5.6-sol",
        usage: expect.objectContaining({
          inputTokens: 12,
          outputTokens: 4,
          totalTokens: 16,
        }),
      },
    ]);
  });

  it("rolls unprojected child usage into a root conversation", async () => {
    const rootConversationId = "slack:C-reporting:tree-usage";
    const childConversationId = "child:reporting-unprojected-usage";
    await recordRoot(rootConversationId, "public");
    await appendVisibleHistory(rootConversationId);
    const childAt = new Date(3);
    await getDb()
      .insert(juniorConversations)
      .values({
        conversationId: childConversationId,
        parentConversationId: rootConversationId,
        rootConversationId,
        createdAt: childAt,
        lastActivityAt: childAt,
        updatedAt: childAt,
        durationMs: 700,
        executionStatus: "idle",
        usage: { totalTokens: 7, cost: { total: 0.002 } },
      });
    await getDb()
      .update(juniorConversations)
      .set({
        durationMs: 300,
        usage: {
          inputTokens: 10,
          totalTokens: 999,
          cost: { total: 0.001 },
        },
      })
      .where(eq(juniorConversations.conversationId, rootConversationId));
    await appendVisibleHistory(childConversationId, "Unprojected child answer");

    const rootSummary = (
      await readConversationFeedFromSql()
    ).conversations.find(
      (conversation) => conversation.conversationId === rootConversationId,
    );
    expect(rootSummary?.cumulativeDurationMs).toBe(1_000);

    const rootDetail = await requireDetail(rootConversationId);
    expect(JSON.stringify(rootDetail.events)).not.toContain(
      childConversationId,
    );
    expect(rootDetail.cumulativeDurationMs).toBe(1_000);
    expect(rootDetail.cumulativeUsage).toEqual({
      totalTokens: 17,
      cost: { total: 0.003 },
    });
    expect(rootDetail.modelUsage).toEqual([
      {
        modelId: "openai/gpt-5",
        usage: expect.objectContaining({
          inputTokens: 20,
          outputTokens: 4,
          cachedInputTokens: 6,
          totalTokens: 30,
        }),
      },
    ]);

    // The root read cached the sums of each Conversation in its tree, each
    // with its own watermark. A read sums only events after the watermark,
    // and events are append-only. A changed stored call shows that the child
    // read reuses the child's entry.
    await changeStoredCallInput(childConversationId);
    const childDetail = await requireDetail(childConversationId);
    expect(childDetail.cumulativeDurationMs).toBe(700);
    expect(childDetail.cumulativeUsage).toEqual({
      totalTokens: 7,
      cost: { total: 0.002 },
    });
    expect(childDetail.modelUsage).toEqual([
      {
        modelId: "openai/gpt-5",
        usage: expect.objectContaining({ inputTokens: 10, totalTokens: 15 }),
      },
    ]);

    // A purge of the child restarts its seq and changes its first event, so
    // its watermark no longer matches. A read rebuilds only the child's
    // entry. The root's watermark still matches, so the root read does not
    // read the root's calls again.
    await changeStoredCallInput(rootConversationId);
    await purgeConversation(getSqlExecutor(), childConversationId, {
      nowMs: 50,
    });
    // @ts-expect-error non-overlapping boundary cast; rule forbids as-unknown-as chains
    const laterChildMessage = {
      role: "assistant",
      api: "responses",
      provider: "openai",
      model: "gpt-5",
      content: [],
      stopReason: "stop",
      timestamp: 60,
      usage: { input: 5, output: 1 },
    } as PiMessage;
    await getConversationEventStore().append(childConversationId, [
      {
        data: historyItemFromPiMessage(laterChildMessage, {
          authority: "context",
        }),
        createdAtMs: 60,
      },
    ]);
    expect((await requireDetail(rootConversationId)).modelUsage).toEqual([
      {
        modelId: "openai/gpt-5",
        usage: expect.objectContaining({
          inputTokens: 15,
          outputTokens: 3,
          totalTokens: 21,
        }),
      },
    ]);
  });

  it("leaves out history a fork child inherited from its parent", async () => {
    const rootConversationId = "slack:C-reporting:fork-child";
    const childConversationId = "agent:reporting-fork-child";
    await recordRoot(rootConversationId, "public");
    await appendVisibleHistory(rootConversationId);
    const childAt = new Date(100);
    await getDb().insert(juniorConversations).values({
      conversationId: childConversationId,
      parentConversationId: rootConversationId,
      rootConversationId,
      createdAt: childAt,
      lastActivityAt: childAt,
      updatedAt: childAt,
      executionStatus: "idle",
    });
    const assistant = (timestamp: number, totalTokens: number) =>
      // @ts-expect-error non-overlapping boundary cast; rule forbids as-unknown-as chains
      ({
        role: "assistant",
        api: "responses",
        provider: "openai",
        model: "gpt-5",
        content: [],
        stopReason: "stop",
        timestamp,
        usage: { totalTokens, cost: { total: 0 } },
      }) as PiMessage;
    // The child's first checkpoint commits the parent's history with the
    // parent's timestamps, then its own work.
    await getConversationEventStore().append(childConversationId, [
      {
        data: {
          type: "turn_started",
          turnId: "child-turn",
          inputMessageIds: ["child-input"],
          surface: "internal",
        },
        createdAtMs: 100,
      },
      {
        data: historyItemFromPiMessage(assistant(11, 15), {
          authority: "context",
        }),
        createdAtMs: 11,
      },
      {
        data: {
          type: "tool_result",
          toolCallId: "parent-tool-call",
          toolName: "search",
          content: [{ type: "text", text: "parent result" }],
          isError: false,
          timestamp: 12,
        },
        createdAtMs: 12,
      },
      {
        data: historyItemFromPiMessage(assistant(200, 7), {
          authority: "context",
        }),
        createdAtMs: 200,
      },
    ]);

    const childDetail = await requireDetail(childConversationId);
    expect(JSON.stringify(childDetail.events)).not.toContain(
      "parent-tool-call",
    );
    expect(childDetail.modelUsage).toEqual([
      {
        modelId: "openai/gpt-5",
        usage: expect.objectContaining({ totalTokens: 7 }),
      },
    ]);
    expect((await requireDetail(rootConversationId)).modelUsage).toEqual([
      {
        modelId: "openai/gpt-5",
        usage: expect.objectContaining({ totalTokens: 22 }),
      },
    ]);

    // Later reads add new calls of the root, the child, and a new child.
    const laterChildConversationId = "agent:reporting-fork-child-later";
    await getDb()
      .insert(juniorConversations)
      .values({
        conversationId: laterChildConversationId,
        parentConversationId: rootConversationId,
        rootConversationId,
        createdAt: new Date(500),
        lastActivityAt: new Date(500),
        updatedAt: new Date(500),
        executionStatus: "idle",
      });
    for (const [conversationId, timestamp, totalTokens] of [
      [childConversationId, 300, 5],
      [rootConversationId, 400, 4],
      [laterChildConversationId, 500, 3],
    ] as const) {
      await getConversationEventStore().append(conversationId, [
        {
          data: historyItemFromPiMessage(assistant(timestamp, totalTokens), {
            authority: "context",
          }),
          createdAtMs: timestamp,
        },
      ]);
    }
    expect((await requireDetail(childConversationId)).modelUsage).toEqual([
      {
        modelId: "openai/gpt-5",
        usage: expect.objectContaining({ totalTokens: 12 }),
      },
    ]);
    expect((await requireDetail(rootConversationId)).modelUsage).toEqual([
      {
        modelId: "openai/gpt-5",
        usage: expect.objectContaining({ totalTokens: 34 }),
      },
    ]);
  });
});
