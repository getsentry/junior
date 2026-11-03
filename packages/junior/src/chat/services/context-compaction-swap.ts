/**
 * Prepared-summary swap.
 *
 * A background job writes `compaction_prepared` with a summary of the history
 * up to `markSeq`. The Turn swaps it in without a model call: retained user
 * messages, the summary, then every message after the mark. Turn start swaps
 * a ready summary at once. Between model calls, a swap runs only above the
 * compaction threshold, in place of a blocking summary call. A summary that
 * no longer matches the history is discarded, and the Turn carries on as if
 * none existed.
 */
import { isDeepStrictEqual } from "node:util";
import { getConversationEventStore } from "@/chat/db";
import type { ConversationEvent } from "@/chat/conversations/history";
import { loadConversationProjection } from "@/chat/conversations/projection";
import {
  contextProvenance,
  type ConversationMessageProvenance,
} from "@/chat/conversations/provenance";
import { setSpanAttributes } from "@/chat/logging";
import { historyItemFromPiMessage } from "@/chat/pi/conversation-events";
import type { PiMessage } from "@/chat/pi/messages";
import { trimTrailingAssistantMessages } from "@/chat/pi/transcript";
import {
  calculateContextCompactionTargetTokens,
  getAgentContextCompactionTriggerTokens,
  getAgentContextInputLimitTokens,
} from "@/chat/services/context-budget";
import {
  compactActiveContextIfNeeded,
  estimateHistoryTokens,
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

type PreparedCompaction = Extract<
  ConversationEvent["data"],
  { type: "compaction_prepared"; outcome: "ready" }
>;

type DiscardReason =
  | "conflict"
  | "history_version_changed"
  | "over_target"
  | "profile_changed"
  | "split_tool_call";

interface ReplacementEntry {
  message: PiMessage;
  provenance: ConversationMessageProvenance;
  sourceEventSeq?: number;
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
 * Find the newest background compaction fact of the current History version.
 * Facts of earlier versions belong to history that a replacement already
 * removed.
 */
async function loadLatestBackgroundCompaction(conversationId: string) {
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
 * Swap a ready prepared summary into history, or run today's capacity
 * compaction when none can be used.
 */
export async function compactWithPreparedSummary(
  args: ActiveContextCompactionArgs,
  summarize: (messages: PiMessage[], signal?: AbortSignal) => Promise<string>,
): Promise<CompactContextResult> {
  const swapped = await swapPreparedCompaction(args);
  if (swapped.compacted) {
    return swapped;
  }
  return await compactActiveContextIfNeeded(args, summarize);
}

/**
 * Replace history with a ready prepared summary. Turn start swaps whenever
 * one is ready. Between model calls, swap only above the compaction
 * threshold.
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
  const estimatedTokens = estimateHistoryTokens(sourceMessages);
  if (args.mode !== "blocking" && estimatedTokens <= triggerTokens) {
    return { compacted: false, reason: "below_threshold" };
  }
  const latest = await loadLatestBackgroundCompaction(args.conversationId);
  if (!latest) {
    return { compacted: false };
  }
  return await withCompactionSpan(args.mode, async () => {
    const { event, historyVersion } = latest;
    if (
      event.data.type !== "compaction_prepared" ||
      event.data.outcome !== "ready"
    ) {
      setSpanAttributes({ "app.compaction.outcome": "not_ready" });
      return { compacted: false };
    }
    setSpanAttributes({
      "app.compaction.prepared.age_ms": Math.max(
        0,
        Date.now() - event.createdAtMs,
      ),
    });
    if (event.data.historyVersion !== historyVersion) {
      return discard("history_version_changed");
    }
    if (event.data.modelProfile !== args.modelProfile) {
      return discard("profile_changed");
    }
    return await applyPreparedSummary(args, event.data, {
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
  const replacementTokens = estimateHistoryTokens(messages);
  const targetTokens = calculateContextCompactionTargetTokens(
    budget.triggerTokens,
  );
  setSpanAttributes({
    "app.compaction.input.estimate": budget.estimatedTokens,
    "app.compaction.replacement.estimate": replacementTokens,
    "app.compaction.threshold": budget.triggerTokens,
    "app.compaction.carried_messages": kept.length,
    "app.compaction.carried.estimate": estimateHistoryTokens(
      trimmedEntries.map((entry) => entry.message),
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
        modelProfile: args.modelProfile,
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
    return discard("conflict");
  }
  setSpanAttributes({
    "app.compaction.outcome": "applied",
    "app.compaction.summary_chars": prepared.summary.length,
  });
  return { compacted: true, piMessages: messages };
}
