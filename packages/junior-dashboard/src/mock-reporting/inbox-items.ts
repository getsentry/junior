/**
 * Process-local Inbox items for mock reporting: the seeds from
 * `inbox-item-seeds.ts`, with the viewer's answers and snoozes applied
 * like the API.
 */
import {
  inboxItemQuestion,
  type ConversationQuestionsReport,
  type InboxItemActionBody,
  type InboxItemPayload,
  type InboxSnoozeCreateBody,
  type InboxSnoozeSubjectBody,
} from "@sentry/junior/api/schema";
import type {
  ObjectFacts,
  OwnedObjectAnnotation,
} from "@sentry/junior-plugin-api";
import {
  type MockItemSeed,
  SENTAUR_CONVERSATION_ID,
  seeds,
  teammate,
  viewer,
} from "./inbox-item-seeds";
import { readMockObjectLinks } from "./objects";
import { mockConversationSpaceId } from "./spaces";

type MockItemChange = Pick<
  InboxItemPayload,
  "answer" | "answeredBy" | "closeReason" | "closedAt" | "closedBy" | "status"
>;

const changes = new Map<string, MockItemChange>();
/** When each snoozed item wakes, by item id, like the server's snoozes. */
const snoozes = new Map<string, number>();

/** The woken items that the viewer opened or acted on, by id. */
const openedWakes = new Set<string>();

/** Clear viewer actions so tests sharing a worker do not leak them. */
export function resetMockInboxItems(): void {
  changes.clear();
  snoozes.clear();
  openedWakes.clear();
}

/**
 * Forget why these items woke, like `DELETE /api/inbox/snoozes/wakes`.
 */
export function openMockWakes(inboxItemIds: readonly string[]): void {
  for (const id of inboxItemIds) openedWakes.add(id);
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
  // A snooze with no time waits for its Event, which mock data never sends,
  // or with `untilClosed`, for its item to close.
  const wakeAtMs = body.wakeAt ? Date.parse(body.wakeAt) : Infinity;
  for (const id of inboxItemIds) snoozes.set(id, wakeAtMs);
  openMockWakes(inboxItemIds);
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

// The card of a pull request that has no other mock card.
function pullRequestCard(
  url: string,
  title: string | undefined,
): OwnedObjectAnnotation | undefined {
  if (!title || !URL.canParse(url)) return undefined;
  const parsed = new URL(url);
  const [owner, repo, type, number] = parsed.pathname.split("/").slice(1);
  if (parsed.hostname !== "github.com" || type !== "pull" || !number) {
    return undefined;
  }
  const key = `${owner}/${repo}#${number}`;
  return {
    displayType: "Pull request",
    key,
    kind: "object",
    label: key,
    objectType: "code_change",
    plugin: "github",
    status: "open",
    title,
    url,
  };
}

type CodeChangeFacts = Extract<ObjectFacts, { type: "code_change" }>;

// A mock card with the title and title parts that GitHub has now.
function liveCard(
  card: OwnedObjectAnnotation,
  title: string | undefined,
  titleParts: CodeChangeFacts["titleParts"],
): OwnedObjectAnnotation {
  const live: OwnedObjectAnnotation = { ...card };
  if (title) live.title = title;
  if (card.objectType === "code_change") {
    const facts: CodeChangeFacts =
      card.facts?.type === "code_change"
        ? { ...card.facts }
        : { type: "code_change" };
    if (titleParts) facts.titleParts = titleParts;
    live.facts = facts;
  }
  return live;
}

/**
 * The subject of a seed, like the API: its kind and id, the label of the
 * kind, and the card of its link with the title that GitHub has now.
 */
function subjectOf(seed: MockItemSeed): InboxItemPayload["subject"] {
  const defaultKind =
    seed.todoId !== undefined
      ? "todo"
      : seed.automationId
        ? "automation"
        : "question";
  if (!seed.subject) {
    return {
      id: seed.todoId?.toString() ?? seed.automationId ?? seed.id,
      kind: defaultKind,
    };
  }
  const { kind = defaultKind, title, titleParts, ...rest } = seed.subject;
  const subject: InboxItemPayload["subject"] = { ...rest, kind };
  const card = subject.url
    ? (readMockObjectLinks([subject.url]).objects[0]?.object ??
      pullRequestCard(subject.url, title))
    : undefined;
  if (card) subject.object = liveCard(card, title, titleParts);
  return subject;
}

function payload(
  seed: MockItemSeed,
  all: readonly MockItemSeed[],
  nowMs: number,
): InboxItemPayload {
  const {
    automationId,
    childLabel,
    conversationId,
    linkedConversationIds = [],
    plugin: _plugin,
    shared,
    subject: _subject,
    wake,
    ...rest
  } = seed;
  const root = rootOf(seed);
  const change = changes.get(seed.id);
  const item = { ...rest, ...change };
  const everyone = seed.assignedToEveryone ?? false;
  const relatedWork = related(seed, all);
  const snoozedByViewer =
    item.status === "open" && (snoozes.get(seed.id) ?? -Infinity) > nowMs;
  return {
    ...item,
    ...(childLabel ? { addedByLabel: childLabel } : undefined),
    ...(snoozedByViewer ? { snoozedByViewer: true as const } : undefined),
    assignedToEveryone: everyone,
    assignees: everyone ? [] : shared ? [viewer, teammate] : [viewer],
    canAct: item.status === "open",
    canAnswer: item.status === "open",
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
    subject: subjectOf(seed),
    ...(root ? { rootConversationId: root } : undefined),
    updatedAt: item.closedAt ?? seed.createdAt,
    visibility: "public",
    ...(relatedWork ? { related: relatedWork } : undefined),
    ...(wake && item.status === "open" && !openedWakes.has(seed.id)
      ? { wake }
      : undefined),
    ...(item.status !== "open"
      ? {
          closedAt: item.closedAt ?? seed.createdAt,
          closedBy: item.closedBy ?? viewer,
        }
      : undefined),
    ...(item.answer ? { answeredBy: item.answeredBy ?? viewer } : undefined),
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
    .map((seed) => payload(seed, all, nowMs));
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
  return seed ? payload(seed, all, nowMs) : undefined;
}

/** Apply a viewer action to an open mock item, like the API. */
export function actOnMockInboxItem(
  nowMs: number,
  id: string,
  body: InboxItemActionBody,
): InboxItemPayload | undefined {
  const item = readMockInboxItem(nowMs, id);
  if (!item || item.status !== "open") return item;
  openMockWakes([id]);
  if (body.action === "take") return readMockInboxItem(nowMs, id);
  changes.set(id, {
    closedAt: new Date(nowMs).toISOString(),
    closedBy: viewer,
    status: body.action === "dismiss" ? "dismissed" : "done",
    ...(body.action === "submit"
      ? { answer: { ...body.answer, requestId: id }, answeredBy: viewer }
      : undefined),
  });
  return readMockInboxItem(nowMs, id);
}

/**
 * List the questions that agents asked in one mock Conversation, with the
 * viewer's answers, like `GET /api/conversations/:id/questions`. A mock
 * question has its item's id, so the mock tool results name no subject.
 */
export function readMockConversationQuestions(
  nowMs: number,
  conversationId: string,
): ConversationQuestionsReport {
  const all = seeds(nowMs);
  return {
    conversationId,
    questions: all
      .filter(
        (seed) =>
          seed.conversationId === conversationId &&
          subjectOf(seed).kind === "question",
      )
      .map((seed) => payload(seed, all, nowMs))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((item) => ({
        body: item.body,
        createdAt: item.createdAt,
        id: item.id,
        title: item.title,
        updatedAt: item.updatedAt,
        ...(item.answer ? { answer: item.answer } : undefined),
        ...(item.mentions ? { mentions: item.mentions } : undefined),
        ...(item.request ? { request: item.request } : undefined),
        ...(item.addedByTurnId ? { turnId: item.addedByTurnId } : undefined),
      })),
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
  const item = readMockInboxItems(nowMs, { conversationId }).find((candidate) =>
    inboxItemQuestion(candidate.request),
  );
  if (!item) return;
  changes.set(item.id, {
    answer: { other: text, requestId: item.id, values: {} },
    answeredBy: viewer,
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
      ...(mockConversationSpaceId(conversationId)
        ? { spaceId: mockConversationSpaceId(conversationId) }
        : undefined),
      // A mock child sits right under its root.
      conversationIds: [
        ...new Set([conversationId, ...items.map((item) => item.owner.id)]),
      ],
      items: [...items]
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .map(({ id, owner, title }) => {
          const plugin = plugins.get(id);
          return {
            conversationId: owner.id,
            id,
            title,
            ...(plugin ? { plugin } : undefined),
          };
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
    decisions: needsViewer.filter((item) => inboxItemQuestion(item.request))
      .length,
    needsViewer: needsViewer.length,
    // Like the server: a code change's own asks. A question that cites one
    // is a decision.
    codeChanges: needsViewer.filter(
      (item) =>
        item.subject?.objectType === "code_change" &&
        item.subject.kind.includes(":"),
    ).length,
    // Like the server: each snoozed item that is still open.
    snoozed: seeds(nowMs).filter(
      (seed) => isOpen(seed) && snoozedItemIds(nowMs).has(seed.id),
    ).length,
    todos: needsViewer.filter((item) => item.todoId !== undefined).length,
  };
}
