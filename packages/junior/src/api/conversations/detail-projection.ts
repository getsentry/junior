import { canExposeConversationPayload } from "@/chat/conversation-privacy";
import type {
  ConversationMessage,
  ConversationMessageStore,
} from "@/chat/conversations/messages";
import type { AgentStepStore } from "@/chat/conversations/history";
import type { Conversation } from "@/chat/conversations/store";
import { loadProjection, projectSteps } from "@/chat/conversations/projection";
import { getAgentStepStore, getConversationMessageStore } from "@/chat/db";
import type { PiMessage } from "@/chat/pi/messages";
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
  ConversationDetailReport,
  ConversationSubagentTranscriptReport,
  TranscriptMessage,
} from "./schema";
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

  // The activity timeline is the current run's, derived from the current
  // context epoch's durable steps; older epochs stay audit-only. Purged
  // conversations have no steps to read.
  const canExposeSqlContent = canExposeConversationPayload({
    conversationId,
    visibility: conversation.visibility,
  });
  const currentContent =
    transcriptPurgedAtMs === undefined
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
  const sentryConversationUrl = buildSentryConversationUrl(conversationId);

  return {
    ...conversationSummaryFromStoredConversation({
      conversation,
      durationMs: args.durationMs,
      nowMs,
      usage: args.usage,
    }),
    ...(traceId ? { traceId } : {}),
    ...(sentryTraceUrl ? { sentryTraceUrl } : {}),
    activity: currentContent.activity,
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
