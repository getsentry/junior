import { afterEach, describe, expect, it, vi } from "vitest";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import { runHeartbeat } from "@/chat/agent-dispatch/heartbeat";
import { backfillCacheWarmingGaps } from "@/chat/cache-warming/backfill";
import { NO_REPLY_GAP_MS } from "@/chat/cache-warming/model";
import { GLOBAL_GAPS_TTL_MS } from "@/chat/cache-warming/warmup";
import {
  agentInstructionProvenance,
  contextProvenance,
  instructionProvenanceFor,
} from "@/chat/conversations/provenance";
import { getConversationEventStore, getConversationStore } from "@/chat/db";
import { historyItemFromPiMessage } from "@/chat/pi/conversation-events";
import { getStateAdapter } from "@/chat/state/adapter";
import { createAgent } from "../fixtures/agent";
import { closeConversationFixture } from "../fixtures/conversation";
import { createConversationWorkQueueTestAdapter } from "../fixtures/conversation-work";
import { mockTitleModel } from "../fixtures/title-model";

const MINUTE = 60_000;
const T0 = Date.parse("2026-06-01T09:00:00.000Z");
const SEGMENTS = [
  "user:1:none",
  "user:2-3:none",
  "user:4+:none",
  "system:1:none",
  "system:2-3:none",
  "system:4+:none",
];

function reply(
  prefixTokens: number,
  startedAtMs = Date.now(),
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "Done." }],
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: 10,
      output: 10,
      cacheRead: prefixTokens,
      cacheWrite: 0,
      totalTokens: prefixTokens + 20,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    // Pi sets this when the request starts.
    timestamp: startedAtMs,
  };
}

// Run one Turn per entry through the real Conversation path. Each Turn makes
// one model request at its own time, with its own cached prefix size.
async function runTurns(turns: Array<{ atMs: number; prefixTokens: number }>) {
  let request = 0;
  // The faux provider estimates its own usage, so this stream sets it.
  const modelStream: StreamFn = () => {
    const stream = createAssistantMessageEventStream();
    const message = reply(turns[request++]!.prefixTokens);
    queueMicrotask(() => {
      stream.push({ type: "done", reason: "stop", message });
      stream.end(message);
    });
    return stream;
  };
  // This OpenAI model is never warmed, so live recording writes no gaps
  // while these Turns run.
  const agent = await createAgent({
    modelStream,
    botConfig: { modelId: "openai/gpt-5.5" },
  });
  for (const [index, turn] of turns.entries()) {
    vi.setSystemTime(turn.atMs);
    await agent.run(`Question ${index + 1}`);
  }
  return agent.conversationId();
}

const gaps = (segment: string) =>
  getStateAdapter().getList<number>(`junior:cache_warming:gaps:${segment}`);

async function heartbeat(nowMs: number) {
  vi.setSystemTime(nowMs);
  await runHeartbeat({
    conversationWorkQueue: createConversationWorkQueueTestAdapter(),
    nowMs,
  });
}

describe("cache warming gap backfill", () => {
  afterEach(async () => {
    vi.useRealTimers();
    const state = getStateAdapter();
    await state.delete("junior:cache_warming:backfill:work_state");
    for (const segment of SEGMENTS) {
      await state.delete(`junior:cache_warming:gaps:${segment}`);
    }
    await closeConversationFixture();
  });

  it("fills each empty gap list from the stored Turns", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    mockTitleModel("Conversation title");
    // Live recording already has a gap for later Turns of people. The
    // backfill does not add to it.
    await getStateAdapter().appendToList(
      "junior:cache_warming:gaps:user:4+:none",
      1,
    );

    // A person replies 7 minutes after the first Turn and 60 minutes after
    // the second. The third Turn has a prefix too small to warm, so its
    // 2 minute gap is not a gap that live recording would record.
    const conversationId = await runTurns([
      { atMs: T0, prefixTokens: 60_000 },
      { atMs: T0 + 7 * MINUTE, prefixTokens: 60_000 },
      { atMs: T0 + 67 * MINUTE, prefixTokens: 1_000 },
      { atMs: T0 + 69 * MINUTE, prefixTokens: 60_000 },
    ]);
    // Only the parent agent sends Turns to a Task.
    const taskId = `${conversationId}:task`;
    await getConversationStore().createChild({
      childConversationId: taskId,
      kind: "task",
      parentConversationId: conversationId,
      nowMs: T0,
    });
    await getConversationEventStore().append(taskId, [
      {
        createdAtMs: T0 + MINUTE,
        data: historyItemFromPiMessage(
          { role: "user", content: "Check the logs.", timestamp: T0 + MINUTE },
          agentInstructionProvenance,
        ),
      },
      {
        createdAtMs: T0 + 2 * MINUTE,
        data: historyItemFromPiMessage(
          reply(60_000, T0 + MINUTE),
          contextProvenance,
        ),
      },
    ]);
    await heartbeat(T0 + 130 * MINUTE);

    expect(await gaps("user:1:none")).toEqual([7 * MINUTE]);
    expect(await gaps("user:2-3:none")).toEqual([NO_REPLY_GAP_MS]);
    expect(await gaps("user:4+:none")).toEqual([1]);
    expect(await gaps("system:1:none")).toEqual([NO_REPLY_GAP_MS]);

    await getStateAdapter().delete("junior:cache_warming:gaps:user:1:none");
    await heartbeat(T0 + 131 * MINUTE);
    expect(await gaps("user:1:none")).toEqual([]);

    // The completed run expires after the gap list TTL, so a later heartbeat
    // checks for empty lists again.
    const doneKey = "junior:cache_warming:backfill:work_state";
    vi.setSystemTime(T0 + 130 * MINUTE + GLOBAL_GAPS_TTL_MS - MINUTE);
    expect(await getStateAdapter().get(doneKey)).toBe("done");
    vi.setSystemTime(T0 + 130 * MINUTE + GLOBAL_GAPS_TTL_MS);
    expect(await getStateAdapter().get(doneKey)).toBeNull();
  });

  it("keeps the Actor that started a Turn when a person steers it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const conversationId = "local:test:backfill-steer";
    await getConversationStore().recordActivity({
      conversationId,
      destination: { platform: "slack", teamId: "T123", channelId: "C123" },
      activityAtMs: T0,
      nowMs: T0,
    });
    const person = instructionProvenanceFor({
      platform: "slack",
      teamId: "T123",
      userId: "U123",
    });
    await getConversationEventStore().append(conversationId, [
      {
        createdAtMs: T0,
        data: historyItemFromPiMessage(
          { role: "user", content: "Run the check.", timestamp: T0 },
          instructionProvenanceFor({ platform: "system", name: "scheduler" }),
        ),
      },
      {
        createdAtMs: T0 + MINUTE / 2,
        data: historyItemFromPiMessage(
          { ...reply(60_000, T0), stopReason: "toolUse" },
          contextProvenance,
        ),
      },
      {
        createdAtMs: T0 + MINUTE / 2,
        data: historyItemFromPiMessage(
          { role: "user", content: "Also check staging.", timestamp: T0 },
          person,
        ),
      },
      {
        createdAtMs: T0 + 2 * MINUTE,
        data: historyItemFromPiMessage(
          reply(60_000, T0 + MINUTE),
          contextProvenance,
        ),
      },
    ]);

    vi.setSystemTime(T0 + 130 * MINUTE);
    await backfillCacheWarmingGaps({ nowMs: T0 + 130 * MINUTE });
    expect(await gaps("system:1:none")).toEqual([NO_REPLY_GAP_MS]);
    expect(await gaps("user:1:none")).toEqual([]);
  });

  it("completes with the gaps it has when its scan budget is used", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    mockTitleModel("Conversation title");
    const conversationId = await runTurns([
      { atMs: T0 + 30 * MINUTE, prefixTokens: 60_000 },
      { atMs: T0 + 37 * MINUTE, prefixTokens: 60_000 },
    ]);
    // A Task that ended long ago. Newest first, it is in the second batch.
    const taskId = `${conversationId}:task`;
    await getConversationStore().createChild({
      childConversationId: taskId,
      kind: "task",
      parentConversationId: conversationId,
      nowMs: T0,
    });
    await getConversationEventStore().append(taskId, [
      {
        createdAtMs: T0 + MINUTE,
        data: historyItemFromPiMessage(
          reply(60_000, T0 + MINUTE),
          contextProvenance,
        ),
      },
    ]);
    // With the person Conversation, these fill the first batch and more.
    for (let i = 0; i < 10; i++) {
      await getConversationStore().recordActivity({
        conversationId: `local:test:backfill-budget:${i}`,
        destination: { platform: "slack", teamId: "T123", channelId: "C123" },
        activityAtMs: T0 + 20 * MINUTE,
        nowMs: T0 + 20 * MINUTE,
      });
    }

    vi.setSystemTime(T0 + 130 * MINUTE);
    await backfillCacheWarmingGaps({ nowMs: T0 + 130 * MINUTE, budgetMs: 0 });
    expect(await gaps("user:1:none")).toEqual([7 * MINUTE]);
    expect(await gaps("system:1:none")).toEqual([]);

    // The run completed, so a heartbeat does not scan the rest.
    await heartbeat(T0 + 131 * MINUTE);
    expect(await gaps("system:1:none")).toEqual([]);
  });
});
