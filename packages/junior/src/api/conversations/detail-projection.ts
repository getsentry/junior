import { isDeepStrictEqual } from "node:util";
import { canExposeConversationPayload } from "@/chat/conversation-privacy";
import type {
  ConversationMessage,
  ConversationMessageStore,
} from "@/chat/conversations/messages";
import type {
  AgentStepStore,
  StoredAgentStep,
} from "@/chat/conversations/history";
import type { Conversation } from "@/chat/conversations/store";
import { loadProjection, projectSteps } from "@/chat/conversations/projection";
import { getAgentStepStore, getConversationMessageStore } from "@/chat/db";
import type { PiMessage } from "@/chat/pi/messages";
import { stripRuntimeTurnContext } from "@/chat/pi/transcript";
import {
  buildSentryConversationUrl,
  buildSentryTraceUrl,
} from "@/chat/sentry-links";
import {
  buildConversationActivityFromSteps,
  subagentActivityFromSteps,
  type SubagentEndedStep,
  type SubagentStartedStep,
} from "./activity";
import { conversationSummaryFromStoredConversation } from "./projection";
import {
  countConversationMessages,
  normalizeSubagentTranscriptMessage,
  normalizeTranscriptMessage,
  redactTranscriptMessage,
  subagentTranscriptReport,
  traceIdFromTranscript,
} from "./transcript";
import type {
  ConversationActivityReport,
  ConversationContextEvent,
  ConversationDetailReport,
  ConversationSubagentTranscriptReport,
  TranscriptMessage,
} from "./schema";

const COMPACTION_SUMMARY_PREFIXES = [
  "Context compaction summary for future Junior turns:",
  "Context handoff summary for future Junior turns:",
] as const;
const MODEL_HANDOFF_SUMMARY_PREFIX =
  "Model handoff checkpoint. Continue the outstanding request now using this summary as the complete prior context:";

type EpochStartedStep = StoredAgentStep & {
  entry: Extract<StoredAgentStep["entry"], { type: "context_epoch_started" }>;
};

function messageText(message: PiMessage): string {
  return normalizeTranscriptMessage(message)
    .parts.filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();
}

function summaryAfterPrefix(
  message: PiMessage,
  prefixes: readonly string[],
): string | undefined {
  const text = messageText(message);
  const prefix = prefixes.find((candidate) => text.startsWith(candidate));
  if (!prefix) return undefined;
  return text.slice(prefix.length).trim();
}

function summaryIndex(
  messages: PiMessage[],
  provenance: Array<{ authority: "context" | "instruction" }>,
  prefixes: readonly string[],
): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (
      provenance[index]?.authority === "context" &&
      summaryAfterPrefix(messages[index]!, prefixes) !== undefined
    ) {
      return index;
    }
  }
  return -1;
}

function matchingPrefix(left: PiMessage[], right: PiMessage[]): number {
  const limit = Math.min(left.length, right.length);
  for (let index = 0; index < limit; index += 1) {
    if (!isDeepStrictEqual(left[index], right[index])) return index;
  }
  return limit;
}

/**
 * Rebuild the chronological execution once across context replacements.
 * Synthetic summaries become context events, while copied replacement
 * messages are omitted without collapsing later execution messages.
 */
function historyContent(args: {
  canExposePayload: boolean;
  steps: StoredAgentStep[];
}): {
  contextEvents: ConversationContextEvent[];
  messages: PiMessage[];
} {
  const contextEvents: ConversationContextEvent[] = [];
  const messages: PiMessage[] = [];
  const epochs = new Map<number, StoredAgentStep[]>();
  for (const step of args.steps) {
    const epoch = epochs.get(step.contextEpoch);
    if (epoch) epoch.push(step);
    else epochs.set(step.contextEpoch, [step]);
  }

  let previousModelId: string | undefined;
  let previousProjection: PiMessage[] = [];
  for (const steps of epochs.values()) {
    const marker = steps.find(
      (step): step is EpochStartedStep =>
        step.entry.type === "context_epoch_started",
    );
    const projection = projectSteps(steps);
    const projected: PiMessage[] = [];
    const projectedProvenance: typeof projection.provenance = [];
    projection.messages.forEach((message, index) => {
      for (const retained of stripRuntimeTurnContext([message])) {
        projected.push(retained);
        projectedProvenance.push(projection.provenance[index]!);
      }
    });
    const replacementSummaryIndex =
      marker?.entry.reason === "compaction"
        ? summaryIndex(
            projected,
            projectedProvenance,
            COMPACTION_SUMMARY_PREFIXES,
          )
        : marker?.entry.reason === "handoff"
          ? summaryIndex(projected, projectedProvenance, [
              MODEL_HANDOFF_SUMMARY_PREFIX,
            ])
          : -1;
    const summary =
      replacementSummaryIndex >= 0
        ? summaryAfterPrefix(
            projected[replacementSummaryIndex]!,
            marker?.entry.reason === "handoff"
              ? [MODEL_HANDOFF_SUMMARY_PREFIX]
              : COMPACTION_SUMMARY_PREFIXES,
          )
        : undefined;

    if (marker?.entry.reason === "compaction") {
      contextEvents.push({
        type: "context_compacted",
        createdAt: new Date(marker.createdAtMs).toISOString(),
        ...(marker.entry.modelId ? { modelId: marker.entry.modelId } : {}),
        ...(args.canExposePayload && summary ? { summary } : {}),
        transcriptIndex: messages.length,
      });
    } else if (marker?.entry.reason === "handoff") {
      contextEvents.push({
        type: "model_handoff",
        createdAt: new Date(marker.createdAtMs).toISOString(),
        ...(previousModelId ? { fromModelId: previousModelId } : {}),
        toModelId: marker.entry.modelId,
        ...(args.canExposePayload && summary ? { summary } : {}),
        transcriptIndex: messages.length,
      });
    }

    if (marker?.entry.reason === "rollback") {
      messages.push(
        ...projected.slice(matchingPrefix(previousProjection, projected)),
      );
    } else {
      const copiedMessageIndexes = new Set<number>();
      projected.forEach((message, index) => {
        if (index === replacementSummaryIndex) return;
        let copiedCompactionMessage = false;
        if (
          marker?.entry.reason === "compaction" &&
          replacementSummaryIndex >= 0 &&
          index < replacementSummaryIndex
        ) {
          const copiedIndex = messages.findIndex(
            (candidate, candidateIndex) =>
              !copiedMessageIndexes.has(candidateIndex) &&
              isDeepStrictEqual(candidate, message),
          );
          copiedCompactionMessage = copiedIndex >= 0;
          if (copiedCompactionMessage) copiedMessageIndexes.add(copiedIndex);
        }
        if (!copiedCompactionMessage) messages.push(message);
      });
    }
    previousModelId = marker?.entry.modelId ?? previousModelId;
    previousProjection = projected;
  }

  return { contextEvents, messages };
}

async function conversationContent(args: {
  conversationId: string;
  messageStore: ConversationMessageStore;
  stepStore: AgentStepStore;
  canExposePayload: boolean;
}): Promise<{
  activity: ConversationActivityReport[];
  contextEvents: ConversationContextEvent[];
  transcript: TranscriptMessage[];
}> {
  const steps = await args.stepStore.loadHistory(args.conversationId);
  const history = historyContent({
    canExposePayload: args.canExposePayload,
    steps,
  });
  const messages = history.messages;
  const transcript =
    messages.length > 0
      ? messages.map((message) => normalizeTranscriptMessage(message))
      : (await args.messageStore.list(args.conversationId)).map(
          visibleMessageTranscript,
        );
  return {
    activity: buildConversationActivityFromSteps({
      canExposePayload: args.canExposePayload,
      steps,
      messages,
    }),
    contextEvents: history.contextEvents,
    transcript,
  };
}

function visibleMessageTranscript(
  message: ConversationMessage,
): TranscriptMessage {
  return {
    role: message.role,
    timestamp: message.createdAtMs,
    parts: [{ type: "text", text: message.text }],
  };
}

/** Build one conversation REST detail from durable SQL records. */
export async function buildConversationDetail(args: {
  conversation: Conversation;
  durationMs: number;
  usage: ConversationDetailReport["cumulativeUsage"];
}): Promise<ConversationDetailReport> {
  const { conversation } = args;
  const conversationId = conversation.conversationId;
  const nowMs = Date.now();
  const stepStore = getAgentStepStore();
  const messageStore = getConversationMessageStore();
  const transcriptPurgedAtMs = conversation.transcriptPurgedAtMs;
  const transcriptExpiredAt =
    transcriptPurgedAtMs !== undefined
      ? new Date(transcriptPurgedAtMs).toISOString()
      : undefined;

  // Reporting reads the complete durable execution history. Context rebuilds
  // become explicit events while copied replacement messages are de-duplicated.
  // Purged conversations have no steps to read.
  const canExposeSqlContent = canExposeConversationPayload({
    conversationId,
    visibility: conversation.visibility,
  });
  const currentContent =
    transcriptPurgedAtMs === undefined
      ? await conversationContent({
          conversationId,
          messageStore,
          stepStore,
          canExposePayload: canExposeSqlContent,
        })
      : { activity: [], contextEvents: [], transcript: [] };

  const currentTranscript = currentContent.transcript;
  const traceId = canExposeSqlContent
    ? traceIdFromTranscript(currentTranscript)
    : undefined;
  const sentryTraceUrl = traceId ? buildSentryTraceUrl(traceId) : undefined;
  const sentryConversationUrl = buildSentryConversationUrl(conversationId);

  return {
    ...conversationSummaryFromStoredConversation({
      conversation,
      durationMs: args.durationMs,
      usage: args.usage,
    }),
    ...(traceId ? { traceId } : {}),
    ...(sentryTraceUrl ? { sentryTraceUrl } : {}),
    activity: currentContent.activity,
    contextEvents: currentContent.contextEvents,
    transcriptAvailable:
      transcriptExpiredAt === undefined &&
      canExposeSqlContent &&
      currentTranscript.length > 0,
    ...(currentTranscript.length > 0
      ? {
          transcriptMessageCount: countConversationMessages(currentTranscript),
        }
      : {}),
    ...(!canExposeSqlContent && transcriptExpiredAt === undefined
      ? {
          transcriptMetadata: currentTranscript.map(redactTranscriptMessage),
          transcriptRedacted: true,
          transcriptRedactionReason: "non_public_conversation" as const,
        }
      : {}),
    ...(transcriptExpiredAt !== undefined
      ? {
          transcriptExpired: true,
          transcriptExpiredAt,
          transcriptMetadata: [],
        }
      : {}),
    transcript:
      transcriptExpiredAt === undefined && canExposeSqlContent
        ? currentTranscript
        : [],
    generatedAt: new Date(nowMs).toISOString(),
    ...(sentryConversationUrl ? { sentryConversationUrl } : {}),
  };
}

/** Build one child-agent REST detail from durable SQL history. */
export async function buildConversationSubagent(
  conversation: Conversation,
  subagentId: string,
): Promise<ConversationSubagentTranscriptReport> {
  const conversationId = conversation.conversationId;
  const stepStore = getAgentStepStore();
  const parentSteps = await stepStore.loadHistory(conversationId);

  // Retention purge deletes the parent tree's steps wholesale; present the
  // subagent as expired rather than "not found" (data-redaction-policy.md).
  if (conversation?.transcriptPurgedAtMs !== undefined) {
    return {
      type: "subagent",
      createdAt: new Date(0).toISOString(),
      id: subagentId,
      status: "completed",
      subagentKind: "unknown",
      transcript: [],
      transcriptAvailable: false,
      transcriptExpired: true,
      transcriptExpiredAt: new Date(
        conversation.transcriptPurgedAtMs,
      ).toISOString(),
    };
  }

  const start = parentSteps.find(
    (step): step is SubagentStartedStep =>
      step.entry.type === "subagent_started" &&
      step.entry.subagentInvocationId === subagentId,
  );
  if (!start) {
    return {
      type: "subagent",
      createdAt: new Date(0).toISOString(),
      id: subagentId,
      status: "error",
      subagentKind: "unknown",
      transcript: [],
      transcriptAvailable: false,
      unavailableReason: "not_found",
    };
  }
  const end = parentSteps.find(
    (step): step is SubagentEndedStep =>
      step.entry.type === "subagent_ended" &&
      step.entry.subagentInvocationId === subagentId,
  );

  const childConversationId = start.entry.childConversationId;
  const activity = subagentActivityFromSteps(start, end);
  const subagentSentryConversationUrl =
    buildSentryConversationUrl(childConversationId);
  const conversationFields = {
    subagentConversationId: childConversationId,
    ...(subagentSentryConversationUrl ? { subagentSentryConversationUrl } : {}),
  };

  const canExposeTranscript = canExposeConversationPayload({
    conversationId,
    visibility: conversation?.visibility,
  });
  if (!canExposeTranscript) {
    return subagentTranscriptReport(activity, {
      ...conversationFields,
      transcriptRedacted: true,
      transcriptRedactionReason: "non_public_conversation",
    });
  }

  const childMessages: PiMessage[] = await loadProjection({
    conversationId: childConversationId,
  });
  if (childMessages.length === 0) {
    return subagentTranscriptReport(activity, {
      ...conversationFields,
      unavailableReason: "missing_transcript_ref",
    });
  }

  const transcript = childMessages.map((message) =>
    normalizeSubagentTranscriptMessage(message, activity.subagentKind),
  );
  return subagentTranscriptReport(activity, {
    ...conversationFields,
    transcript,
    transcriptMessageCount: countConversationMessages(transcript),
  });
}
