import type {
  ActorIdentity,
  ConversationReportEvent,
} from "@sentry/junior/api/schema";

/**
 * The first Turn of a mock Lead: it starts two fixture Conversations and
 * watches one, so the started Conversation cards can be checked visually.
 */
export function mockLeadEvents(
  actorIdentity: ActorIdentity,
  createdAtMs: number,
): ConversationReportEvent[] {
  const at = (offsetMs: number) =>
    new Date(createdAtMs + offsetMs).toISOString();
  const turnId = "mock-lead-turn";
  const starts = [
    {
      conversationId: "slack:CQA123:1770003600.000200",
      task: "Find why checkout p95 latency rose this morning and name the change that caused it.",
      title: "Investigate checkout latency",
      toolCallId: "mock-lead-start-latency",
    },
    {
      conversationId: "slack:CQA456:1770021600.000600",
      task: "Cut the package release and self-update the bot when CI passes.",
      title: "Package release and self-update",
      toolCallId: "mock-lead-start-release",
    },
  ];
  const watchCallId = "mock-lead-watch-latency";
  const watched = starts[0]!;
  return [
    {
      seq: 0,
      createdAt: at(0),
      data: {
        type: "message",
        messageId: "mock-lead-request",
        role: "user",
        source: "web",
        actorIdentity,
        text: "Find out why checkout got slow this morning and tell me when you know. Also ship the package release.",
      },
    },
    {
      seq: 1,
      createdAt: at(1),
      data: {
        type: "turn_lifecycle",
        turnId,
        state: "started",
        inputMessageIds: ["mock-lead-request"],
      },
    },
    {
      seq: 2,
      createdAt: at(1_000),
      data: {
        type: "tool_calls",
        calls: starts.map((start) => ({
          toolCallId: start.toolCallId,
          name: "startConversation",
          status: "running" as const,
          startedAt: at(1_000),
          startedSeq: 2,
          input: { task: start.task, title: start.title },
        })),
      },
    },
    ...starts.map((start, index) => ({
      seq: 3 + index,
      createdAt: at(2_000 + index),
      data: {
        type: "tool_calls" as const,
        calls: [
          {
            toolCallId: start.toolCallId,
            name: "startConversation",
            status: "completed" as const,
            startedAt: at(1_000),
            startedSeq: 2,
            startedConversationId: start.conversationId,
          },
        ],
      },
    })),
    {
      seq: 5,
      createdAt: at(3_000),
      data: {
        type: "tool_calls",
        calls: [
          {
            toolCallId: watchCallId,
            name: "watchEvents",
            status: "running",
            startedAt: at(3_000),
            startedSeq: 5,
            input: {
              events: ["conversation.completed", "conversation.failed"],
              identifier: watched.conversationId,
              intent: "Tell the person why checkout got slow.",
              label: `Conversation ${watched.title}`,
              namespace: "junior",
              resource_type: "conversation",
            },
          },
        ],
      },
    },
    {
      seq: 6,
      createdAt: at(3_500),
      data: {
        type: "tool_calls",
        calls: [
          {
            toolCallId: watchCallId,
            name: "watchEvents",
            status: "completed",
            startedAt: at(3_000),
            startedSeq: 5,
          },
        ],
      },
    },
    {
      seq: 7,
      createdAt: at(4_000),
      data: {
        type: "message",
        messageId: "mock-lead-reply",
        role: "assistant",
        text: "I started both. I'll tell you what the latency investigation finds.",
      },
    },
    {
      seq: 8,
      createdAt: at(4_001),
      data: { type: "turn_lifecycle", turnId, state: "succeeded" },
    },
  ];
}
