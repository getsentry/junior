import type {
  ConversationDetailReport,
  ConversationReportEventData,
} from "@sentry/junior/api/schema";

import { ChatLayout } from "../../conversations/ChatLayout";
import { TranscriptMessageView } from "../../conversations/TranscriptMessageView";
import { ConversationTranscriptView } from "../../conversations/ConversationTranscript";

const TIMESTAMP = "2026-08-07T12:00:00.000Z";
const EVENTS: ConversationReportEventData[] = [
  {
    type: "message",
    messageId: "gallery-reply",
    role: "assistant",
    text: "The change is ready for review.\n\nI tightened the conversation layout and kept the event details available below.",
    cards: [
      {
        kind: "object",
        objectType: "code_change",
        plugin: "github",
        key: "getsentry/junior#1200",
        label: "getsentry/junior#1200",
        title: "Tighten conversation spacing",
        status: "draft",
        displayType: "Pull request",
        url: "https://github.com/getsentry/junior/pull/1200",
        facts: {
          type: "code_change",
          author: "alex",
          sourceBranch: "fix/conversation-spacing",
          targetBranch: "main",
        },
      },
    ],
  },
  {
    type: "message",
    messageId: "gallery-comment",
    role: "user",
    eventType: "pull_request.comment.created",
    eventObjectType: "code_change",
    trustedSummary:
      "GitHub PR getsentry/junior#1200 received a comment from vercel[bot].",
    text: "Preview deployment is ready.",
  },
  {
    type: "assistant_message",
    parts: [
      {
        type: "reasoning",
        text: "Check the preview before reporting the result.",
      },
    ],
  },
  {
    type: "tool_calls",
    calls: [
      {
        toolCallId: "gallery-preview",
        name: "webFetch",
        status: "completed",
        input: { url: "https://example.com/preview" },
        output: { status: 200 },
      },
    ],
  },
  {
    type: "message",
    messageId: "gallery-review",
    role: "user",
    eventType: "pull_request.review.commented",
    eventObjectType: "code_change",
    trustedSummary: "GitHub PR getsentry/junior#1200 received a review.",
    text: "The preview is ready for visual review.",
  },
];

const CONVERSATION: ConversationDetailReport = {
  conversationId: "internal:gallery-conversation",
  displayTitle: "Conversation spacing",
  cumulativeDurationMs: 0,
  isParticipant: true,
  status: "completed",
  startedAt: TIMESTAMP,
  lastSeenAt: TIMESTAMP,
  lastProgressAt: TIMESTAMP,
  generatedAt: TIMESTAMP,
  surface: "internal",
  eventHistory: { status: "available" },
  events: EVENTS.map((data, seq) => ({
    seq,
    createdAt: new Date(Date.parse(TIMESTAMP) + seq * 1_000).toISOString(),
    data,
  })),
};

/** Use the local mock reporting attachment route to review wrapping and previews. */
export function MessageAttachmentsFixture() {
  return (
    <div className="min-w-0 max-w-[52.5rem] bg-dashboard-bg p-3">
      <TranscriptMessageView
        conversation={{
          ...CONVERSATION,
          conversationId: "internal:dashboard-qa",
        }}
        message={{
          sourceSeq: 0,
          role: "assistant",
          parts: [{ type: "text", text: "Two charts and the review notes." }],
          attachments: [
            {
              id: "qa-chart-png",
              filename: "before.png",
              contentType: "image/png",
              bytes: 18211,
            },
            {
              id: "qa-chart-png",
              filename: "after.png",
              contentType: "image/png",
              bytes: 18211,
            },
            {
              id: "qa-notes-txt",
              filename: "review-notes.txt",
              contentType: "text/plain",
              bytes: 42,
            },
          ],
        }}
      />
    </div>
  );
}

/** Show messages, cards, and activity after an event in the real scroll frame. */
export function ConversationFixture() {
  return (
    <div className="h-[36rem] min-w-0 max-w-[52.5rem] bg-dashboard-bg">
      <ChatLayout
        scrollAriaLabel="Gallery conversation transcript"
        scrollClassName="p-3"
        scroll={<ConversationTranscriptView conversation={CONVERSATION} />}
      />
    </div>
  );
}
