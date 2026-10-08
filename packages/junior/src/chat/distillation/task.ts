import type {
  PluginRegistration,
  PluginTaskContext,
} from "@sentry/junior-plugin-api";
import type { Message } from "@earendil-works/pi-ai";
import { APICallError, UnsupportedFunctionalityError } from "ai-batch";
import { botConfig } from "@/chat/config";
import { getConversationEventStore } from "@/chat/db";
import { logInfo } from "@/chat/logging";
import { resolveGatewayModel, completeText } from "@/chat/pi/client";
import type {
  ConversationEvent,
  ConversationEventStore,
} from "@/chat/conversations/history";
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
import { gatewayObservationBatch, type ObservationRequest } from "./batch";

const LUNA_MODEL_ID = "openai/gpt-6-luna";
const LOCK_TTL_MS = 10 * 60 * 1_000;
const MAX_OUTPUT_TOKENS = 4_096;
const BATCH_POLL_SECONDS = 600;
const MAX_BATCH_INPUT_BYTES = 4_000_000;
const MAX_BATCH_WAIT_MS = 24 * 60 * 60 * 1_000 - 2 * BATCH_POLL_SECONDS * 1_000;

type StartedBatch = ConversationEvent & {
  data: Extract<ConversationEvent["data"], { type: "distillation_batch" }>;
};

/** Find the oldest unfinished batch for the current history version. */
export function pendingBatch(
  events: readonly ConversationEvent[],
  historyVersion?: number,
): StartedBatch | undefined {
  const batches = events.filter(
    (event): event is StartedBatch =>
      event.data.type === "distillation_batch" &&
      (historyVersion === undefined ||
        event.data.sourceHistoryVersion === historyVersion),
  );
  return batches.find(
    (batch) =>
      !events.some(
        (event) =>
          event.data.type === "distillation_batch_done" &&
          event.data.batchId === batch.data.batchId,
      ),
  );
}

/** Append all validated batch results together or leave source history raw. */
export async function finishBatch(args: {
  batch: StartedBatch;
  conversationId: string;
  store: ConversationEventStore;
  client?: Pick<typeof gatewayObservationBatch, "status" | "results">;
}): Promise<"pending" | "processed" | "failed"> {
  const { batch, conversationId, store } = args;
  const client = args.client ?? gatewayObservationBatch;
  const reference = {
    version: 2 as const,
    id: batch.data.batchId,
    provider: batch.data.provider,
  };
  const expired = Date.now() - batch.createdAtMs >= MAX_BATCH_WAIT_MS;
  const status = expired
    ? "failed"
    : await client.status(reference).catch((error: unknown) => {
        if (APICallError.isInstance(error) && error.statusCode === 404) {
          return "failed" as const;
        }
        throw error;
      });
  if (status === "pending") return "pending";

  const results = expired
    ? []
    : await client
        .results(reference, batch.data.requests.length)
        .catch((error: unknown) => {
          if (
            status === "failed" &&
            APICallError.isInstance(error) &&
            error.statusCode === 404
          ) {
            return [];
          }
          throw error;
        });
  const byId = new Map(results.map((result) => [result.id, result]));
  if (
    byId.size !== results.length ||
    results.length > batch.data.requests.length ||
    results.some(
      (result) =>
        !batch.data.requests.some((request) => request.id === result.id),
    )
  ) {
    throw new Error("Observation batch returned unexpected request IDs");
  }
  const observed = batch.data.requests.map((request) => {
    const result = byId.get(request.id);
    return {
      request,
      observations:
        result?.status === "succeeded" && result.text
          ? parseObservations(result.text)
          : undefined,
      costUsd: result?.costUsd,
      costEstimated: result?.costEstimated,
    };
  });
  const succeeded =
    status === "completed" &&
    observed.every(
      (item) =>
        item.observations &&
        item.costUsd !== undefined &&
        Number.isFinite(item.costUsd) &&
        item.costUsd >= 0,
    );
  const billedResults = results.filter(
    (result) => result.status === "succeeded",
  );
  const completeCost = billedResults.every(
    (result) => result.costUsd !== undefined,
  );
  const sourceCurrent =
    batch.data.sourceHistoryVersion ===
    (await store.loadCurrentHistoryVersion(conversationId));
  const includeObservations = succeeded && sourceCurrent;
  const done = {
    createdAtMs: Date.now(),
    idempotencyKey: `distillation:batch:done:${batch.data.batchId}`,
    data: {
      type: "distillation_batch_done" as const,
      sourceHistoryVersion: batch.data.sourceHistoryVersion,
      batchId: batch.data.batchId,
      outcome: includeObservations
        ? ("processed" as const)
        : ("failed" as const),
      ...(includeObservations || expired || !completeCost
        ? undefined
        : {
            costUsd: billedResults.reduce(
              (total, item) => total + item.costUsd!,
              0,
            ),
            ...(billedResults.some((result) => result.costEstimated)
              ? { costEstimated: true as const }
              : undefined),
          }),
    },
  };
  const written = await store.append(
    conversationId,
    [
      ...(includeObservations
        ? observed.map((item) => ({
            createdAtMs: Date.now(),
            idempotencyKey: `distillation:0:${batch.data.sourceHistoryVersion}:${item.request.fromSeq}:${item.request.throughSeq}`,
            data: {
              type: "distillation" as const,
              generation: 0 as const,
              sourceHistoryVersion: batch.data.sourceHistoryVersion,
              fromSeq: item.request.fromSeq,
              throughSeq: item.request.throughSeq,
              observations: item.observations!,
              modelId: LUNA_MODEL_ID,
              costUsd: item.costUsd!,
              ...(item.costEstimated
                ? { costEstimated: true as const }
                : undefined),
            },
          }))
        : []),
      done,
    ],
    { activity: "preserve" },
  );
  if (written.length === 0 && includeObservations) {
    const previous = await store.loadByIdempotencyKey(
      conversationId,
      done.idempotencyKey,
    );
    if (previous?.data.type === "distillation_batch_done") {
      return previous.data.outcome;
    }
    await store.append(
      conversationId,
      [{ ...done, data: { ...done.data, outcome: "failed" } }],
      { activity: "preserve" },
    );
  }
  return includeObservations && written.length > 0 ? "processed" : "failed";
}

/** Submit bounded segments and persist the reference before polling. */
export async function startObservationBatch(args: {
  context: Pick<PluginTaskContext, "requeue">;
  conversationId: string;
  historyVersion: number;
  segments: readonly HistoryEntry[][];
  previousObservations?: string;
  store: ConversationEventStore;
  client?: Pick<typeof gatewayObservationBatch, "submit">;
}): Promise<"started" | "unavailable"> {
  const selected: {
    bytes: number;
    requests: ObservationRequest[];
    segments: HistoryEntry[][];
  } = { bytes: 0, requests: [], segments: [] };
  for (const segment of args.segments) {
    const request = {
      id: `segment:${segment[0]!.seq}:${segment.at(-1)!.seq}`,
      system: DISTILLATION_SYSTEM,
      prompt: distillationUser({
        date: new Date(segment[0]!.message.timestamp)
          .toISOString()
          .slice(0, 10),
        messages: renderSegment(segment),
        ...(args.previousObservations
          ? { priorObservations: args.previousObservations }
          : undefined),
      }),
    };
    const bytes = Buffer.byteLength(JSON.stringify(request)) + 1_024;
    if (selected.bytes + bytes > MAX_BATCH_INPUT_BYTES) break;
    selected.requests.push(request);
    selected.segments.push(segment);
    selected.bytes += bytes;
  }
  if (selected.requests.length === 0) return "unavailable";
  const { requests } = selected;
  const batch = await (args.client ?? gatewayObservationBatch)
    .submit({
      conversationId: args.conversationId,
      historyVersion: args.historyVersion,
      requests,
    })
    .catch((error: unknown) => {
      if (
        UnsupportedFunctionalityError.isInstance(error) ||
        (APICallError.isInstance(error) &&
          [404, 405].includes(error.statusCode ?? 0))
      ) {
        return undefined;
      }
      throw error;
    });
  if (!batch) return "unavailable";
  const written = await args.store.append(
    args.conversationId,
    [
      {
        createdAtMs: Date.now(),
        idempotencyKey: `distillation:batch:${args.historyVersion}:${requests.map((request) => request.id).join(":")}`,
        data: {
          type: "distillation_batch",
          sourceHistoryVersion: args.historyVersion,
          batchId: batch.id,
          provider: batch.provider,
          requests: selected.segments.map((segment, index) => ({
            id: requests[index]!.id,
            fromSeq: segment[0]!.seq,
            throughSeq: segment.at(-1)!.seq,
          })),
        },
      },
    ],
    { activity: "preserve" },
  );
  if (written.length === 0) return "started";
  if (!args.context.requeue) {
    throw new Error("Observation batch polling is unavailable");
  }
  await args.context.requeue(BATCH_POLL_SECONDS);
  return "started";
}

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

async function consolidate(
  conversationId: string,
  historyVersion: number,
): Promise<void> {
  const store = getConversationEventStore();
  const records = activeDistillations(
    await store.loadCurrentHistory(conversationId),
  );
  const meta = records.find((record) => record.data.generation === 1);
  const newSegments = records.filter((record) => record.data.generation === 0);
  // Keep the newest two segments raw so new facts do not rewrite an
  // established summary each time the worker runs.
  const toMerge = newSegments.slice(0, -2);
  if (toMerge.length < 3) return;
  const fromSeq = meta?.data.fromSeq ?? toMerge[0]!.data.fromSeq;
  const throughSeq = toMerge.at(-1)!.data.throughSeq;
  const observed = await observe({
    conversationId,
    system: CONSOLIDATION_SYSTEM,
    input: consolidationUser({
      ...(meta ? { previousMeta: meta.data.observations } : undefined),
      segments: toMerge.map((record) => record.data.observations),
    }),
    promptName: "junior.context_consolidation",
  });
  await store.append(
    conversationId,
    [
      {
        createdAtMs: Date.now(),
        idempotencyKey: `distillation:1:${historyVersion}:${fromSeq}:${throughSeq}`,
        data: {
          type: "distillation",
          generation: 1,
          sourceHistoryVersion: historyVersion,
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
}

function workerIsWorthRunning(
  entries: readonly HistoryEntry[],
  modelId: string,
  expectedCalls: number,
  conversationId: string,
  batched: boolean,
): boolean {
  const rawTokens = estimateModelVisibleTokens(
    entries.map((entry) => entry.message),
  );
  // The worker is bounded to twelve segments per Turn. Price the full eligible
  // prefix, not only this batch, or a long Turn could never start distilling.
  const removedTokens = Math.max(0, rawTokens - 20_000);
  const replacementTokens =
    rawTokens - removedTokens + Math.ceil(removedTokens / 16_000) * 2_048;
  const observerCost =
    estimateWorkerCost({
      model: resolveGatewayModel(LUNA_MODEL_ID),
      inputTokens: removedTokens,
      outputTokens: Math.ceil(removedTokens / 16_000) * 2_048,
    }) * (batched ? 0.5 : 1);
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
      "gen_ai.conversation.id": conversationId,
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
      const inFlight = pendingBatch(
        await store.loadHistory(run.conversationId),
      );
      const source = distillationSource({
        events,
        profile: botConfig.defaultProfile,
        turnId: run.runId,
      });
      if (!source && !inFlight) {
        logInfo("conversation.distillation.skipped", {
          "gen_ai.conversation.id": run.conversationId,
          "app.distillation.stage": "observer",
          "app.distillation.reason": "no_completed_turn",
        });
        return;
      }
      const batchOutcome = inFlight
        ? await finishBatch({
            batch: inFlight,
            conversationId: run.conversationId,
            store,
          })
        : undefined;
      if (inFlight) {
        if (batchOutcome === "pending") {
          if (!context.requeue) {
            throw new Error("Observation batch polling is unavailable");
          }
          await context.requeue(BATCH_POLL_SECONDS);
          return;
        }
        if (batchOutcome === "processed" && source) {
          await consolidate(run.conversationId, source.historyVersion);
        }
        if (batchOutcome === "failed") return;
      }
      if (!source) return;
      const current = inFlight
        ? distillationSource({
            events: await store.loadCurrentHistory(run.conversationId),
            profile: botConfig.defaultProfile,
            turnId: run.runId,
          })
        : source;
      if (!current) return;
      const segments = pendingSegments(current);
      const failedBatch = (
        inFlight ? await store.loadCurrentHistory(run.conversationId) : events
      ).some(
        (event) =>
          event.data.type === "distillation_batch_done" &&
          event.data.sourceHistoryVersion === current.historyVersion &&
          event.data.outcome === "failed",
      );
      const batchEnabled =
        botConfig.contextDistillationBatchEnabled && !failedBatch;
      const modelId = lastTurnModelId(events, run.runId, current.terminalSeq);
      const futureCalls = expectedContextCalls(
        events.filter((event) => event.seq <= current.terminalSeq),
      );
      if (segments.length === 0 || !modelId) {
        logInfo("conversation.distillation.skipped", {
          "gen_ai.conversation.id": run.conversationId,
          "app.distillation.stage": "observer",
          "app.distillation.reason":
            segments.length === 0 ? "no_safe_segment" : "no_model",
          "app.distillation.raw_tokens": estimateModelVisibleTokens(
            current.entries.map((entry) => entry.message),
          ),
          "app.distillation.expected_calls": futureCalls,
        });
        return;
      }
      if (
        !workerIsWorthRunning(
          current.entries,
          modelId,
          futureCalls,
          run.conversationId,
          batchEnabled,
        )
      ) {
        return;
      }

      const previousObservations = current.events.at(-1)?.data.observations
        ? [current.events.at(-1)!.data.observations]
        : [];
      if (batchEnabled) {
        const outcome = await startObservationBatch({
          context,
          conversationId: run.conversationId,
          historyVersion: current.historyVersion,
          segments,
          previousObservations: previousObservations.at(-1),
          store,
        });
        if (outcome === "started") return;
        if (outcome === "unavailable") {
          if (
            !workerIsWorthRunning(
              current.entries,
              modelId,
              futureCalls,
              run.conversationId,
              false,
            )
          ) {
            return;
          }
        }
      }
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
              idempotencyKey: `distillation:0:${current.historyVersion}:${fromSeq}:${throughSeq}`,
              data: {
                type: "distillation",
                generation: 0,
                sourceHistoryVersion: current.historyVersion,
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

      await consolidate(run.conversationId, current.historyVersion);
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
