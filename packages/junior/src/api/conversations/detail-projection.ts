import { canExposeConversationPayload } from "@/chat/conversation-privacy";
import type { ConversationEvent } from "@/chat/conversations/history";
import type { Conversation } from "@/chat/conversations/store";
import { buildSentryConversationUrl } from "@/chat/sentry-links";
import { projectConversationReportEvents } from "./events";
import { conversationSummaryFromStoredConversation } from "./projection";
import type { ConversationDetailReport } from "./schema";

/** Build one conversation REST detail from its canonical event history. */
export async function buildConversationDetail(args: {
  conversation: Conversation;
  durationMs: number;
  effectiveVisibility?: Conversation["visibility"];
  events: ConversationEvent[];
  privacyConversationId?: string;
  locationId?: string;
  usage: ConversationDetailReport["cumulativeUsage"];
}): Promise<ConversationDetailReport> {
  const { conversation } = args;
  const conversationId = conversation.conversationId;
  const nowMs = Date.now();
  const transcriptPurgedAtMs = conversation.transcriptPurgedAtMs;
  const { visibility: _storedVisibility, ...conversationWithoutVisibility } =
    conversation;
  const authorizedConversation: Conversation = {
    ...conversationWithoutVisibility,
    ...(args.effectiveVisibility
      ? { visibility: args.effectiveVisibility }
      : {}),
  };
  const canExposePayload = canExposeConversationPayload({
    conversationId: args.privacyConversationId ?? conversationId,
    visibility: args.effectiveVisibility,
  });
  const events = transcriptPurgedAtMs === undefined ? args.events : [];
  const sentryConversationUrl = buildSentryConversationUrl(conversationId);

  return {
    ...conversationSummaryFromStoredConversation({
      conversation: authorizedConversation,
      durationMs: args.durationMs,
      ...(args.locationId ? { locationId: args.locationId } : {}),
      usage: args.usage,
    }),
    events: projectConversationReportEvents({ canExposePayload, events }),
    eventHistory:
      transcriptPurgedAtMs !== undefined
        ? {
            status: "expired",
            expiredAt: new Date(transcriptPurgedAtMs).toISOString(),
          }
        : canExposePayload
          ? { status: "available" }
          : {
              status: "redacted",
              reason: "non_public_conversation",
            },
    generatedAt: new Date(nowMs).toISOString(),
    ...(sentryConversationUrl ? { sentryConversationUrl } : {}),
  };
}
