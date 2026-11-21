/**
 * Process-local Inbox items for mock reporting. Three Conversations ask the
 * viewer questions, so the questions above the message box, their transcript
 * rows, and the Inbox can be checked without a database. GitHub
 * plugin asks, FYI notices, and the alerts of the viewer's Automations that
 * need attention fill the rest of the inbox.
 */
import {
  answeredChoices,
  type ConversationFeed,
  type ConversationFeedViewerAnswer,
  type InboxItemActionBody,
  type InboxItemPayload,
  type InboxSnoozeCreateBody,
  type InboxSnoozeSubjectBody,
} from "@sentry/junior/api/schema";
import { PULL_REQUEST_RESOURCE } from "./snooze-resources";

/** One open question, and an earlier one that the viewer answered. */
export const MOCK_QUESTION_CONVERSATION_ID = "internal:question-qa";
/** Three open questions, so the question shows "1 of 3". */
export const MOCK_QUESTIONS_CONVERSATION_ID = "internal:questions-qa";

/** The mock viewer, who answers and closes items. */
export const viewer = {
  displayName: "Dashboard User",
  email: "dev@example.com",
  userId: "u-dev",
};

// The mock rollback owner. Junior names people as Slack mentions, and the
// API resolves each mention to its person.
export const AVERY_MENTION = {
  email: "avery@sentry.io",
  fullName: "Avery Chen",
  slackUserId: "U789",
};

// Fixture Conversations that the plugin asks and notices link to.
const DEPLOY_CONVERSATION_ID = "slack:CQA777:1770014400.000500";
const RELEASE_CONVERSATION_ID = "slack:CQA456:1770021600.000600";
const DIGEST_CONVERSATION_ID = "scheduler:daily-ops-digest";
const RELIABILITY_CONVERSATION_ID = "slack:CQA456:1770025200.000700";
const SANDBOX_CONVERSATION_ID = "slack:CQA999:1770010800.000400";
// A root and two of its Threads, so the Inbox stacks a child's items under
// the root.
const SENTAUR_CONVERSATION_ID = "slack:CQA456:1770028800.000900";
const SENTAUR_RUNS_THREAD_ID = "slack:CQA456:1770028800.000901";
const SENTAUR_LOGS_THREAD_ID = "slack:CQA456:1770028800.000902";
// The checkout latency Conversations: one found that p95 rose after
// payments-v42, the other rolled it back.
const LATENCY_CONVERSATION_ID = "slack:CQA123:1770003600.000200";
const ROLLBACK_CONVERSATION_ID = "slack:CQA123:1770000000.000100";
const PAYMENTS_V42 = { id: "release:payments-v42", title: "payments-v42" };
const DAY = 24 * 60;

export type MockItemSeed = Pick<
  InboxItemPayload,
  | "answer"
  | "body"
  | "id"
  | "mentions"
  | "request"
  | "status"
  | "subject"
  | "title"
> &
  Partial<
    Pick<
      InboxItemPayload,
      "assignedToEveryone" | "closeReason" | "closedAt" | "kind" | "todoId"
    >
  > & {
    /** The Automation that owns an alert. An alert has no Conversation. */
    automationId?: string;
    /** The Thread title, for an item that a child agent added. */
    childLabel?: string;
    /** The Conversation that owns the item, unless an Automation does. */
    conversationId?: string;
    createdAt: string;
    /** Linked Conversations other than the one that added the item. */
    linkedConversationIds?: string[];
    /** The plugin that added the item. Plugin items have no Turn. */
    plugin?: string;
  };

/** Every mock Inbox item, with its times relative to `nowMs`. */
export function seeds(nowMs: number): MockItemSeed[] {
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
      closedAt: at(50),
      conversationId: MOCK_QUESTION_CONVERSATION_ID,
      createdAt: at(58),
      id: "qa-canary-region",
      mentions: [AVERY_MENTION],
      request: {
        question:
          "Which region should run the canary? <@U789> owns the rollback.",
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
      linkedConversationIds: [ROLLBACK_CONVERSATION_ID],
      request: {
        question: "Roll out payments-v42 to every region?",
        // The cited evidence supports the suggested answer. The related
        // items on the same release disagree with it.
        evidence: [
          {
            label: "Canary error rate",
            note: "Flat for 30 minutes.",
            url: "https://sentry.example.com/organizations/acme/insights/backend/?release=payments-v42",
          },
          {
            label: "Canary p95 latency",
            note: "Did not move in us-east-1.",
            url: "https://sentry.example.com/organizations/acme/explore/traces/?release=payments-v42",
          },
        ],
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
      subject: PAYMENTS_V42,
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
      body: "#2201 is approved, and GitHub says that it can merge.\n\nhttps://github.com/getsentry/junior/pull/2201",
      conversationId: RELEASE_CONVERSATION_ID,
      createdAt: at(12),
      id: "qa-ready-2201",
      plugin: "github",
      status: "open",
      subject: {
        id: "https://github.com/getsentry/junior/pull/2201",
        objectType: "code_change",
        resource: PULL_REQUEST_RESOURCE,
        title: "Update the package to 0.288.0",
        url: "https://github.com/getsentry/junior/pull/2201",
      },
      title: "Ready to merge · #2201",
    },
    {
      // The GitHub plugin's last conflict fix of this pull request did not
      // land. Resume starts a fix and the fix count again.
      body: "#2188 conflicts with `main`, and the last fix did not land. Resume tries again. Dismiss stops these asks for this pull request.",
      conversationId: RELEASE_CONVERSATION_ID,
      createdAt: at(40),
      id: "qa-conflict-2188",
      plugin: "github",
      request: {
        question:
          "#2188 conflicts with `main`, and the last fix did not land. Resume tries again. Dismiss stops these asks for this pull request.",
        fields: [
          {
            id: "choice",
            kind: "choice",
            label: "Merge conflict · #2188",
            options: [{ label: "Resume" }],
          },
        ],
      },
      status: "open",
      subject: {
        id: "https://github.com/getsentry/junior/pull/2188",
        objectType: "code_change",
        resource: PULL_REQUEST_RESOURCE,
        title: "Retry Slack uploads on rate limits",
        url: "https://github.com/getsentry/junior/pull/2188",
      },
      title: "Merge conflict · #2188",
    },
    {
      body: "GitHub asks you to review #91.\n\nhttps://github.com/getsentry/payments/pull/91",
      conversationId: RELEASE_CONVERSATION_ID,
      createdAt: at(89),
      id: "qa-review-91",
      plugin: "github",
      status: "open",
      subject: {
        id: "https://github.com/getsentry/payments/pull/91",
        objectType: "code_change",
        resource: PULL_REQUEST_RESOURCE,
        title: "Pin the release train to payments 4.2",
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
    // A question on the root, and a review request and a notice from two of
    // its Threads, so one stack holds three kinds of item.
    {
      body: "Two GoCD agents hold their lease after the canary stage failed.",
      conversationId: SENTAUR_CONVERSATION_ID,
      createdAt: at(36),
      id: "qa-sentaur-restart",
      request: {
        question: "Restart the two stuck canary agents?",
        fields: [
          {
            id: "restart",
            kind: "choice",
            label: "Agents",
            options: [
              { label: "Restart both", recommended: true },
              { label: "Leave them" },
            ],
          },
        ],
      },
      status: "open",
      title: "Restart the stuck canary agents",
    },
    {
      body: "GitHub asks you to review #418.\n\nhttps://github.com/getsentry/sentaur/pull/418",
      childLabel: "Check the last ten Sentaur pipeline runs",
      conversationId: SENTAUR_RUNS_THREAD_ID,
      createdAt: at(34),
      id: "qa-sentaur-review-418",
      plugin: "github",
      status: "open",
      subject: {
        id: "https://github.com/getsentry/sentaur/pull/418",
        objectType: "code_change",
        resource: PULL_REQUEST_RESOURCE,
        // As the GitHub plugin names it, with its number.
        title: "Retry a canary stage once on a lost agent (#418)",
        url: "https://github.com/getsentry/sentaur/pull/418",
      },
      title: "Review requested · #418",
    },
    {
      body: "Agents 7 and 9 lost their lease during the last three canary stages.",
      childLabel: "Read the canary agent logs",
      conversationId: SENTAUR_LOGS_THREAD_ID,
      createdAt: at(33),
      id: "qa-sentaur-lost-agents",
      kind: "notice",
      status: "open",
      title: "Two agents lost their lease",
    },
    // Three more asks, so the stack folds past its fourth row.
    {
      body: "The canary stage fails on a lost agent three runs out of ten.",
      childLabel: "Check the last ten Sentaur pipeline runs",
      conversationId: SENTAUR_RUNS_THREAD_ID,
      createdAt: at(32),
      id: "qa-sentaur-pause",
      request: {
        question: "Pause canary rollouts until #418 lands?",
        fields: [
          {
            id: "pause",
            kind: "choice",
            label: "Rollouts",
            options: [{ label: "Pause" }, { label: "Keep going" }],
          },
        ],
      },
      status: "open",
      title: "Pause canary rollouts",
    },
    {
      body: "Agent 9 restarted by itself and holds no lease now.",
      childLabel: "Read the canary agent logs",
      conversationId: SENTAUR_LOGS_THREAD_ID,
      createdAt: at(31),
      id: "qa-sentaur-agent-9",
      request: {
        question: "Put agent 9 back in the canary pool?",
        fields: [
          {
            id: "pool",
            kind: "choice",
            label: "Agent 9",
            options: [{ label: "Put it back" }, { label: "Keep it out" }],
          },
        ],
      },
      status: "open",
      title: "Put agent 9 back in the pool",
    },
    {
      body: "Three canary runs failed on a lost agent this week.",
      childLabel: "Check the last ten Sentaur pipeline runs",
      conversationId: SENTAUR_RUNS_THREAD_ID,
      createdAt: at(30),
      id: "qa-sentaur-rerun",
      request: {
        question: "Rerun the three failed canary runs?",
        fields: [
          {
            id: "rerun",
            kind: "choice",
            label: "Runs",
            options: [{ label: "Rerun" }, { label: "Skip" }],
          },
        ],
      },
      status: "open",
      title: "Rerun the failed canary runs",
    },
    {
      assignedToEveryone: true,
      body: "Checkout p95 went from 210 ms to 890 ms after payments-v42 landed.",
      conversationId: LATENCY_CONVERSATION_ID,
      createdAt: at(18),
      id: "qa-p95-rose",
      kind: "notice",
      status: "open",
      subject: PAYMENTS_V42,
      title: "Checkout p95 rose after payments-v42",
    },
    // To-do 13 of the latency Conversation (`todos.ts`) is the viewer's.
    {
      body: "Check the deploy calendar before the next release.",
      conversationId: LATENCY_CONVERSATION_ID,
      createdAt: at(6),
      id: "qa-todo-rollback-window",
      status: "open",
      title: "Confirm the rollback window",
      todoId: 13,
    },
    {
      assignedToEveryone: true,
      body: "Morgan asked to hold the payments-v42 deploy until the serializer fix lands.",
      conversationId: ROLLBACK_CONVERSATION_ID,
      createdAt: at(16),
      id: "qa-hold-v42",
      kind: "notice",
      status: "open",
      subject: PAYMENTS_V42,
      title: "Hold the payments-v42 deploy",
    },
    // Older items, so the inbox has Today, This week, and Earlier.
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
      body: "GitHub asks you to review #3052.\n\nhttps://github.com/getsentry/junior/pull/3052",
      conversationId: SANDBOX_CONVERSATION_ID,
      createdAt: at(2 * DAY),
      id: "qa-review-3052",
      plugin: "github",
      status: "open",
      subject: {
        id: "https://github.com/getsentry/junior/pull/3052",
        objectType: "code_change",
        resource: PULL_REQUEST_RESOURCE,
        title: "Tabs in the dashboard sidebar",
        url: "https://github.com/getsentry/junior/pull/3052",
      },
      title: "Review requested · #3052",
    },
    {
      body: "**Fix the stable list order** merged into main: https://github.com/getsentry/junior/pull/3037",
      conversationId: SANDBOX_CONVERSATION_ID,
      createdAt: at(3 * DAY),
      id: "qa-merged-3037",
      kind: "notice",
      plugin: "github",
      status: "open",
      subject: {
        id: "https://github.com/getsentry/junior/pull/3037",
        objectType: "code_change",
        resource: PULL_REQUEST_RESOURCE,
        title: "Fix the stable list order",
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
      conversationId: RELIABILITY_CONVERSATION_ID,
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
    // Closed items, for Done: one this week, one earlier.
    {
      body: "The release job failed once on a network timeout.",
      closeReason: "The next run passed, so no retry is needed.",
      closedAt: at(2 * DAY),
      conversationId: RELEASE_CONVERSATION_ID,
      createdAt: at(2 * DAY + 90),
      id: "qa-release-retry",
      status: "dismissed",
      title: "Retry the failed release job",
    },
    {
      body: "The on-call handoff notes for last week are in the runbook.",
      closedAt: at(12 * DAY),
      conversationId: DEPLOY_CONVERSATION_ID,
      createdAt: at(13 * DAY),
      id: "qa-handoff-notes",
      kind: "notice",
      status: "done",
      title: "On-call handoff notes posted",
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
    // The alerts of the viewer's Automations that need attention
    // (`fixtures.ts`), as core adds them.
    {
      automationId: "event-1",
      body: "Blocked: GitHub access expired. Reconnect GitHub to resume. Fix the problem, then resume it.",
      createdAt: at(3 * 60),
      id: "qa-alert-closed-issue-summary",
      status: "open",
      title: "Closed issue summary",
    },
    {
      automationId: "scheduled-2",
      body: "Last run failed.",
      createdAt: at(DAY),
      id: "qa-alert-operations-digest",
      // A failed-run alert offers the steps that core takes.
      request: {
        question: "Last run failed.",
        fields: [
          {
            id: "step",
            kind: "choice",
            label: "Next step",
            options: [{ label: "Run again" }, { label: "Pause" }],
          },
        ],
      },
      status: "open",
      title: "Daily operations digest",
    },
  ];
}

type MockItemChange = Pick<
  InboxItemPayload,
  "answer" | "closeReason" | "closedAt" | "closedBy" | "status"
>;

const changes = new Map<string, MockItemChange>();
/** When each snoozed item wakes, by item id, like the server's snoozes. */
const snoozes = new Map<string, number>();

/** Clear viewer actions so tests sharing a worker do not leak them. */
export function resetMockInboxItems(): void {
  changes.clear();
  snoozes.clear();
}

/** The items that a snooze hides now. */
function snoozedItemIds(nowMs: number): Set<string> {
  return new Set(
    [...snoozes].flatMap(([itemId, wakeAtMs]) =>
      wakeAtMs > nowMs ? [itemId] : [],
    ),
  );
}

/**
 * Snooze a mock row, like `POST /api/inbox/snoozes`. It replaces the last,
 * and returns the open items that it hides.
 */
export function snoozeMockRow(nowMs: number, body: InboxSnoozeCreateBody) {
  const inboxItemIds = seeds(nowMs)
    .filter(
      (seed) =>
        (!("conversationId" in body) || rootOf(seed) === body.conversationId) &&
        isOpen(seed) &&
        (!body.inboxItemId || seed.id === body.inboxItemId),
    )
    .map((seed) => seed.id);
  // A snooze with no time waits for its Event, which mock data never sends.
  const wakeAtMs = body.wakeAt ? Date.parse(body.wakeAt) : Infinity;
  for (const id of inboxItemIds) snoozes.set(id, wakeAtMs);
  return { inboxItemIds };
}

/** Wake a mock row, or one item of it, like `DELETE /api/inbox/snoozes`. */
export function wakeMockRow(
  nowMs: number,
  subject: InboxSnoozeSubjectBody,
): void {
  if (subject.inboxItemId) {
    snoozes.delete(subject.inboxItemId);
    return;
  }
  for (const seed of seeds(nowMs)) {
    if ("conversationId" in subject && rootOf(seed) === subject.conversationId)
      snoozes.delete(seed.id);
  }
}

/**
 * The root Conversation whose stack shows the seed: a child's parent. An
 * alert has none.
 */
function rootOf(seed: MockItemSeed): string | undefined {
  return seed.childLabel ? SENTAUR_CONVERSATION_ID : seed.conversationId;
}

function isOpen(seed: MockItemSeed): boolean {
  return (changes.get(seed.id)?.status ?? seed.status) === "open";
}

/**
 * The related work of an open item, like the API: other open items with
 * the same subject, or added in one of its linked Conversations.
 */
function related(seed: MockItemSeed, all: readonly MockItemSeed[]) {
  if (!isOpen(seed)) return undefined;
  const links = seed.linkedConversationIds ?? [];
  const items = all
    .filter(
      (other) =>
        other.id !== seed.id &&
        isOpen(other) &&
        ((seed.subject && other.subject?.id === seed.subject.id) ||
          (other.conversationId !== undefined &&
            links.includes(other.conversationId))),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(({ id, title }) => ({ id, title }));
  return items.length > 0 || links.length > 0
    ? { conversationIds: links, items }
    : undefined;
}

function payload(
  seed: MockItemSeed,
  all: readonly MockItemSeed[],
): InboxItemPayload {
  const {
    automationId,
    childLabel,
    conversationId,
    linkedConversationIds = [],
    plugin: _plugin,
    ...rest
  } = seed;
  const root = rootOf(seed);
  const change = changes.get(seed.id);
  const item = { ...rest, ...change };
  const everyone = seed.assignedToEveryone ?? false;
  const relatedWork = related(seed, all);
  return {
    ...item,
    ...(childLabel ? { addedByLabel: childLabel } : undefined),
    assignedToEveryone: everyone,
    assignees: everyone ? [] : [viewer],
    canAct: item.status === "open",
    canTake: false,
    // A To-do's item links no Conversation, like the API.
    conversationIds:
      seed.todoId === undefined
        ? [
            ...(conversationId ? [conversationId] : []),
            ...linkedConversationIds,
          ]
        : [],
    kind: seed.kind ?? "action",
    owner: automationId
      ? { id: automationId, kind: "automation" }
      : { id: conversationId!, kind: "conversation" },
    ...(root ? { rootConversationId: root } : undefined),
    updatedAt: item.closedAt ?? seed.createdAt,
    visibility: "public",
    ...(relatedWork ? { related: relatedWork } : undefined),
    ...(item.status !== "open"
      ? {
          closedAt: item.closedAt ?? seed.createdAt,
          closedBy: item.closedBy ?? viewer,
        }
      : undefined),
  };
}

/**
 * List the mock items, open first and oldest first, like the API. `closed`
 * lists the done and dismissed items instead, newest closed first.
 */
export function readMockInboxItems(
  nowMs: number,
  filters: {
    closed?: boolean | undefined;
    conversationId?: string | undefined;
    /** Leaves out snoozed rows, like the viewer's Inbox. */
    forViewer?: boolean | undefined;
    q?: string | undefined;
    /** Lists only snoozed rows. */
    snoozed?: boolean | undefined;
  },
): InboxItemPayload[] {
  const q = filters.q?.toLowerCase();
  const snoozed = snoozedItemIds(nowMs);
  const all = seeds(nowMs);
  const items = all
    .filter(
      (seed) =>
        (!filters.conversationId ||
          seed.conversationId === filters.conversationId) &&
        (!q || seed.title.toLowerCase().includes(q)) &&
        (filters.snoozed
          ? snoozed.has(seed.id)
          : !filters.forViewer || !snoozed.has(seed.id)),
    )
    .map((seed) => payload(seed, all));
  if (filters.closed)
    return items
      .filter((item) => item.status !== "open")
      .sort((a, b) => Date.parse(b.closedAt!) - Date.parse(a.closedAt!));
  return items.filter((item) => item.status === "open" || q !== undefined);
}

/** Read one mock item. */
export function readMockInboxItem(
  nowMs: number,
  id: string,
): InboxItemPayload | undefined {
  const all = seeds(nowMs);
  const seed = all.find((candidate) => candidate.id === id);
  return seed ? payload(seed, all) : undefined;
}

/** Apply a viewer action to an open mock item, like the API. */
export function actOnMockInboxItem(
  nowMs: number,
  id: string,
  body: InboxItemActionBody,
): InboxItemPayload | undefined {
  const item = readMockInboxItem(nowMs, id);
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
  return readMockInboxItem(nowMs, id);
}

/**
 * Put the viewer's newest answer on each feed row of the Conversation that
 * added it, like the API.
 */
export function withMockViewerAnswers(
  feed: ConversationFeed,
  nowMs: number,
): ConversationFeed {
  const answers = new Map<string, ConversationFeedViewerAnswer>();
  // Closed items come newest closed first, so the first one wins.
  for (const item of readMockInboxItems(nowMs, { closed: true })) {
    const conversationId =
      item.owner.kind === "conversation" ? item.owner.id : undefined;
    if (
      !conversationId ||
      !item.answer ||
      !item.request ||
      !item.closedAt ||
      item.closedBy?.userId !== viewer.userId ||
      answers.has(conversationId)
    )
      continue;
    answers.set(conversationId, {
      choices: answeredChoices(item.request, item.answer),
      closedAt: item.closedAt,
    });
  }
  return {
    ...feed,
    conversations: feed.conversations.map((conversation) => {
      const viewerAnswer = answers.get(conversation.conversationId);
      return viewerAnswer ? { ...conversation, viewerAnswer } : conversation;
    }),
  };
}

/**
 * Close the oldest open question in a Conversation with a typed message as
 * its answer. It stands in for the model that decides which questions a
 * reply answers.
 */
export function answerMockInboxItemByReply(
  nowMs: number,
  conversationId: string,
  text: string,
): void {
  const item = readMockInboxItems(nowMs, { conversationId }).find(
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
  const open = mockItemsNeedingViewer(nowMs);
  const byConversation = new Map<string, InboxItemPayload[]>();
  // Like the API, a child's items wait in its root. An alert waits in no
  // Conversation.
  for (const item of open) {
    const id = item.rootConversationId;
    if (id) byConversation.set(id, [...(byConversation.get(id) ?? []), item]);
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
  };
}

/** The open mock action items that the viewer must answer. */
function mockItemsNeedingViewer(nowMs: number): InboxItemPayload[] {
  return readMockInboxItems(nowMs, { forViewer: true }).filter(
    (item) => item.kind === "action" && !item.assignedToEveryone,
  );
}

/** Count the mock items like `GET /api/inbox-items/count`, but Automations. */
export function readMockInboxItemCounts(nowMs: number) {
  const needsViewer = mockItemsNeedingViewer(nowMs);
  return {
    // Like the server: the alerts that the Automations To do lists.
    automations: needsViewer.filter((item) => item.owner.kind === "automation")
      .length,
    decisions: needsViewer.filter((item) => item.request).length,
    needsViewer: needsViewer.length,
    codeChanges: needsViewer.filter(
      (item) => item.subject?.objectType === "code_change",
    ).length,
    // Like the server: each snoozed item that is still open.
    snoozed: seeds(nowMs).filter(
      (seed) => isOpen(seed) && snoozedItemIds(nowMs).has(seed.id),
    ).length,
  };
}
