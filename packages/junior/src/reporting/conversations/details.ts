import { canExposeConversationPayload } from "@/chat/conversation-privacy";
import type {
  ConversationMessage,
  ConversationMessageStore,
} from "@/chat/conversations/messages";
import type { AgentStepStore } from "@/chat/conversations/history";
import { loadProjection, projectSteps } from "@/chat/conversations/projection";
import { getAgentStepStore, getConversationMessageStore } from "@/chat/db";
import type { PiMessage } from "@/chat/pi/messages";
import {
  buildSentryConversationUrl,
  buildSentryTraceUrl,
} from "@/chat/sentry-links";
import { listAgentTurnSessionSummariesForConversation } from "@/chat/state/turn-session";
import { conversationStore, type ConversationReaderOptions } from "./context";
import {
  buildConversationActivityFromSteps,
  subagentActivityFromSteps,
  type SubagentEndedStep,
  type SubagentStartedStep,
} from "./activity";
import { surfaceFallbackLabel } from "./shared";
import { sessionReportFromConversation } from "./summaries";
import {
  countConversationMessages,
  normalizeTranscriptMessage,
  redactTranscriptMessage,
  subagentTranscriptReport,
  traceIdFromTranscript,
} from "./transcript";
import type {
  ConversationActivityReport,
  ConversationReport,
  ConversationRunReport,
  ConversationSubagentTranscriptReport,
  TranscriptMessage,
} from "./types";
async function currentRunContent(args: {
  conversationId: string;
  messageStore: ConversationMessageStore;
  stepStore: AgentStepStore;
  canExposePayload: boolean;
}): Promise<{
  activity: ConversationActivityReport[];
  transcript: TranscriptMessage[];
}> {
  const steps = await args.stepStore.loadCurrentEpoch(args.conversationId);
  const messages = projectSteps(steps).messages;
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

/** Read one conversation transcript for reporting consumers. */
export async function readConversationReport(
  conversationId: string,
  options: ConversationReaderOptions = {},
): Promise<ConversationReport> {
  const store = conversationStore(options);
  const nowMs = Date.now();
  const conversation = await store.get({ conversationId });
  const turnSummaries = conversation
    ? await listAgentTurnSessionSummariesForConversation(conversationId)
    : [];
  const currentTurnSummary = conversation
    ? turnSummaries.find(
        (summary) => summary.sessionId === conversation.execution.runId,
      )
    : undefined;

  const stepStore = getAgentStepStore();
  const messageStore = options.messageStore ?? getConversationMessageStore();
  const transcriptPurgedAtMs = conversation?.transcriptPurgedAtMs;
  const transcriptExpiredAt =
    transcriptPurgedAtMs !== undefined
      ? new Date(transcriptPurgedAtMs).toISOString()
      : undefined;

  // The activity timeline is the current run's, derived from the current
  // context epoch's durable steps; older epochs stay audit-only. Purged
  // conversations have no steps to read.
  const canExposeSqlContent =
    conversation !== undefined &&
    canExposeConversationPayload({
      conversationId,
      visibility: conversation.visibility,
    });
  const currentContent =
    conversation && transcriptPurgedAtMs === undefined
      ? await currentRunContent({
          conversationId,
          messageStore,
          stepStore,
          canExposePayload: canExposeSqlContent,
        })
      : { activity: [], transcript: [] };

  const currentTranscript = currentContent.transcript;
  const traceId = canExposeSqlContent
    ? traceIdFromTranscript(currentTranscript)
    : undefined;
  const sentryTraceUrl = traceId ? buildSentryTraceUrl(traceId) : undefined;
  const effectiveRuns: ConversationRunReport[] = conversation
    ? [
        {
          ...sessionReportFromConversation(conversation, nowMs),
          ...(currentTurnSummary
            ? {
                cumulativeDurationMs: currentTurnSummary.cumulativeDurationMs,
                ...(currentTurnSummary.cumulativeUsage
                  ? { cumulativeUsage: currentTurnSummary.cumulativeUsage }
                  : {}),
              }
            : {}),
          ...(currentTurnSummary?.modelId
            ? { modelId: currentTurnSummary.modelId }
            : {}),
          ...(currentTurnSummary?.reasoningLevel
            ? { reasoningLevel: currentTurnSummary.reasoningLevel }
            : {}),
          ...(traceId ? { traceId } : {}),
          ...(sentryTraceUrl ? { sentryTraceUrl } : {}),
          activity: currentContent.activity,
          transcriptAvailable:
            transcriptExpiredAt === undefined &&
            canExposeSqlContent &&
            currentTranscript.length > 0,
          ...(currentTranscript.length > 0
            ? {
                transcriptMessageCount:
                  countConversationMessages(currentTranscript),
              }
            : {}),
          ...(!canExposeSqlContent && transcriptExpiredAt === undefined
            ? {
                transcriptMetadata: currentTranscript.map(
                  redactTranscriptMessage,
                ),
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
        },
      ]
    : [];

  const firstRun = effectiveRuns[0];
  const displayTitle =
    firstRun?.displayTitle ??
    surfaceFallbackLabel(firstRun?.surface ?? "slack");
  const sentryConversationUrl = buildSentryConversationUrl(conversationId);

  return {
    conversationId,
    displayTitle,
    generatedAt: new Date(nowMs).toISOString(),
    ...(sentryConversationUrl ? { sentryConversationUrl } : {}),
    runs: effectiveRuns,
  };
}

/** Read one child-agent transcript through its parent conversation. */
export async function readConversationSubagentTranscriptReport(
  conversationId: string,
  _runId: string,
  subagentId: string,
  options: ConversationReaderOptions = {},
): Promise<ConversationSubagentTranscriptReport> {
  const store = conversationStore(options);
  const stepStore = getAgentStepStore();
  const [conversation, parentSteps] = await Promise.all([
    store.get({ conversationId }),
    stepStore.loadHistory(conversationId),
  ]);

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
    normalizeTranscriptMessage(message, {
      unwrapAdvisorTask: activity.subagentKind === "advisor",
    }),
  );
  return subagentTranscriptReport(activity, {
    ...conversationFields,
    transcript,
    transcriptMessageCount: countConversationMessages(transcript),
  });
}
