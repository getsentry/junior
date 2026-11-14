/**
 * Background compaction: prepare a summary before the history is full.
 *
 * After each model request at or above the mark, also in the middle of a
 * Turn, the Turn appends `compaction_requested` and sends a job. The job
 * asks the agent model for a summary of the history up to the marked event
 * and appends `compaction_prepared`. Turns keep the full history until a later
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
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { Tool } from "@earendil-works/pi-ai";
import {
  buildAgentModelRequest,
  CONTEXT_COMPACTION_PROMPT_NAME,
  ContextSummaryError,
  requestContextSummary,
  type ContextSummary,
} from "@/chat/agent/context-summary";
import {
  runWithConversationPrivacy,
  type ConversationPrivacy,
} from "@/chat/conversation-privacy";
import type { ConversationEvent } from "@/chat/conversations/history";
import { getConversationEventStore } from "@/chat/db";
import { logWarn, setSpanAttributes, withLogContext } from "@/chat/logging";
import {
  readAgentHistory,
  type AgentRequestStreamFn,
  withAgentRequest,
} from "@/chat/pi/agent-history";
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
 * Failed attempts for one History version before background tries stop.
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
export function lastRequestInputSize(
  messages: AgentMessage[],
): number | undefined {
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
 * version. It may not while a request is pending, while a ready summary
 * waits for the compaction threshold, or after the attempt limit.
 */
function mayRequest(
  events: ConversationEvent[],
  historyVersion: number,
  nowMs: number,
): boolean {
  const outcomes = new Map<number, "ready" | "failed">();
  for (const event of events) {
    if (
      event.data.type === "compaction_prepared" &&
      event.data.historyVersion === historyVersion
    ) {
      outcomes.set(event.data.markSeq, event.data.outcome);
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
    if (prepared === "ready") {
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
 * Find the newest background compaction fact of the current History version.
 * Facts of earlier versions belong to history that a replacement already
 * removed.
 */
export async function loadLatestBackgroundCompaction(conversationId: string) {
  const store = getConversationEventStore();
  const [historyVersion, page] = await Promise.all([
    store.loadCurrentHistoryVersion(conversationId),
    store.query(conversationId, {
      limit: 1,
      types: ["compaction_requested", "compaction_prepared"],
    }),
  ]);
  const event = page.events.at(-1);
  return event && event.historyVersion === historyVersion
    ? { event, historyVersion }
    : undefined;
}

/**
 * Return whether the newest fact is a pending request or a ready summary.
 * Then `mayRequest` is false too, so a Turn can skip the other reads.
 * Only one request is pending at a time, so the newest fact decides it.
 */
function waitsForUse(event: ConversationEvent, nowMs: number): boolean {
  if (event.data.type === "compaction_requested") {
    return nowMs - event.createdAtMs < REQUEST_TIMEOUT_MS;
  }
  return (
    event.data.type === "compaction_prepared" && event.data.outcome === "ready"
  );
}

/**
 * Request a background summary when the model request that just ended was at
 * or above the mark.
 *
 * The agent runs it after each model request, so a long Turn gets a summary
 * before the compaction threshold. Without a queue or below the mark, it does
 * nothing. A failure here leaves blocking compaction as the fallback, so it
 * is logged and does not fail the Turn. When the send fails after the request
 * is written, the request times out and counts as a failed attempt.
 */
export async function requestBackgroundCompaction(args: {
  agent: Agent;
  conversationId: string;
  conversationPrivacy: ConversationPrivacy | undefined;
  modelId: string;
  queue: BackgroundCompactionQueue | undefined;
}): Promise<void> {
  if (!args.queue) {
    return;
  }
  const inputSize = lastRequestInputSize(
    readAgentHistory(args.agent.state.messages),
  );
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
  queue: BackgroundCompactionQueue;
}): Promise<void> {
  const nowMs = Date.now();
  const eventStore = getConversationEventStore();
  // Each later model request of a large Turn checks again. Read only the
  // newest fact while a request waits, and only background compaction facts
  // to count failed attempts. Without a fact of this History version, no
  // attempt exists yet.
  const latest = await loadLatestBackgroundCompaction(args.conversationId);
  if (latest) {
    if (waitsForUse(latest.event, nowMs)) {
      return;
    }
    const facts = await Promise.all([
      eventStore.loadEventsOfType(args.conversationId, "compaction_requested"),
      eventStore.loadEventsOfType(args.conversationId, "compaction_prepared"),
    ]);
    if (!mayRequest(facts.flat(), latest.historyVersion, nowMs)) {
      return;
    }
  }
  // Load the full history only to write a request: the mark comes from its
  // projection. Check again on it, because another Turn or a replacement
  // can write between the reads.
  const events = await eventStore.loadCurrentHistory(args.conversationId);
  const historyVersion = events[0]?.historyVersion;
  if (
    historyVersion === undefined ||
    !mayRequest(events, historyVersion, nowMs)
  ) {
    return;
  }
  const projection = projectConversationEvents(events);
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
}

/** A fixed label for a failed summary. Never raw exception text. */
function failureLabel(error: unknown, signal: AbortSignal): string {
  if (signal.aborted) {
    return "timeout";
  }
  if (
    error instanceof ContextSummaryError &&
    error.failure !== "request_failed"
  ) {
    return error.failure;
  }
  const providerError = findProviderError(error);
  return providerError ? `provider_${providerError.kind}` : "summary_error";
}

/**
 * `app.compaction.outcome` of a job. `stale`: the History was replaced before
 * the job ran. `duplicate`: the request already has a result. Both write
 * nothing. A `failed` job sets `error.type` to its failure label.
 */
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
  options: { enqueuedAtMs?: number; streamFn?: AgentRequestStreamFn } = {},
): Promise<void> {
  const startedAtMs = Date.now();
  await withLogContext({ conversationId: message.conversationId }, () =>
    withCompactionSpan("background", "summary", async () => {
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
  streamFn: AgentRequestStreamFn | undefined,
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
      | { outcome: "ready"; summary: string; costUsd?: number }
      | { outcome: "failed"; errorType: string; costUsd?: number },
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
    maxSeq: message.markSeq,
  });

  const signal = AbortSignal.timeout(remainingMs);
  let summary: ContextSummary;
  try {
    summary = await runWithConversationPrivacy(
      snapshot.conversationPrivacy,
      async () => {
        const summaryStreamFn = createTracedStreamFn({
          conversationPrivacy: snapshot.conversationPrivacy,
          promptName: CONTEXT_COMPACTION_PROMPT_NAME,
          ...(streamFn ? { base: streamFn } : undefined),
        });
        const tools = snapshot.tools.map((tool) => ({
          ...tool,
          execute: async () => {
            throw new Error("Background compaction does not run tools");
          },
        }));
        // The live agent sets only these request options. Keep them equal,
        // or the request prefix differs and the provider cache misses.
        const agent = new Agent({
          getApiKey: getGatewayApiKey,
          sessionId: message.conversationId,
          streamFn: withAgentRequest(summaryStreamFn, {
            systemPrompt: snapshot.systemPrompt,
            tools,
          }),
          initialState: {
            systemPrompt: snapshot.systemPrompt,
            model: resolveGatewayModel(snapshot.modelId),
            thinkingLevel: snapshot.thinkingLevel,
            tools,
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
      ...(error instanceof ContextSummaryError && error.costUsd !== undefined
        ? { costUsd: error.costUsd }
        : undefined),
    });
  }
  const outcome = await writePrepared({ outcome: "ready", ...summary });
  if (outcome === "ready") {
    setSpanAttributes({
      "app.compaction.summary_chars": summary.summary.length,
      "app.compaction.ready_ms": Date.now() - request.createdAtMs,
    });
  }
  return outcome;
}
