/**
 * Prepared-summary swap.
 *
 * A background job writes `compaction_prepared` with a summary of the history
 * up to `markSeq`. The Turn swaps it in without a model call: retained user
 * messages, the summary, then every message after the mark. A swap runs only
 * above the compaction threshold, at Turn start or between model calls, in
 * place of a blocking summary call. Below it, a swap would only rewrite the
 * provider's prompt cache. A summary that no longer matches the history is
 * discarded, and the Turn carries on as if none existed.
 *
 * A summary that is still running replaces the blocking summary too, for a
 * limited time from its request. Below the input limit, the Turn defers: the
 * next model call gets the full history, and a later check swaps the summary
 * in. At the input limit, the Turn polls for it. The time counts from the
 * durable request, so a yield or a new request does not reset it.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { getConversationEventStore } from "@/chat/db";
import type { ConversationEvent } from "@/chat/conversations/history";
import { loadConversationProjection } from "@/chat/conversations/projection";
import {
  contextProvenance,
  type ConversationMessageProvenance,
} from "@/chat/conversations/provenance";
import { setSpanAttributes } from "@/chat/logging";
import { loadLatestBackgroundCompaction } from "@/chat/services/background-compaction";
import { historyItemFromPiMessage } from "@/chat/pi/conversation-events";
import type { PiMessage } from "@/chat/pi/messages";
import type { ContextSummary } from "@/chat/agent/context-summary";
import { trimTrailingAssistantMessages } from "@/chat/pi/transcript";
import {
  calculateContextCompactionTargetTokens,
  getAgentContextCompactionTriggerTokens,
  getAgentContextInputLimitTokens,
} from "@/chat/services/context-budget";
import {
  compactActiveContextIfNeeded,
  estimateHistoryTokens,
  estimateReplacementTokens,
  renderCompactionSummary,
  selectRetainedUserMessageEntries,
  summarizedRuntimeContextMessage,
  userMessage,
  type ActiveContextCompactionArgs,
  type CompactContextResult,
} from "@/chat/services/context-compaction";
import { withCompactionSpan } from "@/chat/services/context-compaction-telemetry";
import { appendOpenPlan } from "@/chat/services/plan-continuation";
import { trimToolResults } from "@/chat/services/tool-result-trimming";

/** How long after its request a running summary replaces a blocking one. */
const RUNNING_SUMMARY_WAIT_MS = 45_000;
const RUNNING_SUMMARY_POLL_MS = 1_000;

type LatestBackgroundCompaction = NonNullable<
  Awaited<ReturnType<typeof loadLatestBackgroundCompaction>>
>;

type PreparedCompaction = Extract<
  ConversationEvent["data"],
  { type: "compaction_prepared"; outcome: "ready" }
>;

/**
 * Why a ready summary was not used (`app.compaction.discard_reason`).
 * `conflict`: another replacement committed first. `split_tool_call`: the
 * mark falls between a tool call and its result.
 */
type DiscardReason =
  | "conflict"
  | "history_version_changed"
  | "over_target"
  | "split_tool_call";

interface ReplacementEntry {
  message: PiMessage;
  provenance: ConversationMessageProvenance;
  sourceEventSeq?: number | undefined;
}

/** Compare a message across a durable commit, which drops undefined fields. */
function durableIdentity(message: PiMessage): unknown {
  const { role, timestamp, content, toolCallId } = message as {
    role?: unknown;
    timestamp?: unknown;
    content?: unknown;
    toolCallId?: unknown;
  };
  return JSON.parse(JSON.stringify({ role, timestamp, content, toolCallId }));
}

function committedPrefixLength(
  messages: PiMessage[],
  committed: PiMessage[],
): number {
  const limit = Math.min(messages.length, committed.length);
  for (let index = 0; index < limit; index += 1) {
    if (
      !isDeepStrictEqual(
        durableIdentity(messages[index]!),
        durableIdentity(committed[index]!),
      )
    ) {
      return index;
    }
  }
  return limit;
}

function discard(reason: DiscardReason): CompactContextResult {
  setSpanAttributes({
    "app.compaction.outcome": "discarded",
    "app.compaction.discard_reason": reason,
  });
  return { compacted: false };
}

/**
 * Swap a ready prepared summary into history, defer to one that is still
 * running, or run today's capacity compaction when none can be used.
 */
export async function compactWithPreparedSummary(
  args: ActiveContextCompactionArgs,
  summarize: (
    messages: PiMessage[],
    signal?: AbortSignal,
  ) => Promise<ContextSummary>,
): Promise<CompactContextResult> {
  const swapped = await swapPreparedCompaction(args);
  // After a conflict the active messages are stale. A blocking summary
  // would write them over the other replacement. A deferred swap waits for
  // the running summary instead.
  if (
    swapped.compacted ||
    swapped.reason === "history_conflict" ||
    swapped.reason === "deferred"
  ) {
    return swapped;
  }
  return await compactActiveContextIfNeeded(args, summarize);
}

/**
 * Poll until the running summary of `request` has a result, the History
 * changes, or the wait ends. Return the newest fact at that time.
 */
async function waitForRunningSummary(
  conversationId: string,
  request: LatestBackgroundCompaction,
  waitUntilMs: number,
  signal: AbortSignal | undefined,
): Promise<LatestBackgroundCompaction | undefined> {
  let latest: LatestBackgroundCompaction | undefined = request;
  while (latest?.event.seq === request.event.seq && Date.now() < waitUntilMs) {
    await sleep(
      Math.min(RUNNING_SUMMARY_POLL_MS, waitUntilMs - Date.now()),
      undefined,
      { signal },
    );
    latest = await loadLatestBackgroundCompaction(conversationId);
  }
  return latest;
}

/**
 * Replace history above the compaction threshold with a ready prepared
 * summary, or defer to one that is still running.
 */
async function swapPreparedCompaction(
  args: ActiveContextCompactionArgs,
): Promise<CompactContextResult> {
  const pendingMessages = args.pendingMessages ?? [];
  const sourceMessages = [
    ...args.piMessages,
    ...pendingMessages.map((entry) => entry.message),
  ];
  const triggerTokens = getAgentContextCompactionTriggerTokens(args.modelId);
  const estimatedTokens = estimateHistoryTokens(
    sourceMessages,
    args.modelId,
    args.requestOverheadTokens,
  );
  if (estimatedTokens <= triggerTokens) {
    return { compacted: false, reason: "below_threshold" };
  }
  const first = await loadLatestBackgroundCompaction(args.conversationId);
  if (!first) {
    return { compacted: false };
  }
  return await withCompactionSpan(args.mode, "swap", async () => {
    let latest: LatestBackgroundCompaction | undefined = first;
    if (first.event.data.type === "compaction_requested") {
      const waitUntilMs = first.event.createdAtMs + RUNNING_SUMMARY_WAIT_MS;
      setSpanAttributes({
        "app.compaction.request.age_ms": Math.max(
          0,
          Date.now() - first.event.createdAtMs,
        ),
      });
      if (Date.now() < waitUntilMs) {
        if (estimatedTokens < getAgentContextInputLimitTokens(args.modelId)) {
          setSpanAttributes({ "app.compaction.outcome": "deferred" });
          return { compacted: false, reason: "deferred" };
        }
        await args.onCompactionStart?.();
        latest = await waitForRunningSummary(
          args.conversationId,
          first,
          waitUntilMs,
          args.signal,
        );
        setSpanAttributes({
          "app.compaction.wait.timed_out":
            latest?.event.seq === first.event.seq,
        });
        // Another replacement committed during the wait, so the active
        // messages are stale. A swap or a blocking summary would write them
        // over the newer history.
        if (latest?.historyVersion !== first.historyVersion) {
          return {
            ...discard("history_version_changed"),
            reason: "history_conflict",
          };
        }
      }
    }
    const prepared = latest?.event.data;
    if (
      !latest ||
      prepared?.type !== "compaction_prepared" ||
      prepared.outcome !== "ready"
    ) {
      // The request is older than the wait, the job failed, or the wait
      // ended. A blocking compaction can still follow at the threshold.
      setSpanAttributes({ "app.compaction.outcome": "not_ready" });
      return { compacted: false };
    }
    const { event, historyVersion } = latest;
    setSpanAttributes({
      "app.compaction.prepared.age_ms": Math.max(
        0,
        Date.now() - event.createdAtMs,
      ),
    });
    if (prepared.historyVersion !== historyVersion) {
      return discard("history_version_changed");
    }
    return await applyPreparedSummary(args, prepared, {
      estimatedTokens,
      historyVersion,
      triggerTokens,
    });
  });
}

async function applyPreparedSummary(
  args: ActiveContextCompactionArgs,
  prepared: PreparedCompaction,
  budget: {
    estimatedTokens: number;
    historyVersion: number;
    triggerTokens: number;
  },
): Promise<CompactContextResult> {
  const pendingMessages = args.pendingMessages ?? [];
  const projection = await loadConversationProjection({
    conversationId: args.conversationId,
  });
  // The committed history is a prefix of the active messages. Only that
  // prefix has source events, so the mark is found there.
  const committedLength = committedPrefixLength(
    args.piMessages,
    projection.messages,
  );
  const firstAfterMark = projection.seqs
    .slice(0, committedLength)
    .findIndex((seq) => seq > prepared.markSeq);
  const markIndex = firstAfterMark === -1 ? committedLength : firstAfterMark;
  const summarized = args.piMessages.slice(0, markIndex);
  const kept = args.piMessages.slice(markIndex);
  // A tool result must follow its call. A mark between them is not a safe cut.
  if ((kept[0] as { role?: unknown } | undefined)?.role === "toolResult") {
    return discard("split_tool_call");
  }

  const retained: ReplacementEntry[] = selectRetainedUserMessageEntries(
    trimTrailingAssistantMessages(summarized),
  ).map((entry) => ({
    message: entry.message,
    provenance: projection.provenance[entry.sourceIndex]!,
    sourceEventSeq: projection.seqs[entry.sourceIndex],
  }));
  const contextMessage = summarizedRuntimeContextMessage(summarized, [
    ...kept,
    ...pendingMessages.map((entry) => entry.message),
  ]);
  const keptEntries: ReplacementEntry[] = kept.map((message, offset) => {
    const index = markIndex + offset;
    return index < committedLength
      ? {
          message,
          provenance: projection.provenance[index]!,
          sourceEventSeq: projection.seqs[index],
        }
      : { message, provenance: contextProvenance };
  });
  const { entries: trimmedEntries, trimming } = trimToolResults(keptEntries);
  const replacement: ReplacementEntry[] = [
    ...(contextMessage
      ? [{ message: contextMessage, provenance: contextProvenance }]
      : []),
    ...retained,
    {
      message: userMessage(
        appendOpenPlan(renderCompactionSummary(prepared.summary), summarized),
      ),
      provenance: contextProvenance,
    },
    ...trimmedEntries,
    ...pendingMessages,
  ];
  const messages = replacement.map((entry) => entry.message);
  const replacementTokens = estimateReplacementTokens(
    messages,
    args.modelId,
    args.requestOverheadTokens,
  );
  const targetTokens = calculateContextCompactionTargetTokens(
    budget.triggerTokens,
  );
  setSpanAttributes({
    "app.compaction.input.estimate": budget.estimatedTokens,
    "app.compaction.replacement.estimate": replacementTokens,
    "app.compaction.threshold": budget.triggerTokens,
    "app.compaction.carried_messages": kept.length,
    "app.compaction.carried.estimate": estimateReplacementTokens(
      trimmedEntries.map((entry) => entry.message),
      args.modelId,
    ),
    "app.compaction.trimmed_results": trimming.trimmedResults,
    "app.compaction.trimmed_chars": trimming.removedChars,
  });
  if (replacementTokens > targetTokens) {
    return discard("over_target");
  }

  args.signal?.throwIfAborted();
  const result = await getConversationEventStore().replaceHistory(
    args.conversationId,
    {
      createdAtMs: Date.now(),
      data: {
        type: "compaction",
        modelId: args.modelId,
        details: {
          reason: "capacity",
          estimatedInputTokens: budget.estimatedTokens,
          replacementInputTokens: replacementTokens,
          triggerTokens: budget.triggerTokens,
          inputLimitTokens: getAgentContextInputLimitTokens(args.modelId),
          inputMessageCount: args.piMessages.length + pendingMessages.length,
          retainedMessageCount:
            retained.length + kept.length + pendingMessages.length,
          summaryChars: prepared.summary.length,
        },
        summary: prepared.summary,
        replacementHistory: replacement.map((entry) => ({
          item: historyItemFromPiMessage(entry.message, entry.provenance),
          ...(entry.sourceEventSeq === undefined
            ? undefined
            : { sourceEventSeq: entry.sourceEventSeq }),
        })),
      },
    },
    { expectedHistoryVersion: budget.historyVersion },
  );
  if (result.status === "conflict") {
    return { ...discard("conflict"), reason: "history_conflict" };
  }
  setSpanAttributes({
    "app.compaction.outcome": "applied",
    "app.compaction.summary_chars": prepared.summary.length,
  });
  return { compacted: true, piMessages: messages };
}
