import type { WaitingConversation } from "../review-desk/queries";
import type { Conversation } from "../types";

export type ConversationSection = {
  conversations: Conversation[];
  key: string;
  label: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;
// Pinned sorts first, then Needs you, then every time section.
const PINNED_SECTION = { key: "pinned", label: "Pinned", order: -2 };
const NEEDS_YOU_SECTION = { key: "needs-you", label: "Needs you", order: -1 };

/** Conversations that wait on the viewer, by id, with their wait start. */
type Waiting = Pick<
  ReadonlyMap<string, Pick<WaitingConversation, "waitingSince">>,
  "get" | "has"
>;

/**
 * Group conversations into Pinned, then Needs you, then by last Message:
 * Today, Yesterday, Previous 7 days, Previous 30 days, then one section per
 * month.
 *
 * Needs you holds only the conversations in `waiting`, which wait on the
 * viewer. Unread and open work do not move a row. A pinned conversation
 * shows only in Pinned, even when it waits on the viewer. Pinned follows the
 * viewer's order. Needs you lists the longest wait first, so the queue keeps
 * its order while the viewer works it. Every other section lists the newest
 * Message first.
 */
export function buildConversationSections(
  conversations: Conversation[],
  options: {
    nowMs: number;
    timeZone: string;
    waiting: Waiting;
  },
): ConversationSection[] {
  const nowDay = calendarDay(options.nowMs, options.timeZone);
  const sections = new Map<string, ConversationSection & { order: number }>();
  const sorted = [...conversations].sort(
    (left, right) => activityTime(right) - activityTime(left),
  );

  for (const conversation of sorted) {
    const section = conversation.pinnedAt
      ? PINNED_SECTION
      : options.waiting.has(conversation.id)
        ? NEEDS_YOU_SECTION
        : conversationSection(
            activityTime(conversation),
            nowDay,
            options.nowMs,
            options.timeZone,
          );
    const existing = sections.get(section.key);
    if (existing) {
      existing.conversations.push(conversation);
    } else {
      sections.set(section.key, { ...section, conversations: [conversation] });
    }
  }

  sections.get(PINNED_SECTION.key)?.conversations.sort(comparePinOrder);
  sections
    .get(NEEDS_YOU_SECTION.key)
    ?.conversations.sort(compareWaitStart(options.waiting));
  return [...sections.values()]
    .sort((left, right) => left.order - right.order)
    .map(({ order: _order, ...section }) => section);
}

/**
 * Sort pinned, then waiting conversations to the front, in the order that
 * `buildConversationSections` shows them: pins in the viewer's order, the
 * longest wait first, then the newest Message first. Paginated lists call
 * this before paging, so page 1 holds every pinned and waiting conversation,
 * and pages split where the sections do.
 */
export function pinnedAndWaitingFirst(
  conversations: Conversation[],
  waiting: Waiting,
): Conversation[] {
  const rank = (conversation: Conversation) =>
    conversation.pinnedAt ? 0 : waiting.has(conversation.id) ? 1 : 2;
  const byWait = compareWaitStart(waiting);
  return [...conversations]
    .sort((left, right) => activityTime(right) - activityTime(left))
    .sort((left, right) => {
      const leftRank = rank(left);
      return (
        leftRank - rank(right) ||
        (leftRank === 0
          ? comparePinOrder(left, right)
          : leftRank === 1
            ? byWait(left, right)
            : 0)
      );
    });
}

/**
 * Order pins by the viewer's places. Pins without a place, from before the
 * first reorder or pinned since, go first, newest pin first. Activity never
 * moves a pin.
 */
function comparePinOrder(left: Conversation, right: Conversation): number {
  return (
    (left.pinPosition ?? Number.NEGATIVE_INFINITY) -
      (right.pinPosition ?? Number.NEGATIVE_INFINITY) ||
    pinTime(right) - pinTime(left) ||
    left.id.localeCompare(right.id)
  );
}

function pinTime(conversation: Conversation): number {
  return conversation.pinnedAt ? Date.parse(conversation.pinnedAt) || 0 : 0;
}

/**
 * Order the longest wait first. A conversation with no known wait start
 * follows those that have one, newest first. The stable sort keeps that
 * activity order.
 */
function compareWaitStart(
  waiting: Waiting,
): (left: Conversation, right: Conversation) => number {
  const start = (conversation: Conversation) => {
    const time = Date.parse(waiting.get(conversation.id)?.waitingSince ?? "");
    return Number.isFinite(time) ? time : Number.POSITIVE_INFINITY;
  };
  return (left, right) => {
    const leftStart = start(left);
    const rightStart = start(right);
    return leftStart === rightStart ? 0 : leftStart < rightStart ? -1 : 1;
  };
}

/**
 * The time that sorts and groups a row: its last Message from a person or
 * shown Junior reply. Tool, status, and quiet events do not move a row. A
 * row with no Message yet uses its last activity.
 */
function activityTime(conversation: Conversation): number {
  const time = Date.parse(
    conversation.lastMessageAt ?? conversation.lastSeenAt,
  );
  return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY;
}

/**
 * Pick the section for an activity time. `order` sorts sections newest
 * first.
 */
function conversationSection(
  time: number,
  nowDay: number,
  nowMs: number,
  timeZone: string,
): Pick<ConversationSection, "key" | "label"> & { order: number } {
  if (!Number.isFinite(time)) {
    return { key: "older", label: "Older", order: Number.POSITIVE_INFINITY };
  }

  const ageInDays = Math.max(0, calendarDaysAgo(time, nowDay, timeZone));
  if (ageInDays === 0) return { key: "today", label: "Today", order: 0 };
  if (ageInDays === 1) {
    return { key: "yesterday", label: "Yesterday", order: 1 };
  }
  if (ageInDays <= 7) {
    return { key: "previous-7-days", label: "Previous 7 days", order: 2 };
  }
  if (ageInDays <= 30) {
    return { key: "previous-30-days", label: "Previous 30 days", order: 3 };
  }

  const month = yearMonth(time, timeZone);
  const nowMonth = yearMonth(nowMs, timeZone);
  return {
    key: `month-${month.year}-${month.month}`,
    label: new Intl.DateTimeFormat("en-US", {
      month: "long",
      timeZone,
      ...(month.year === nowMonth.year ? undefined : { year: "numeric" }),
    }).format(time),
    // Month sections follow the rolling windows, newest month first.
    order:
      4 + (nowMonth.year - month.year) * 12 + (nowMonth.month - month.month),
  };
}

function yearMonth(
  time: number,
  timeZone: string,
): { month: number; year: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    month: "numeric",
    timeZone,
    year: "numeric",
  }).formatToParts(time);
  const values = new Map(parts.map((part) => [part.type, Number(part.value)]));
  return { month: values.get("month") ?? 1, year: values.get("year") ?? 0 };
}

/** Count the calendar days from `time` to `nowDay` (a `calendarDay` value). */
export function calendarDaysAgo(
  time: number,
  nowDay: number,
  timeZone: string,
): number {
  return Math.round((nowDay - calendarDay(time, timeZone)) / DAY_MS);
}

/** Return the UTC midnight of the calendar day that holds `time` in `timeZone`. */
export function calendarDay(time: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "numeric",
    timeZone,
    year: "numeric",
  }).formatToParts(time);
  const values = new Map(parts.map((part) => [part.type, Number(part.value)]));
  return Date.UTC(
    values.get("year") ?? 0,
    (values.get("month") ?? 1) - 1,
    values.get("day") ?? 1,
  );
}
