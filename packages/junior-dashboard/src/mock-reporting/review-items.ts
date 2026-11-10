/**
 * Process-local Review items for mock reporting. Two Conversations ask the
 * viewer questions, so the questions above the message box, their transcript
 * rows, and the review desk can be checked without a database. GitHub
 * plugin asks and FYI notices fill the rest of the inbox.
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

// Fixture Conversations that the plugin asks and notices link to.
const DEPLOY_CONVERSATION_ID = "slack:CQA777:1770014400.000500";
const RELEASE_CONVERSATION_ID = "slack:CQA456:1770021600.000600";
const DIGEST_CONVERSATION_ID = "scheduler:daily-ops-digest";
const DASHBOARD_CONVERSATION_ID = "internal:dashboard-qa";
const RELIABILITY_CONVERSATION_ID = "slack:CQA456:1770025200.000700";
const CHECKOUT_CONVERSATION_ID = "slack:CQA123:1770000000.000100";
const SANDBOX_CONVERSATION_ID = "slack:CQA999:1770010800.000400";
const DAY = 24 * 60;

type MockItemSeed = Pick<
  ReviewItemPayload,
  "answer" | "body" | "id" | "request" | "status" | "subject" | "title"
> &
  Partial<Pick<ReviewItemPayload, "assignedToEveryone" | "kind">> & {
    conversationId: string;
    createdAt: string;
    /** The plugin that added the item. Plugin items have no Turn. */
    plugin?: string;
  };

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
    {
      // The GitHub plugin asks the opener once the pull request can merge.
      body: "**Update Junior to 0.288.0** is approved, and GitHub says that it can merge: https://github.com/getsentry/junior/pull/2201",
      conversationId: RELEASE_CONVERSATION_ID,
      createdAt: at(12),
      id: "qa-ready-2201",
      plugin: "github",
      status: "open",
      subject: {
        id: "https://github.com/getsentry/junior/pull/2201",
        title: "getsentry/junior#2201",
        url: "https://github.com/getsentry/junior/pull/2201",
      },
      title: "Ready to merge · #2201",
    },
    {
      body: "GitHub asks you to review **Pin the release train to payments 4.2**: https://github.com/getsentry/payments/pull/91",
      conversationId: RELEASE_CONVERSATION_ID,
      createdAt: at(89),
      id: "qa-review-91",
      plugin: "github",
      status: "open",
      subject: {
        id: "https://github.com/getsentry/payments/pull/91",
        title: "getsentry/payments#91",
        url: "https://github.com/getsentry/payments/pull/91",
      },
      title: "Review requested · #91",
    },
    {
      assignedToEveryone: true,
      body: "The canary deploy paused after the error budget alert. Nothing to do unless it stays paused.",
      conversationId: DEPLOY_CONVERSATION_ID,
      createdAt: at(30),
      id: "qa-deploy-paused",
      kind: "notice",
      status: "open",
      title: "Canary deploy paused",
    },
    {
      body: "The digest skipped two alerts that fired more than 20 times today.",
      conversationId: DIGEST_CONVERSATION_ID,
      createdAt: at(300),
      id: "qa-digest-skipped",
      kind: "notice",
      status: "open",
      title: "Digest skipped two noisy alerts",
    },
    // Prototype: older items, so the inbox has Today, This week, and Earlier.
    {
      assignedToEveryone: true,
      body: "Release notes for 0.288.0 are drafted in the release PR.",
      conversationId: RELEASE_CONVERSATION_ID,
      createdAt: at(20),
      id: "qa-release-notes",
      kind: "notice",
      status: "open",
      title: "Release notes drafted",
    },
    {
      body: "GitHub asks you to review **Tabs in the dashboard sidebar**: https://github.com/getsentry/junior/pull/3052",
      conversationId: DASHBOARD_CONVERSATION_ID,
      createdAt: at(2 * DAY),
      id: "qa-review-3052",
      plugin: "github",
      status: "open",
      subject: {
        id: "https://github.com/getsentry/junior/pull/3052",
        title: "getsentry/junior#3052",
        url: "https://github.com/getsentry/junior/pull/3052",
      },
      title: "Review requested · #3052",
    },
    {
      body: "**Fix the stable list order** merged into main: https://github.com/getsentry/junior/pull/3037",
      conversationId: DASHBOARD_CONVERSATION_ID,
      createdAt: at(3 * DAY),
      id: "qa-merged-3037",
      kind: "notice",
      plugin: "github",
      status: "open",
      subject: {
        id: "https://github.com/getsentry/junior/pull/3037",
        title: "getsentry/junior#3037",
        url: "https://github.com/getsentry/junior/pull/3037",
      },
      title: "Merged · #3037",
    },
    {
      assignedToEveryone: true,
      body: "The weekly reliability summary is in #project-updates.",
      conversationId: RELIABILITY_CONVERSATION_ID,
      createdAt: at(4 * DAY),
      id: "qa-reliability-weekly",
      kind: "notice",
      status: "open",
      title: "Weekly reliability summary posted",
    },
    {
      body: "p95 checkout latency is back under 600 ms for 9 days.",
      conversationId: CHECKOUT_CONVERSATION_ID,
      createdAt: at(9 * DAY),
      id: "qa-latency-alert",
      request: {
        question: "Lower the checkout p95 alert from 800 ms to 650 ms?",
        fields: [
          {
            id: "threshold",
            kind: "choice",
            label: "Alert threshold",
            options: [
              { label: "650 ms", recommended: true },
              { label: "Keep 800 ms" },
            ],
          },
        ],
      },
      status: "open",
      title: "Tighten the checkout latency alert",
    },
    {
      assignedToEveryone: true,
      body: "Three sandboxes rebuilt their dependency snapshot after the lockfile change.",
      conversationId: SANDBOX_CONVERSATION_ID,
      createdAt: at(11 * DAY),
      id: "qa-sandbox-snapshot",
      kind: "notice",
      status: "open",
      title: "Sandbox snapshots rebuilt",
    },
    {
      assignedToEveryone: true,
      body: "The Q3 reliability review doc has comments from two reviewers.",
      conversationId: RELIABILITY_CONVERSATION_ID,
      createdAt: at(12 * DAY),
      id: "qa-reliability-comments",
      kind: "notice",
      status: "open",
      title: "Review doc has new comments",
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
  const { conversationId, plugin: _plugin, ...rest } = seed;
  const change = changes.get(seed.id);
  const item = { ...rest, ...change };
  const everyone = seed.assignedToEveryone ?? false;
  return {
    ...item,
    addedByConversationId: conversationId,
    assignedToEveryone: everyone,
    assignees: everyone ? [] : [viewer],
    canAct: item.status === "open",
    canTake: false,
    conversationIds: [conversationId],
    kind: seed.kind ?? "action",
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
  const item = readMockReviewItems(nowMs, { conversationId }).find(
    (candidate) => candidate.request,
  );
  if (!item) return;
  changes.set(item.id, {
    answer: { other: text, requestId: item.id, values: {} },
    closeReason: "Replied in the conversation.",
    closedAt: new Date(nowMs).toISOString(),
    closedBy: viewer,
    status: "done",
  });
}

/**
 * Count the open items that need the viewer and list the Conversations that
 * wait on them. Like the API, notices and items for Everyone do not count.
 */
export function readMockWaitingConversations(nowMs: number) {
  const plugins = new Map(
    seeds(nowMs).flatMap((seed) =>
      seed.plugin ? [[seed.id, seed.plugin] as const] : [],
    ),
  );
  const open = readMockReviewItems(nowMs, {}).filter(
    (item) => item.kind === "action" && !item.assignedToEveryone,
  );
  const byConversation = new Map<string, ReviewItemPayload[]>();
  for (const item of open) {
    const id = item.addedByConversationId;
    byConversation.set(id, [...(byConversation.get(id) ?? []), item]);
  }
  return {
    conversations: [...byConversation].map(([conversationId, items]) => ({
      conversationId,
      items: [...items]
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .map(({ id, title }) => {
          const plugin = plugins.get(id);
          return { title, ...(plugin ? { plugin } : undefined) };
        }),
      waitingSince: items
        .map((item) => item.createdAt)
        .reduce((oldest, createdAt) =>
          createdAt < oldest ? createdAt : oldest,
        ),
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
