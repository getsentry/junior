import { afterEach, describe, expect, it, vi } from "vitest";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import { runHeartbeat } from "@/chat/agent-dispatch/heartbeat";
import { NO_REPLY_GAP_MS } from "@/chat/cache-warming/model";
import {
  agentInstructionProvenance,
  contextProvenance,
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
  "user:1",
  "user:2-3",
  "user:4+",
  "system:1",
  "system:2-3",
  "system:4+",
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
    await state.delete("junior:cache_warming:backfill");
    for (const segment of SEGMENTS) {
      await state.delete(`junior:cache_warming:gaps:${segment}`);
    }
    await closeConversationFixture();
  });

  it("fills each empty gap list once from the stored Turns", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    mockTitleModel("Conversation title");
    // Live recording already has a gap for later Turns of people. The
    // backfill does not add to it.
    await getStateAdapter().appendToList(
      "junior:cache_warming:gaps:user:4+",
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

    expect(await gaps("user:1")).toEqual([7 * MINUTE]);
    expect(await gaps("user:2-3")).toEqual([NO_REPLY_GAP_MS]);
    expect(await gaps("user:4+")).toEqual([1]);
    expect(await gaps("system:1")).toEqual([NO_REPLY_GAP_MS]);

    await getStateAdapter().delete("junior:cache_warming:gaps:user:1");
    await heartbeat(T0 + 131 * MINUTE);
    expect(await gaps("user:1")).toEqual([]);
  });
});
