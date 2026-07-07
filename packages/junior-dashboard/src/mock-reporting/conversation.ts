import type {
  ConversationActivityReport,
  ConversationReport,
  ConversationReportStatus,
  ConversationRunReport,
  ConversationSurface,
  ConversationUsage,
  ActorIdentity,
  TranscriptMessage,
} from "@sentry/junior/reporting";

import { mockIso } from "./time";
import { mockTranscriptMessage } from "./transcript";

export type MockRunOptions = {
  activity?: ConversationActivityReport[];
  channel?: string;
  channelName?: string;
  completedAt?: string;
  conversationId?: string;
  cumulativeDurationMs?: number;
  cumulativeUsage?: ConversationUsage;
  displayTitle?: string;
  id?: string;
  lastProgressAt?: string;
  lastSeenAt?: string;
  actorIdentity?: ActorIdentity;
  sentryTraceUrl?: string;
  startedAt?: string;
  status?: ConversationReportStatus;
  surface?: ConversationSurface;
  traceId?: string;
  transcript?: TranscriptMessage[];
  transcriptAvailable?: boolean;
  transcriptMessageCount?: number;
  transcriptMetadata?: TranscriptMessage[];
  transcriptRedacted?: boolean;
  transcriptRedactionReason?: "non_public_conversation";
};

/** Build a conversation run constrained to the reporting API shape. */
export function mockRun(options: MockRunOptions = {}): ConversationRunReport {
  const startedAt = options.startedAt ?? mockIso();
  return {
    conversationId: options.conversationId ?? "internal:mock-conversation",
    cumulativeDurationMs: options.cumulativeDurationMs ?? 0,
    displayTitle: options.displayTitle ?? "Mock conversation",
    id: options.id ?? "mock-turn-1",
    lastProgressAt: options.lastProgressAt ?? startedAt,
    lastSeenAt: options.lastSeenAt ?? startedAt,
    startedAt,
    status: options.status ?? "completed",
    surface: options.surface ?? "internal",
    transcriptAvailable: options.transcriptAvailable ?? true,
    transcript: options.transcript ?? [mockTranscriptMessage()],
    ...(options.activity !== undefined ? { activity: options.activity } : {}),
    ...(options.channel !== undefined ? { channel: options.channel } : {}),
    ...(options.channelName !== undefined
      ? { channelName: options.channelName }
      : {}),
    ...(options.completedAt !== undefined
      ? { completedAt: options.completedAt }
      : {}),
    ...(options.cumulativeUsage !== undefined
      ? { cumulativeUsage: options.cumulativeUsage }
      : {}),
    ...(options.actorIdentity !== undefined
      ? { actorIdentity: options.actorIdentity }
      : {}),
    ...(options.sentryTraceUrl !== undefined
      ? { sentryTraceUrl: options.sentryTraceUrl }
      : {}),
    ...(options.traceId !== undefined ? { traceId: options.traceId } : {}),
    ...(options.transcriptMessageCount !== undefined
      ? { transcriptMessageCount: options.transcriptMessageCount }
      : {}),
    ...(options.transcriptMetadata !== undefined
      ? { transcriptMetadata: options.transcriptMetadata }
      : {}),
    ...(options.transcriptRedacted !== undefined
      ? { transcriptRedacted: options.transcriptRedacted }
      : {}),
    ...(options.transcriptRedactionReason !== undefined
      ? { transcriptRedactionReason: options.transcriptRedactionReason }
      : {}),
  } satisfies ConversationRunReport;
}

export type MockConversationOptions = {
  conversationId?: string;
  displayTitle?: string;
  generatedAt?: string;
  runs?: ConversationRunReport[];
  sentryConversationUrl?: string;
};

/** Build a conversation report constrained to the reporting API shape. */
export function mockConversation(
  options: MockConversationOptions = {},
): ConversationReport {
  const conversationId = options.conversationId ?? "internal:mock-conversation";
  const displayTitle = options.displayTitle ?? "Mock conversation";
  return {
    conversationId,
    displayTitle,
    generatedAt: options.generatedAt ?? mockIso(),
    ...(options.sentryConversationUrl !== undefined
      ? { sentryConversationUrl: options.sentryConversationUrl }
      : {}),
    runs: options.runs ?? [
      mockRun({
        conversationId,
        displayTitle,
      }),
    ],
  } satisfies ConversationReport;
}
