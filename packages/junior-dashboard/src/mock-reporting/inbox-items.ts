/**
 * Process-local Inbox items for mock reporting: the seeds from
 * `inbox-item-seeds.ts`, with the viewer's answers and snoozes applied
 * like the API.
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
import {
  type MockItemSeed,
  SENTAUR_CONVERSATION_ID,
  seeds,
  teammate,
  viewer,
} from "./inbox-item-seeds";

type MockItemChange = Pick<
  InboxItemPayload,
  "answer" | "closeReason" | "closedAt" | "closedBy" | "status"
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
    canTake: false,
    conversationIds: [
      ...(conversationId ? [conversationId] : []),
      ...linkedConversationIds,
    ],
    kind: seed.kind ?? "action",
    owner: automationId
      ? { id: automationId, kind: "automation" }
      : { id: conversationId!, kind: "conversation" },
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
