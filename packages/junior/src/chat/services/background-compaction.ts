/**
 * Background compaction: prepare a summary before the history is full.
 *
 * When a Turn completes and its last model request was at or above the mark,
 * the Turn appends `compaction_requested` and sends a job. The job asks the
 * agent model for a summary of the history up to the marked event and
 * appends `compaction_prepared`. Turns keep the full history until a later
 * change swaps the summary in. Blocking compaction stays the fallback.
 *
 * The summary request repeats the system prompt and tools of the last agent
 * request, so the provider can read its cached prompt prefix. The job runs in
 * another request, so the Turn stores them in the State adapter.
 */
import {
  Agent,
  type AgentMessage,
  type AgentTool,
  type StreamFn,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { Tool } from "@earendil-works/pi-ai";
import {
  buildAgentModelRequest,
  CONTEXT_COMPACTION_PROMPT_NAME,
  ContextSummaryError,
  requestContextSummary,
} from "@/chat/agent/context-summary";
import { botConfig } from "@/chat/config";
import {
  runWithConversationPrivacy,
  type ConversationPrivacy,
} from "@/chat/conversation-privacy";
import type { ConversationEvent } from "@/chat/conversations/history";
import { getConversationEventStore } from "@/chat/db";
import {
  logInfo,
  logWarn,
  setSpanAttributes,
  withLogContext,
} from "@/chat/logging";
import type { ModelProfile } from "@/chat/model-profile";
import { getGatewayApiKey, resolveGatewayModel } from "@/chat/pi/client";
import { projectConversationEvents } from "@/chat/pi/conversation-events";
import { createTracedStreamFn } from "@/chat/pi/traced-stream";
import { QUEUE_SIGNATURE_MAX_AGE_MS } from "@/chat/queue/sign";
import { getAgentBackgroundCompactionMarkTokens } from "@/chat/services/context-budget";
import { withCompactionSpan } from "@/chat/services/context-compaction-telemetry";
import { findProviderError } from "@/chat/services/provider-error";
import { getStateAdapter } from "@/chat/state/adapter";
import {
  backgroundCompactionId,
  type BackgroundCompactionMessage,
  type BackgroundCompactionQueue,
} from "./background-compaction-queue";

/**
 * Failed or discarded attempts for one History version before background
 * tries stop.
 */
const MAX_FAILED_ATTEMPTS = 2;
/**
 * A request without a prepared result after this long counts as a failed
 * attempt, so a later Turn can request again. This covers a lost job.
 */
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
/** The queue drops a message after this long, so the snapshot can go too. */
const SNAPSHOT_TTL_MS = QUEUE_SIGNATURE_MAX_AGE_MS;

/** What the job needs from the Turn to repeat its request prefix. */
interface RequestSnapshot {
  conversationPrivacy: ConversationPrivacy;
  /** Provider-reported input of the last model request. */
  inputSize: number;
  modelId: string;
  systemPrompt: string;
  thinkingLevel: ThinkingLevel;
  tools: Array<
    Pick<AgentTool, "constrainedSampling" | "description" | "label" | "name"> &
      Pick<Tool, "parameters">
  >;
}

function snapshotKey(message: BackgroundCompactionMessage): string {
  return `${backgroundCompactionId(message)}:snapshot`;
}

/** Provider-reported input of the last model request, cache included. */
function lastRequestInputSize(messages: AgentMessage[]): number | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "assistant") {
      const { input, cacheRead, cacheWrite } = message.usage;
      return input + cacheRead + cacheWrite;
    }
  }
  return undefined;
}

/**
 * Return whether a Turn may request a background summary for this History
 * version. It may not while a request is pending, while a ready summary is
 * still unused, or after the attempt limit.
 *
 * A Turn swaps a ready summary in before its first model request. A swap
 * makes a new History version. So a ready summary of this version that was
 * prepared before the Turn started was discarded, for example because the
 * history after its mark is too large now. It counts as a failed attempt, so
 * a new request can replace it.
 */
function mayRequest(
  events: ConversationEvent[],
  historyVersion: number,
  nowMs: number,
  turnStartedAtMs: number,
): boolean {
  const outcomes = new Map<
    number,
    { outcome: "ready" | "failed"; createdAtMs: number }
  >();
  for (const event of events) {
    if (
      event.data.type === "compaction_prepared" &&
      event.data.historyVersion === historyVersion
    ) {
      outcomes.set(event.data.markSeq, {
        outcome: event.data.outcome,
        createdAtMs: event.createdAtMs,
      });
    }
  }
  let failed = 0;
  for (const event of events) {
    if (
      event.data.type !== "compaction_requested" ||
      event.data.historyVersion !== historyVersion
    ) {
      continue;
    }
    const prepared = outcomes.get(event.data.markSeq);
    if (
      prepared?.outcome === "ready" &&
      prepared.createdAtMs >= turnStartedAtMs
    ) {
      return false;
    }
    if (prepared || nowMs - event.createdAtMs >= REQUEST_TIMEOUT_MS) {
      failed += 1;
    } else {
      return false;
    }
  }
  return failed < MAX_FAILED_ATTEMPTS;
}

/**
 * Request a background summary when the last model request of a completed
 * Turn was at or above the mark.
 *
 * `turnStartedAtMs` is when this execution slice started, before its first
 * model request. Without a queue or below the mark, it does nothing. A failure here leaves
 * blocking compaction as the fallback, so it is logged and does not fail the
 * Turn. When the send fails after the request is written, the request times
 * out and counts as a failed attempt.
 */
export async function requestBackgroundCompaction(args: {
  agent: Agent;
  conversationId: string;
  conversationPrivacy: ConversationPrivacy | undefined;
  modelId: string;
  modelProfile: ModelProfile;
  queue: BackgroundCompactionQueue | undefined;
  turnStartedAtMs: number;
}): Promise<void> {
  if (!args.queue) {
    return;
  }
  const inputSize = lastRequestInputSize(args.agent.state.messages);
  if (
    inputSize === undefined ||
    inputSize < getAgentBackgroundCompactionMarkTokens(args.modelId)
  ) {
    return;
  }
  try {
    await requestAboveMark({ ...args, inputSize, queue: args.queue });
  } catch (error) {
    logWarn("context_compaction.background.request_failed", {
      "error.type": error instanceof Error ? error.name : typeof error,
    });
  }
}

async function requestAboveMark(args: {
  agent: Agent;
  conversationId: string;
  conversationPrivacy: ConversationPrivacy | undefined;
  inputSize: number;
  modelId: string;
  modelProfile: ModelProfile;
  queue: BackgroundCompactionQueue;
  turnStartedAtMs: number;
}): Promise<void> {
  const nowMs = Date.now();
  const eventStore = getConversationEventStore();
  const events = await eventStore.loadCurrentHistory(args.conversationId);
  const historyVersion = events[0]?.historyVersion;
  if (
    historyVersion === undefined ||
    !mayRequest(events, historyVersion, nowMs, args.turnStartedAtMs)
  ) {
    return;
  }
  const projection = projectConversationEvents(events, {
    defaultProfile: botConfig.defaultProfile,
  });
  // Messages of a replacement carry the seqs of their source events, which
  // are older than the replacement event. The job reads events up to the
  // mark, so the mark must not fall before the replacement.
  const markSeq = Math.max(
    projection.seqs.at(-1) ?? -1,
    projection.replacementSeq ?? -1,
  );
  if (markSeq < 0) {
    return;
  }

  const message = {
    conversationId: args.conversationId,
    historyVersion,
    markSeq,
  };
  const { systemPrompt, thinkingLevel, tools } = args.agent.state;
  const snapshot: RequestSnapshot = {
    // Unknown privacy is private, as in the Turn.
    conversationPrivacy: args.conversationPrivacy ?? "private",
    inputSize: args.inputSize,
    modelId: args.modelId,
    systemPrompt,
    thinkingLevel,
    // The provider request reads only these fields of a tool.
    tools: tools.map((tool) => ({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      parameters: tool.parameters,
      ...(tool.constrainedSampling === undefined
        ? undefined
        : { constrainedSampling: tool.constrainedSampling }),
    })),
  };
  // Write the snapshot first: the job can run as soon as the request exists.
  await getStateAdapter().set(
    snapshotKey(message),
    JSON.parse(JSON.stringify(snapshot)),
    SNAPSHOT_TTL_MS,
  );
  const appended = await eventStore.append(
    args.conversationId,
    [
      {
        idempotencyKey: `${backgroundCompactionId(message)}:requested`,
        createdAtMs: nowMs,
        data: {
          type: "compaction_requested",
          markSeq,
          historyVersion,
          modelProfile: args.modelProfile,
          modelId: args.modelId,
        },
      },
    ],
    { activity: "preserve" },
  );
  // Another Turn wrote the same request and sent its job.
  if (appended.length === 0) {
    return;
  }
  await args.queue.send(message);
  logInfo("context_compaction.background.requested", {
    "app.compaction.mark_seq": markSeq,
    "app.compaction.history_version": historyVersion,
    "app.compaction.input.size": args.inputSize,
  });
}

/** A fixed label for a failed summary. Never raw exception text. */
function failureLabel(error: unknown, signal: AbortSignal): string {
  if (signal.aborted) {
    return "timeout";
  }
  if (error instanceof ContextSummaryError) {
    return error.failure;
  }
  const providerError = findProviderError(error);
  return providerError ? `provider_${providerError.kind}` : "summary_error";
}

type JobOutcome = "ready" | "failed" | "stale" | "duplicate";

/**
 * Run one background compaction job.
 *
 * It writes `compaction_prepared` once for the request, with a summary or a
 * fixed failure label. It writes nothing when the request is no longer in
 * the current History version, because no Turn could use the summary.
 * `streamFn` replaces the model stream, for tests.
 */
export async function processBackgroundCompaction(
  message: BackgroundCompactionMessage,
  options: { enqueuedAtMs?: number; streamFn?: StreamFn } = {},
): Promise<void> {
  const startedAtMs = Date.now();
  await withLogContext({ conversationId: message.conversationId }, () =>
    withCompactionSpan("background", async () => {
      setSpanAttributes({
        "app.compaction.mark_seq": message.markSeq,
        "app.compaction.history_version": message.historyVersion,
        ...(options.enqueuedAtMs === undefined
          ? undefined
          : {
              "app.compaction.queue_wait_ms": Math.max(
                0,
                startedAtMs - options.enqueuedAtMs,
              ),
            }),
      });
      const outcome = await prepareSummary(message, options.streamFn);
      setSpanAttributes({ "app.compaction.outcome": outcome });
    }),
  );
}

async function prepareSummary(
  message: BackgroundCompactionMessage,
  streamFn: StreamFn | undefined,
): Promise<JobOutcome> {
  const eventStore = getConversationEventStore();
  const state = getStateAdapter();
  const events = await eventStore.loadCurrentHistory(message.conversationId);
  const isThisRequest = (event: ConversationEvent) =>
    (event.data.type === "compaction_requested" ||
      event.data.type === "compaction_prepared") &&
    event.data.historyVersion === message.historyVersion &&
    event.data.markSeq === message.markSeq;
  const request = events.find(
    (event) =>
      isThisRequest(event) && event.data.type === "compaction_requested",
  );
  // The history was replaced since the request.
  if (request?.data.type !== "compaction_requested") {
    await state.delete(snapshotKey(message));
    return "stale";
  }
  const requested = request.data;
  if (
    events.some(
      (event) =>
        isThisRequest(event) && event.data.type === "compaction_prepared",
    )
  ) {
    return "duplicate";
  }

  // Write the result once. The history can be replaced while the summary
  // call runs, so check the History version again first. A replacement
  // between this check and the append is still possible; readers match
  // `historyVersion`, so that event is never used.
  const writePrepared = async (
    result:
      | { outcome: "ready"; summary: string }
      | { outcome: "failed"; errorType: string },
  ): Promise<JobOutcome> => {
    const currentVersion = await eventStore.loadCurrentHistoryVersion(
      message.conversationId,
    );
    if (currentVersion !== message.historyVersion) {
      await state.delete(snapshotKey(message));
      return "stale";
    }
    await eventStore.append(
      message.conversationId,
      [
        {
          idempotencyKey: `${backgroundCompactionId(message)}:prepared`,
          createdAtMs: Date.now(),
          data: {
            type: "compaction_prepared",
            markSeq: message.markSeq,
            historyVersion: message.historyVersion,
            modelProfile: requested.modelProfile,
            modelId: requested.modelId,
            ...result,
          },
        },
      ],
      { activity: "preserve" },
    );
    await state.delete(snapshotKey(message));
    if (result.outcome === "failed") {
      setSpanAttributes({ "error.type": result.errorType });
    }
    return result.outcome;
  };

  const remainingMs = request.createdAtMs + REQUEST_TIMEOUT_MS - Date.now();
  if (remainingMs <= 0) {
    return await writePrepared({ outcome: "failed", errorType: "timeout" });
  }
  const snapshot = await state.get<RequestSnapshot>(snapshotKey(message));
  if (!snapshot) {
    return await writePrepared({
      outcome: "failed",
      errorType: "snapshot_missing",
    });
  }
  setSpanAttributes({ "app.compaction.input.size": snapshot.inputSize });
  const projection = projectConversationEvents(events, {
    defaultProfile: botConfig.defaultProfile,
    maxSeq: message.markSeq,
  });

  const signal = AbortSignal.timeout(remainingMs);
  let summary: string;
  try {
    summary = await runWithConversationPrivacy(
      snapshot.conversationPrivacy,
      async () => {
        const summaryStreamFn = createTracedStreamFn({
          conversationPrivacy: snapshot.conversationPrivacy,
          promptName: CONTEXT_COMPACTION_PROMPT_NAME,
          ...(streamFn ? { base: streamFn } : undefined),
        });
        // The live agent sets only these request options. Keep them equal,
        // or the request prefix differs and the provider cache misses.
        const agent = new Agent({
          getApiKey: getGatewayApiKey,
          sessionId: message.conversationId,
          streamFn: summaryStreamFn,
          initialState: {
            systemPrompt: snapshot.systemPrompt,
            model: resolveGatewayModel(snapshot.modelId),
            thinkingLevel: snapshot.thinkingLevel,
            tools: snapshot.tools.map((tool) => ({
              ...tool,
              execute: async () => {
                throw new Error("Background compaction does not run tools");
              },
            })),
          },
        });
        return await requestContextSummary(
          await buildAgentModelRequest(agent, projection.messages, signal),
          summaryStreamFn,
        );
      },
    );
  } catch (error) {
    return await writePrepared({
      outcome: "failed",
      errorType: failureLabel(error, signal),
    });
  }
  const outcome = await writePrepared({ outcome: "ready", summary });
  if (outcome === "ready") {
    setSpanAttributes({
      "app.compaction.summary_chars": summary.length,
      "app.compaction.ready_ms": Date.now() - request.createdAtMs,
    });
  }
  return outcome;
}
