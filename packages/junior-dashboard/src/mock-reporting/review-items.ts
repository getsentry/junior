/**
 * Process-local Review items for mock reporting. Two Conversations ask the
 * viewer questions, so the questions above the message box, their transcript
 * rows, and the review desk can be checked without a database.
 */
import type {
  ConversationReportEvent,
  ReviewItemActionBody,
  ReviewItemPayload,
} from "@sentry/junior/api/schema";

/** One open question, and an earlier one that the viewer answered. */
export const MOCK_QUESTION_CONVERSATION_ID = "internal:question-qa";
/** Three open questions, so the question shows "1 of 3". */
export const MOCK_QUESTIONS_CONVERSATION_ID = "internal:questions-qa";

const viewer = {
  displayName: "Dashboard User",
  email: "dev@example.com",
  userId: "u-dev",
};

type MockItemSeed = Pick<
  ReviewItemPayload,
  "answer" | "body" | "id" | "request" | "status" | "title"
> & { conversationId: string; createdAt: string };

function seeds(nowMs: number): MockItemSeed[] {
  const at = (minutes: number) =>
    new Date(nowMs - minutes * 60_000).toISOString();
  return [
    {
      answer: {
        other: "us-east-1, it has the least traffic right now.",
        requestId: "qa-canary-region",
        values: {},
      },
      body: "The canary takes about 2% of traffic.",
      conversationId: MOCK_QUESTION_CONVERSATION_ID,
      createdAt: at(58),
      id: "qa-canary-region",
      request: {
        question: "Which region should run the canary?",
        fields: [
          {
            id: "region",
            kind: "choice",
            label: "Region",
            options: [{ label: "us-east-1" }, { label: "eu-west-1" }],
          },
        ],
      },
      status: "done",
      title: "Pick the canary region",
    },
    {
      body: "The canary error rate is flat for 30 minutes.",
      conversationId: MOCK_QUESTION_CONVERSATION_ID,
      createdAt: at(26),
      id: "qa-rollout",
      request: {
        question: "Roll out payments-v42 to every region?",
        fields: [
          {
            id: "go",
            kind: "choice",
            label: "Rollout",
            options: [
              { label: "Roll out", recommended: true },
              { label: "Hold" },
              { label: "EU first" },
            ],
          },
        ],
      },
      status: "open",
      title: "Approve the payments-v42 rollout",
    },
    {
      body: "Each window keeps the write lock for about 4 minutes.",
      conversationId: MOCK_QUESTIONS_CONVERSATION_ID,
      createdAt: at(42),
      id: "qa-migration-window",
      request: {
        question: "When should the billing migration run?",
        fields: [
          {
            id: "window",
            kind: "choice",
            label: "Window",
            options: [
              {
                description: "Lowest traffic of the week.",
                label: "Sunday 02:00 UTC",
                recommended: true,
              },
              {
                description: "Support is online if invoices fail.",
                label: "Tuesday 14:00 UTC",
              },
            ],
          },
        ],
      },
      status: "open",
      title: "Pick the billing migration window",
    },
    {
      body: "Invoices and credits change shape. Refunds can wait.",
      conversationId: MOCK_QUESTIONS_CONVERSATION_ID,
      createdAt: at(41),
      id: "qa-migration-tables",
      request: {
        question: "Which tables go in the first batch?",
        fields: [
          {
            id: "tables",
            kind: "multi_choice",
            label: "Tables",
            options: [
              { label: "invoices", recommended: true },
              { label: "credits", recommended: true },
              { label: "refunds" },
            ],
          },
          {
            description: "This person gets a ping if a batch fails.",
            id: "owner",
            kind: "text",
            label: "On-call owner",
          },
        ],
      },
      status: "open",
      title: "Choose the first migration batch",
    },
    {
      body: "The dry run found 12 invoices with a negative total.",
      conversationId: MOCK_QUESTIONS_CONVERSATION_ID,
      createdAt: at(40),
      id: "qa-migration-negative",
      request: {
        question: "What should happen to the 12 negative invoices?",
        fields: [
          {
            id: "fix",
            kind: "choice",
            label: "Negative invoices",
            options: [{ label: "Skip them" }, { label: "Zero them" }],
          },
        ],
      },
      status: "open",
      title: "Handle the negative invoices",
    },
  ];
}

type MockItemChange = Pick<
  ReviewItemPayload,
  "answer" | "closeReason" | "closedAt" | "closedBy" | "status"
>;

const changes = new Map<string, MockItemChange>();

/** Clear viewer actions so tests sharing a worker do not leak them. */
export function resetMockReviewItems(): void {
  changes.clear();
}

function payload(seed: MockItemSeed): ReviewItemPayload {
  const { conversationId, ...rest } = seed;
  const change = changes.get(seed.id);
  const item = { ...rest, ...change };
  return {
    ...item,
    addedByConversationId: conversationId,
    assignedToEveryone: false,
    assignees: [viewer],
    canAct: item.status === "open",
    canTake: false,
    conversationIds: [conversationId],
    kind: "action",
    updatedAt: item.closedAt ?? seed.createdAt,
    visibility: "public",
    ...(item.status !== "open" && !item.closedAt
      ? { closedAt: seed.createdAt, closedBy: viewer }
      : undefined),
  };
}

/** List the mock items, open first and oldest first, like the API. */
export function readMockReviewItems(
  nowMs: number,
  filters: { conversationId?: string; q?: string },
): ReviewItemPayload[] {
  const q = filters.q?.toLowerCase();
  return seeds(nowMs)
    .filter(
      (seed) =>
        (!filters.conversationId ||
          seed.conversationId === filters.conversationId) &&
        (!q || seed.title.toLowerCase().includes(q)),
    )
    .map(payload)
    .filter((item) => item.status === "open" || q !== undefined);
}

/** Read one mock item. */
export function readMockReviewItem(
  nowMs: number,
  id: string,
): ReviewItemPayload | undefined {
  const seed = seeds(nowMs).find((candidate) => candidate.id === id);
  return seed ? payload(seed) : undefined;
}

/** Apply a viewer action to an open mock item, like the API. */
export function actOnMockReviewItem(
  nowMs: number,
  id: string,
  body: ReviewItemActionBody,
): ReviewItemPayload | undefined {
  const item = readMockReviewItem(nowMs, id);
  if (!item || item.status !== "open") return item;
  if (body.action === "take") return item;
  changes.set(id, {
    closedAt: new Date(nowMs).toISOString(),
    closedBy: viewer,
    status: body.action === "dismiss" ? "dismissed" : "done",
    ...(body.action === "submit"
      ? { answer: { ...body.answer, requestId: id } }
      : undefined),
  });
  return readMockReviewItem(nowMs, id);
}

/**
 * Close the oldest open question in a Conversation with a typed message as
 * its answer. It stands in for the model that decides which questions a
 * reply answers.
 */
export function answerMockReviewItemByReply(
  nowMs: number,
  conversationId: string,
  text: string,
): void {
  const [item] = readMockReviewItems(nowMs, { conversationId });
  if (!item) return;
  changes.set(item.id, {
    answer: { other: text, requestId: item.id, values: {} },
    closeReason: "Replied in the conversation.",
    closedAt: new Date(nowMs).toISOString(),
    closedBy: viewer,
    status: "done",
  });
}

/** Count the open items and list the Conversations that wait on the viewer. */
export function readMockWaitingConversations(nowMs: number) {
  const open = readMockReviewItems(nowMs, {});
  const byConversation = new Map<string, ReviewItemPayload[]>();
  for (const item of open) {
    const id = item.addedByConversationId;
    byConversation.set(id, [...(byConversation.get(id) ?? []), item]);
  }
  return {
    conversations: [...byConversation].map(([conversationId, items]) => ({
      conversationId,
      count: items.length,
      title: items.at(-1)!.title,
    })),
    needsViewer: open.length,
  };
}

function addItemCall(seq: number, createdAt: string, item: MockItemSeed) {
  return {
    seq,
    createdAt,
    data: {
      type: "tool_calls",
      calls: [
        {
          input: { kind: "action", title: item.title },
          name: "addReviewItem",
          output: JSON.stringify({ item: { id: item.id } }),
          status: "completed",
          toolCallId: `add-${item.id}`,
        },
      ],
    },
  } satisfies ConversationReportEvent;
}

function message(
  seq: number,
  createdAt: string,
  role: "assistant" | "user",
  text: string,
): ConversationReportEvent {
  return {
    seq,
    createdAt,
    data: { type: "message", messageId: `qa-message-${seq}`, role, text },
  };
}

/**
 * Build the two question Conversations. Junior adds each item with a tool
 * call before its final message, as a live Turn does.
 */
export function mockQuestionConversations(nowMs: number) {
  const [region, rollout, window, tables, negative] = seeds(nowMs);
  const at = (minutes: number) =>
    new Date(nowMs - minutes * 60_000).toISOString();
  const conversation = (
    conversationId: string,
    displayTitle: string,
    events: ConversationReportEvent[],
  ) => ({
    actorIdentity: { email: viewer.email, fullName: viewer.displayName },
    conversationId,
    cumulativeDurationMs: 95_000,
    displayTitle,
    events,
    isParticipant: true,
    lastProgressAt: events.at(-1)!.createdAt,
    lastSeenAt: events.at(-1)!.createdAt,
    startedAt: events[0]!.createdAt,
    surface: "internal" as const,
  });
  return [
    conversation(MOCK_QUESTION_CONVERSATION_ID, "Roll out payments-v42", [
      message(0, at(60), "user", "Ship payments-v42 when the canary is clean."),
      addItemCall(1, at(58), region!),
      message(
        2,
        at(58),
        "assistant",
        "The build is ready. I need a region for the canary first.",
      ),
      message(3, at(50), "user", region!.answer!.other!),
      message(
        4,
        at(49),
        "assistant",
        "The canary is running in us-east-1. I will check it in 20 minutes.",
      ),
      addItemCall(5, at(26), rollout!),
      message(
        6,
        at(26),
        "assistant",
        "The canary error rate is flat for 30 minutes, and p95 latency did not move. I need your go-ahead before I roll out to every region.",
      ),
    ]),
    conversation(MOCK_QUESTIONS_CONVERSATION_ID, "Plan the billing migration", [
      message(0, at(45), "user", "Plan the billing migration for next week."),
      addItemCall(1, at(42), window!),
      addItemCall(2, at(41), tables!),
      addItemCall(3, at(40), negative!),
      message(
        4,
        at(40),
        "assistant",
        "The dry run passed. Three decisions are left before I schedule it.",
      ),
    ]),
  ];
}
