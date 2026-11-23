/**
 * Harness for idle cache warming tests. Turns run through the recorder, and
 * the tests deliver the warmup and horizon messages that `sendCacheWarmup`
 * captured. Each test file must mock `sendCacheWarmup` of
 * `@/chat/cache-warming/queue`.
 */
import { vi } from "vitest";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai/compat";
import {
  sendCacheWarmup,
  type CacheWarmupMessage,
} from "@/chat/cache-warming/queue";
import { createCacheWarmingRecorder } from "@/chat/cache-warming/recorder";
import { runCacheWarmup } from "@/chat/cache-warming/warmup";
import { spawnChildAgent } from "@/chat/agent-invocations/create";
import { IDLE_HORIZON_MS, WARMUP_MARGIN_MS } from "@/chat/cache-warming/model";
import { turnBehavior } from "@/chat/conversations/kind-behavior";
import { getConversationStore } from "@/chat/db";
import { resolveGatewayModel } from "@/chat/pi/client";
import { getStateAdapter } from "@/chat/state/adapter";
import type { PromptMode } from "@/chat/system-prompt-rules";

export const MINUTE = 60_000;
export const conversationId = "local:test:cache-warming-segments";
// Only this Conversation has plugin work, so the other cases keep `none`.
export const workConversationId = "local:test:cache-warming-segments-work";
export const childConversationId = `${workConversationId}:child`;
export const openWorkConversationId = "local:test:cache-warming-segments-open";
// Only these Conversations have a timer or a child agent.
export const timerConversationId = "local:test:cache-warming-segments-timer";
export const parentConversationId = "local:test:cache-warming-segments-parent";
// Only this Conversation has an Automation run's Watch.
export const automationConversationId =
  "local:test:cache-warming-segments-automation";
export const model = resolveGatewayModel("anthropic/claude-opus-5.5");
export const context: Context = {
  systemPrompt: "Answer the person.",
  messages: [{ role: "user", content: "Hi.", timestamp: 1 }],
};
export const finalReply: AssistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "Done." }],
  api: "anthropic-messages",
  provider: "vercel-ai-gateway",
  model: model.id,
  usage: {
    input: 10,
    output: 10,
    cacheRead: 60_000,
    cacheWrite: 0,
    totalTokens: 60_020,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: 1,
};

export const definitionsKey = {
  platform: "local",
  mode: "conversation",
} as const;

/**
 * The recorder input of a Turn in the Conversation kind that has this mode,
 * from `turnBehavior`.
 */
export function turnOf(
  userActor: boolean,
  mode: PromptMode = definitionsKey.mode,
) {
  const kind =
    mode === "automation"
      ? "automation"
      : mode === "child_agent"
        ? "task"
        : "root";
  return {
    userActor,
    idleNeedsPendingWork: turnBehavior({ kind, personInput: userActor })
      .idleNeedsPendingWork,
  };
}

/** Run one Turn that ends with a final response, like one agent run does. */
export async function endTurn(
  userActor: boolean,
  id = conversationId,
  turnContext = context,
  mode: PromptMode = definitionsKey.mode,
) {
  const recorder = createCacheWarmingRecorder(id, turnOf(userActor, mode), {
    ...definitionsKey,
    mode,
  });
  void recorder.wrap((() => undefined) as never)(model, turnContext, {});
  await recorder.record(finalReply);
}

export const toolCall = (name: string): AssistantMessage => ({
  ...finalReply,
  content: [{ type: "toolCall", id: name, name, arguments: {} }],
  stopReason: "toolUse",
});

/**
 * Run one Turn that calls a tool and then an answer tool that ends the run,
 * like one agent run does.
 */
export async function endTurnWithAnswerTool(
  toolName: string,
  mode: PromptMode,
) {
  const recorder = createCacheWarmingRecorder(
    conversationId,
    turnOf(false, mode),
    {
      ...definitionsKey,
      mode,
    },
  );
  const stream = recorder.wrap((() => undefined) as never);
  void stream(model, context, {});
  await recorder.record(toolCall("systemTime"));
  recorder.toolsReturned();
  vi.advanceTimersByTime(MINUTE);
  void stream(model, context, {});
  await recorder.record(toolCall(toolName));
  recorder.answerToolEnded(toolName);
  await recorder.stop();
}

/** Start a child agent that still runs when the parent's Turn ends. */
export async function startChildAgent() {
  const parentDestination = {
    platform: "local",
    conversationId: parentConversationId,
  } as const;
  await getConversationStore().recordActivity({
    conversationId: parentConversationId,
    destination: parentDestination,
    source: "internal",
  });
  // The child's task waits in its mailbox, so the child still runs.
  await spawnChildAgent(
    {
      actor: { name: "parent-agent", platform: "system" },
      idempotencyKey: "cache-warming-child",
      input: "Summarize the durable task.",
      parentConversationId,
      parentToolCallId: "cache-warming-child",
      parentTurnId: "cache-warming-child",
      reasoningLevel: "medium",
    },
    { queue: { send: async () => undefined } },
  );
}

/** The last horizon message that the idle period sent. */
export function scheduledHorizon(): CacheWarmupMessage {
  const message = vi
    .mocked(sendCacheWarmup)
    .mock.calls.map(([sent]) => sent as CacheWarmupMessage)
    .reverse()
    .find((sent) => sent.kind === "horizon");
  if (!message) throw new Error("No horizon message was scheduled.");
  return message;
}

type WarmupMessage = Extract<CacheWarmupMessage, { kind: "warmup" }>;

/** The last warmup message that the idle period sent. */
export function scheduledWarmup(): WarmupMessage {
  const message = vi
    .mocked(sendCacheWarmup)
    .mock.calls.map(([sent]) => sent as CacheWarmupMessage)
    .reverse()
    .find((sent): sent is WarmupMessage => sent.kind === "warmup");
  if (!message) throw new Error("No warmup was scheduled.");
  return message;
}

export const segmentGaps = (segment: string) =>
  getStateAdapter().getList<number>(`junior:cache_warming:gaps:${segment}`);

/**
 * Deliver each warmup of the idle period when the queue would, and the
 * horizon before the first warmup after it. Return the idle time of each
 * warmup that refreshed the cache.
 */
export async function runIdleWarmups(sinceMs: number): Promise<number[]> {
  const refreshedAtIdleMs: number[] = [];
  let horizonRan = false;
  for (let warmup = scheduledWarmup(); ;) {
    vi.setSystemTime(warmup.cacheExpiresAtMs - WARMUP_MARGIN_MS);
    if (!horizonRan && Date.now() - sinceMs >= IDLE_HORIZON_MS) {
      await runCacheWarmup(scheduledHorizon());
      horizonRan = true;
    }
    await runCacheWarmup(warmup);
    const next = scheduledWarmup();
    if (next === warmup) return refreshedAtIdleMs;
    refreshedAtIdleMs.push(Date.now() - sinceMs);
    warmup = next;
  }
}
