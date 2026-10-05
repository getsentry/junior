import type {
  PluginRegistration,
  PluginTaskContext,
} from "@sentry/junior-plugin-api";
import type { Message } from "@earendil-works/pi-ai";
import { botConfig } from "@/chat/config";
import { getConversationEventStore } from "@/chat/db";
import { logInfo } from "@/chat/logging";
import { resolveGatewayModel, completeText } from "@/chat/pi/client";
import type { ConversationEvent } from "@/chat/conversations/history";
import {
  distillationSavings,
  estimateWorkerCost,
  expectedContextCalls,
  shouldUseDistillations,
} from "./economics";
import {
  activeDistillations,
  distillationSource,
  estimateModelVisibleTokens,
  pendingSegments,
  renderSegment,
  type HistoryEntry,
} from "./history";
import {
  CONSOLIDATION_SYSTEM,
  DISTILLATION_SYSTEM,
  consolidationUser,
  distillationUser,
  parseObservations,
} from "./prompt";

const LUNA_MODEL_ID = "openai/gpt-6-luna";
const LOCK_TTL_MS = 10 * 60 * 1_000;
const MAX_OUTPUT_TOKENS = 4_096;

function userMessage(text: string): Message {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  };
}

function costUsd(
  result: Awaited<ReturnType<typeof completeText>>,
  inputTokens: number,
  outputTokens: number,
): number {
  const billed = result.message.usage?.cost?.total;
  if (typeof billed === "number" && Number.isFinite(billed) && billed > 0) {
    return billed;
  }
  return estimateWorkerCost({
    model: resolveGatewayModel(LUNA_MODEL_ID),
    inputTokens,
    outputTokens,
  });
}

async function observe(args: {
  conversationId: string;
  input: string;
  system: string;
  promptName: string;
}): Promise<{ observations: string; costUsd: number }> {
  const inputTokens = Math.ceil((args.system.length + args.input.length) / 4);
  const result = await completeText({
    modelId: LUNA_MODEL_ID,
    promptName: args.promptName,
    system: args.system,
    messages: [userMessage(args.input)],
    maxTokens: MAX_OUTPUT_TOKENS,
    temperature: 0,
    cacheRetention: "none",
    messageAttributeMode: "metadata",
    metadata: { threadId: args.conversationId },
  });
  const observations = parseObservations(result.text);
  if (!observations) {
    throw new Error("Conversation observations were empty or malformed");
  }
  return {
    observations,
    costUsd: costUsd(result, inputTokens, Math.ceil(result.text.length / 4)),
  };
}

function workerIsWorthRunning(
  entries: readonly HistoryEntry[],
  modelId: string,
  expectedCalls: number,
): boolean {
  const rawTokens = estimateModelVisibleTokens(
    entries.map((entry) => entry.message),
  );
  // The worker is bounded to six segments per Turn. Price the full eligible
  // prefix, not only this batch, or a long Turn could never start distilling.
  const removedTokens = Math.max(0, rawTokens - 20_000);
  const replacementTokens =
    rawTokens - removedTokens + Math.ceil(removedTokens / 16_000) * 2_048;
  const observerCost = estimateWorkerCost({
    model: resolveGatewayModel(LUNA_MODEL_ID),
    inputTokens: removedTokens,
    outputTokens: Math.ceil(removedTokens / 16_000) * 2_048,
  });
  const price = {
    model: resolveGatewayModel(modelId),
    rawTokens,
    replacementTokens,
    expectedCalls,
    rawCacheWarm: true,
    workerCostUsd: observerCost,
  };
  const worthRunning = shouldUseDistillations(price);
  if (!worthRunning) {
    logInfo("conversation.distillation.skipped", {
      "app.distillation.stage": "observer",
      "app.distillation.reason": "not_economical",
      "app.distillation.raw_tokens": rawTokens,
      "app.distillation.replacement_tokens": replacementTokens,
      "app.distillation.expected_calls": expectedCalls,
      "app.distillation.worker_cost_usd": observerCost,
      "app.distillation.savings_ratio":
        distillationSavings(price)?.savingsRatio ?? null,
    });
  }
  return worthRunning;
}

function lastTurnModelId(
  events: readonly ConversationEvent[],
  turnId: string,
  throughSeq: number,
): string | undefined {
  const completed = [...events]
    .filter((event) => event.seq <= throughSeq)
    .reverse();
  const boundary = completed.find(
    (event) =>
      (event.data.type === "turn_started" && event.data.turnId === turnId) ||
      event.data.type === "handoff" ||
      event.data.type === "compaction",
  )?.seq;
  const assistant = completed.find(
    (event) =>
      boundary !== undefined &&
      event.seq > boundary &&
      event.data.type === "assistant_message",
  );
  if (assistant?.data.type === "assistant_message") {
    const modelId = assistant.data.model;
    if (
      typeof modelId === "string" &&
      Object.values(botConfig.profiles).some(
        (profile) => profile.modelId === modelId,
      )
    ) {
      return modelId;
    }
  }
  const route = completed.find(
    (event) =>
      event.data.type === "turn_routed" && event.data.turnId === turnId,
  );
  return route?.data.type === "turn_routed" ? route.data.modelId : undefined;
}

/** Observe committed history after a Turn, outside the user's reply path. */
export async function distillCompletedTurn(
  context: PluginTaskContext,
): Promise<void> {
  const run = await context.run.load();
  await context.state.withLock(
    `distillation:${run.conversationId}`,
    LOCK_TTL_MS,
    async () => {
      const store = getConversationEventStore();
      const events = await store.loadCurrentHistory(run.conversationId);
      const source = distillationSource({
        events,
        profile: botConfig.defaultProfile,
        turnId: run.runId,
      });
      if (!source) {
        logInfo("conversation.distillation.skipped", {
          "app.distillation.stage": "observer",
          "app.distillation.reason": "no_completed_turn",
        });
        return;
      }
      const segments = pendingSegments(source);
      const modelId = lastTurnModelId(events, run.runId, source.terminalSeq);
      const futureCalls = expectedContextCalls(
        events.filter((event) => event.seq <= source.terminalSeq),
      );
      if (segments.length === 0 || !modelId) {
        logInfo("conversation.distillation.skipped", {
          "app.distillation.stage": "observer",
          "app.distillation.reason":
            segments.length === 0 ? "no_safe_segment" : "no_model",
          "app.distillation.raw_tokens": estimateModelVisibleTokens(
            source.entries.map((entry) => entry.message),
          ),
          "app.distillation.expected_calls": futureCalls,
        });
        return;
      }
      if (!workerIsWorthRunning(source.entries, modelId, futureCalls)) return;

      const previousObservations = source.events.at(-1)?.data.observations
        ? [source.events.at(-1)!.data.observations]
        : [];
      for (const segment of segments) {
        const fromSeq = segment[0]!.seq;
        const throughSeq = segment.at(-1)!.seq;
        const observed = await observe({
          conversationId: run.conversationId,
          system: DISTILLATION_SYSTEM,
          input: distillationUser({
            date: new Date(segment[0]!.message.timestamp)
              .toISOString()
              .slice(0, 10),
            messages: renderSegment(segment),
            ...(previousObservations.at(-1)
              ? { priorObservations: previousObservations.at(-1) }
              : undefined),
          }),
          promptName: "junior.context_distillation",
        });
        const written = await store.append(
          run.conversationId,
          [
            {
              createdAtMs: Date.now(),
              idempotencyKey: `distillation:0:${source.historyVersion}:${fromSeq}:${throughSeq}`,
              data: {
                type: "distillation",
                generation: 0,
                sourceHistoryVersion: source.historyVersion,
                fromSeq,
                throughSeq,
                observations: observed.observations,
                modelId: LUNA_MODEL_ID,
                costUsd: observed.costUsd,
              },
            },
          ],
          { activity: "preserve" },
        );
        if (written.length === 0) return;
        previousObservations.push(observed.observations);
      }

      const records = activeDistillations(
        await store.loadCurrentHistory(run.conversationId),
      );
      const meta = records.find((record) => record.data.generation === 1);
      const newSegments = records.filter(
        (record) => record.data.generation === 0,
      );
      // Keep the newest two segments raw so new facts do not rewrite an
      // established summary each time the worker runs.
      const toMerge = newSegments.slice(0, -2);
      if (toMerge.length < 3) return;
      const fromSeq = meta?.data.fromSeq ?? toMerge[0]!.data.fromSeq;
      const throughSeq = toMerge.at(-1)!.data.throughSeq;
      const observed = await observe({
        conversationId: run.conversationId,
        system: CONSOLIDATION_SYSTEM,
        input: consolidationUser({
          ...(meta ? { previousMeta: meta.data.observations } : undefined),
          segments: toMerge.map((record) => record.data.observations),
        }),
        promptName: "junior.context_consolidation",
      });
      await store.append(
        run.conversationId,
        [
          {
            createdAtMs: Date.now(),
            idempotencyKey: `distillation:1:${source.historyVersion}:${fromSeq}:${throughSeq}`,
            data: {
              type: "distillation",
              generation: 1,
              sourceHistoryVersion: source.historyVersion,
              fromSeq,
              throughSeq,
              observations: observed.observations,
              modelId: LUNA_MODEL_ID,
              costUsd: observed.costUsd,
            },
          },
        ],
        { activity: "preserve" },
      );
    },
  );
}

/** Core worker registration for Conversation-scoped observations. */
export const distillationTaskRegistration: PluginRegistration = {
  manifest: {
    name: "distillation",
    displayName: "Conversation distillation",
    description: "Observe completed Conversation history with Luna",
  },
  tasks: {
    updateContext: {
      async run(context) {
        await distillCompletedTurn(context);
      },
    },
  },
};
