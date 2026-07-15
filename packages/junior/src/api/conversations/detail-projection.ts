import { isDeepStrictEqual } from "node:util";
import { canExposeConversationPayload } from "@/chat/conversation-privacy";
import type {
  ConversationEventStore,
  ConversationEvent,
  ConversationModelMessage,
} from "@/chat/conversations/history";
import type { Conversation } from "@/chat/conversations/store";
import { projectConversationEventHistory } from "@/chat/conversations/event-projection";
import { loadCurrentConversationEvents } from "@/chat/conversations/history-loader";
import { stripRuntimeTurnContextMessages } from "@/chat/conversations/model-messages";
import { getConversationEventStore } from "@/chat/db";
import { projectVisibleConversationMessages } from "@/chat/conversations/visible-message-projection";
import type { ConversationMessage } from "@/chat/state/conversation";
import {
  buildSentryConversationUrl,
  buildSentryTraceUrl,
} from "@/chat/sentry-links";
import {
  buildConversationActivityFromEvents,
  subagentActivityFromEvents,
  type SubagentEndedEvent,
  type SubagentStartedEvent,
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

type EpochStartedEvent = ConversationEvent & {
  data: Extract<ConversationEvent["data"], { type: "context_epoch_started" }>;
};

function messageText(message: ConversationModelMessage): string {
  return normalizeTranscriptMessage(message)
    .parts.filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();
}

function summaryAfterPrefix(
  message: ConversationModelMessage,
  prefixes: readonly string[],
): string | undefined {
  const text = messageText(message);
  const prefix = prefixes.find((candidate) => text.startsWith(candidate));
  if (!prefix) return undefined;
  return text.slice(prefix.length).trim();
}

function summaryIndex(
  messages: ConversationModelMessage[],
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

function matchingPrefix(
  left: ConversationModelMessage[],
  right: ConversationModelMessage[],
): number {
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
  events: ConversationEvent[];
}): {
  contextEvents: ConversationContextEvent[];
  messages: ConversationModelMessage[];
} {
  const contextEvents: ConversationContextEvent[] = [];
  const messages: ConversationModelMessage[] = [];
  const epochs = new Map<number, ConversationEvent[]>();
  for (const event of args.events) {
    const epoch = epochs.get(event.contextEpoch);
    if (epoch) epoch.push(event);
    else epochs.set(event.contextEpoch, [event]);
  }

  let previousModelId: string | undefined;
  let previousProjection: ConversationModelMessage[] = [];
  for (const events of epochs.values()) {
    const marker = events.find(
      (event): event is EpochStartedEvent =>
        event.data.type === "context_epoch_started",
    );
    const projection = projectConversationEventHistory(events);
    const projected: ConversationModelMessage[] = [];
    const projectedProvenance: typeof projection.provenance = [];
    projection.messages.forEach((message, index) => {
      for (const retained of stripRuntimeTurnContextMessages([message])) {
        projected.push(retained);
        projectedProvenance.push(projection.provenance[index]!);
      }
    });
    const replacementSummaryIndex =
      marker?.data.reason === "compaction"
        ? summaryIndex(
            projected,
            projectedProvenance,
            COMPACTION_SUMMARY_PREFIXES,
          )
        : marker?.data.reason === "handoff"
          ? summaryIndex(projected, projectedProvenance, [
              MODEL_HANDOFF_SUMMARY_PREFIX,
            ])
          : -1;
    const summary =
      marker?.data.reason === "compaction" && replacementSummaryIndex >= 0
        ? summaryAfterPrefix(
            projected[replacementSummaryIndex]!,
            COMPACTION_SUMMARY_PREFIXES,
          )
        : undefined;
    const handoffMessage =
      marker?.data.reason === "handoff" && replacementSummaryIndex >= 0
        ? messageText(projected[replacementSummaryIndex]!) || undefined
        : undefined;

    if (marker?.data.reason === "compaction") {
      contextEvents.push({
        type: "context_compacted",
        createdAt: new Date(marker.createdAtMs).toISOString(),
        ...(marker.data.modelId ? { modelId: marker.data.modelId } : {}),
        ...(args.canExposePayload && summary ? { summary } : {}),
        transcriptIndex: messages.length,
      });
    } else if (marker?.data.reason === "handoff") {
      contextEvents.push({
        type: "model_handoff",
        createdAt: new Date(marker.createdAtMs).toISOString(),
        ...(previousModelId ? { fromModelId: previousModelId } : {}),
        toModelId: marker.data.modelId,
        ...(args.canExposePayload && handoffMessage
          ? { message: handoffMessage }
          : {}),
        transcriptIndex: messages.length,
      });
    }

    if (marker?.data.reason === "rollback") {
      messages.push(
        ...projected.slice(matchingPrefix(previousProjection, projected)),
      );
    } else {
      const copiedMessageIndexes = new Set<number>();
      projected.forEach((message, index) => {
        if (index === replacementSummaryIndex) return;
        let copiedCompactionMessage = false;
        if (
          marker?.data.reason === "compaction" &&
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
    previousModelId = marker?.data.modelId ?? previousModelId;
    previousProjection = projected;
  }

  return { contextEvents, messages };
}

function terminalOutcomeTranscript(
  messages: ConversationModelMessage[],
): TranscriptMessage[] {
  return messages.flatMap((message) => {
    const normalized = normalizeTranscriptMessage(message);
    if (
      normalized.role !== "assistant" ||
      (normalized.outcome !== "error" && normalized.outcome !== "aborted")
    ) {
      return [];
    }
    return [
      {
        role: "assistant" as const,
        outcome: normalized.outcome,
        parts: [],
        ...(normalized.timestamp === undefined
          ? {}
          : { timestamp: normalized.timestamp }),
      },
    ];
  });
}

function mergeTranscriptChronologically(
  messages: TranscriptMessage[],
): TranscriptMessage[] {
  return messages
    .map((message, index) => ({ message, index }))
    .sort(
      (left, right) =>
        (left.message.timestamp ?? Number.POSITIVE_INFINITY) -
          (right.message.timestamp ?? Number.POSITIVE_INFINITY) ||
        left.index - right.index,
    )
    .map(({ message }) => message);
}

async function conversationContent(args: {
  conversationId: string;
  eventStore: ConversationEventStore;
  canExposePayload: boolean;
}): Promise<{
  activity: ConversationActivityReport[];
  contextEvents: ConversationContextEvent[];
  traceId?: string;
  transcript: TranscriptMessage[];
}> {
  const events = await args.eventStore.loadHistory(args.conversationId);
  const history = historyContent({
    canExposePayload: args.canExposePayload,
    events,
  });
  const visibleMessages = projectVisibleConversationMessages(events);
  const visibleTranscript = visibleMessages.map(visibleMessageTranscript);
  const modelTranscript = history.messages.map(normalizeTranscriptMessage);
  const transcript = mergeTranscriptChronologically([
    ...visibleTranscript,
    ...terminalOutcomeTranscript(history.messages),
  ]);
  const contextEvents = history.contextEvents.map((event) => ({
    ...event,
    transcriptIndex: transcript.findIndex(
      (message) =>
        (message.timestamp ?? Number.POSITIVE_INFINITY) >
        new Date(event.createdAt).getTime(),
    ),
  }));
  for (const event of contextEvents) {
    if (event.transcriptIndex < 0) event.transcriptIndex = transcript.length;
  }
  return {
    activity: buildConversationActivityFromEvents({
      canExposePayload: args.canExposePayload,
      events,
    }),
    contextEvents,
    ...(args.canExposePayload
      ? {
          traceId: traceIdFromTranscript([
            ...modelTranscript,
            ...visibleTranscript,
          ]),
        }
      : {}),
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
  locationId?: string;
  usage: ConversationDetailReport["cumulativeUsage"];
}): Promise<ConversationDetailReport> {
  const { conversation } = args;
  const conversationId = conversation.conversationId;
  const nowMs = Date.now();
  const eventStore = getConversationEventStore();
  const transcriptPurgedAtMs = conversation.transcriptPurgedAtMs;
  const transcriptExpiredAt =
    transcriptPurgedAtMs !== undefined
      ? new Date(transcriptPurgedAtMs).toISOString()
      : undefined;

  // Reporting reads the complete durable execution history. Context rebuilds
  // become explicit events while copied replacement messages are de-duplicated.
  // Purged conversations have no events to read.
  const canExposeSqlContent = canExposeConversationPayload({
    conversationId,
    visibility: conversation.visibility,
  });
  const currentContent: Awaited<ReturnType<typeof conversationContent>> =
    transcriptPurgedAtMs === undefined
      ? await conversationContent({
          conversationId,
          eventStore,
          canExposePayload: canExposeSqlContent,
        })
      : { activity: [], contextEvents: [], transcript: [] };

  const currentTranscript = currentContent.transcript;
  const traceId = canExposeSqlContent ? currentContent.traceId : undefined;
  const sentryTraceUrl = traceId ? buildSentryTraceUrl(traceId) : undefined;
  const sentryConversationUrl = buildSentryConversationUrl(conversationId);

  return {
    ...conversationSummaryFromStoredConversation({
      conversation,
      durationMs: args.durationMs,
      ...(args.locationId ? { locationId: args.locationId } : {}),
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
  const eventStore = getConversationEventStore();
  const parentEvents = await eventStore.loadHistory(conversationId);

  // Retention purge deletes the parent tree's events wholesale; present the
  // subagent as expired rather than "not found" (data-redaction.md).
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

  const start = parentEvents.find(
    (event): event is SubagentStartedEvent =>
      event.data.type === "subagent_started" &&
      event.data.subagentInvocationId === subagentId,
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
  const end = parentEvents.find(
    (event): event is SubagentEndedEvent =>
      event.data.type === "subagent_ended" &&
      event.data.subagentInvocationId === subagentId,
  );

  const childConversationId = start.data.childConversationId;
  const activity = subagentActivityFromEvents(start, end);
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

  const childEvents = await loadCurrentConversationEvents({
    conversationId: childConversationId,
  });
  const childMessages = projectConversationEventHistory(childEvents).messages;
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
