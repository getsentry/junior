import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai/compat";
import type { CacheWarmupMessage } from "@/chat/cache-warming/queue";
import { WARMUP_MARGIN_MS } from "@/chat/cache-warming/model";
import {
  commitMessages,
  loadConversationProjection,
} from "@/chat/conversations/projection";
import { turnBehavior } from "@/chat/conversations/kind-behavior";
import { getConversationEventStore } from "@/chat/db";
import { resolveGatewayModel } from "@/chat/pi/client";
import type { PiMessage } from "@/chat/pi/messages";
import { getAgentBackgroundCompactionMarkTokens } from "@/chat/services/context-budget";
import { getStateAdapter } from "@/chat/state/adapter";
import { mockTitleModel } from "../../fixtures/title-model";

const mocks = vi.hoisted(() => ({
  sendCacheWarmup: vi.fn(async (_message: unknown, _delayMs: number) => {}),
}));

vi.mock("@/chat/cache-warming/queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/chat/cache-warming/queue")>()),
  sendCacheWarmup: mocks.sendCacheWarmup,
}));

const { createCacheWarmingRecorder, runCacheWarmup } =
  await import("@/chat/cache-warming/warmup");

const MINUTE = 60_000;
const GAPS_KEY = "junior:cache_warming:gaps:user:1:none";
const model = resolveGatewayModel("anthropic/claude-opus-5.5");
const markTokens = getAgentBackgroundCompactionMarkTokens(model.id);
const context: Context = {
  systemPrompt: "Answer the person.",
  messages: [{ role: "user", content: "Hi.", timestamp: 1 }],
};
const definitionsKey = { platform: "local", mode: "conversation" } as const;
// The summary replaces this tool result, which is over the compaction
// threshold on its own.
const OVERSIZED_TEXT = "x".repeat(1_600_000);
const SUMMARY = "The person asked for the deploy checksum of build 7421.";

function assistant(text: string, timestamp: number): PiMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: model.id,
    usage: {},
    stopReason: "stop",
    timestamp,
  } as PiMessage;
}

const history: PiMessage[] = [
  {
    role: "user",
    content: [
      {
        type: "text",
        text: "<current-instruction>Find build 7421.</current-instruction>",
      },
    ],
    timestamp: 1,
  } as PiMessage,
  {
    ...assistant("", 2),
    content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: {} }],
    stopReason: "toolUse",
  } as PiMessage,
  {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "bash",
    content: [{ type: "text", text: OVERSIZED_TEXT }],
    isError: false,
    timestamp: 3,
  } as PiMessage,
  assistant("Found build 7421.", 4),
];

// Commit the Turn's history, and the background summary fact that the Turn
// left: a ready summary, or a request that still runs.
async function commitTurn(
  conversationId: string,
  summary: "ready" | "running",
) {
  const committed = await commitMessages({
    conversationId,
    messages: history,
  });
  const fact = {
    markSeq: committed.committedSeq,
    historyVersion: committed.historyVersion,
    modelId: model.id,
  };
  await getConversationEventStore().append(conversationId, [
    {
      createdAtMs: Date.now(),
      data:
        summary === "ready"
          ? {
              type: "compaction_prepared",
              ...fact,
              outcome: "ready",
              summary: SUMMARY,
            }
          : { type: "compaction_requested", ...fact },
    },
  ]);
}

// End the Turn with a model call whose cached prefix is at the mark, like
// one agent run does.
async function endTurn(conversationId: string) {
  const recorder = createCacheWarmingRecorder(
    conversationId,
    {
      userActor: true,
      idleNeedsPendingWork: turnBehavior({ kind: "root", personInput: true })
        .idleNeedsPendingWork,
    },
    definitionsKey,
  );
  void recorder.wrap((() => undefined) as never)(model, context, {});
  const reply: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "Done." }],
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    model: model.id,
    usage: {
      input: 10,
      output: 10,
      cacheRead: markTokens,
      cacheWrite: 0,
      totalTokens: markTokens + 20,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 5,
  };
  await recorder.record(reply);
}

function scheduledWarmup() {
  const message = mocks.sendCacheWarmup.mock.calls
    .map(([sent]) => sent as CacheWarmupMessage)
    .find(
      (sent): sent is Extract<CacheWarmupMessage, { kind: "warmup" }> =>
        sent.kind === "warmup",
    );
  if (!message) throw new Error("No warmup was scheduled.");
  return message;
}

const historyText = async (conversationId: string) =>
  JSON.stringify(
    (await loadConversationProjection({ conversationId })).messages,
  );

describe("cache warming compaction on idle", () => {
  afterEach(async () => {
    vi.useRealTimers();
    const state = getStateAdapter();
    await state.delete(GAPS_KEY);
    await state.delete("junior:cache_warming:breaker:anthropic:outcomes");
  });

  it("swaps a ready background summary in when the cache is about to expire, and sends no warmup", async () => {
    const conversationId = "local:test:idle-compaction-ready";
    // People in this segment reply after 8 minutes, so the model would warm.
    for (let i = 0; i < 20; i++) {
      await getStateAdapter().appendToList(GAPS_KEY, 8 * MINUTE);
    }
    const warmupRequests: unknown[] = [];
    mockTitleModel("", {
      onRequest: (request) => warmupRequests.push(request),
    });
    await commitTurn(conversationId, "ready");
    mocks.sendCacheWarmup.mockClear();
    vi.useFakeTimers({ toFake: ["Date"] });
    await endTurn(conversationId);
    const warmup = scheduledWarmup();

    vi.setSystemTime(warmup.cacheExpiresAtMs - WARMUP_MARGIN_MS);
    await runCacheWarmup(warmup);

    // The person who returns reads the summary, not the full tool result.
    const text = await historyText(conversationId);
    expect(text).toContain(SUMMARY);
    expect(text).not.toContain(OVERSIZED_TEXT.slice(0, 100));
    expect(warmupRequests).toEqual([]);
    // The idle period stops: no next warmup of the old prefix.
    expect(
      mocks.sendCacheWarmup.mock.calls.filter(
        ([sent]) => (sent as CacheWarmupMessage).kind === "warmup",
      ),
    ).toHaveLength(1);
  });

  it("warms the full prefix while the background summary still runs", async () => {
    const conversationId = "local:test:idle-compaction-running";
    for (let i = 0; i < 20; i++) {
      await getStateAdapter().appendToList(GAPS_KEY, 8 * MINUTE);
    }
    const warmupRequests: unknown[] = [];
    mockTitleModel("", {
      cacheReadTokens: markTokens,
      onRequest: (request) => warmupRequests.push(request),
    });
    await commitTurn(conversationId, "running");
    mocks.sendCacheWarmup.mockClear();
    vi.useFakeTimers({ toFake: ["Date"] });
    await endTurn(conversationId);
    const warmup = scheduledWarmup();

    vi.setSystemTime(warmup.cacheExpiresAtMs - WARMUP_MARGIN_MS);
    await runCacheWarmup(warmup);

    expect(warmupRequests).toHaveLength(1);
    expect(await historyText(conversationId)).toContain(
      OVERSIZED_TEXT.slice(0, 100),
    );
  });
});
