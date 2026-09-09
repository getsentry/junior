import type {
  BriefLink,
  BriefOutcomeStatus,
  ConversationBrief,
} from "@/chat/briefs/brief";

/** Build a valid compact Brief for storage and API tests. */
export function conversationBriefFixture(
  options: {
    links?: BriefLink[];
    status?: BriefOutcomeStatus;
    summary?: string;
  } = {},
): ConversationBrief {
  return {
    schemaVersion: 1,
    record: {
      startedAt: "2026-07-01T12:00:00.000Z",
      lastActivityAt: "2026-07-01T12:05:00.000Z",
      durationMs: 300_000,
      participants: [{ name: "Test User", messages: 1 }],
      userMessages: 1,
      assistantMessages: 1,
      toolResults: 0,
      events: 0,
      turns: 1,
      codeChanges: [],
    },
    summary: options.summary ?? "The requested work is complete.",
    intent: "Complete the requested work.",
    outcome: {
      status: options.status ?? "done",
      text: "The work reached its recorded outcome.",
    },
    decisions: [],
    openDecisions: [],
    facts: [],
    links: options.links ?? [],
    keywords: ["test"],
  };
}
