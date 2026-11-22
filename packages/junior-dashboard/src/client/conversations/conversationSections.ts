import type { WaitingConversation } from "../inbox/queries";
import type { Conversation } from "../types";
import {
  calendarDay,
  calendarDaysAgo,
  dateTimeFormat,
  formatTime,
} from "../time";

export type ConversationSection = {
  conversations: Conversation[];
  key: string;
  label: string;
};

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
 * Without `waiting`, there is no Needs you: a conversation that waits on
 * the viewer stays in its section, and its row carries the waiting marker.
 * The new UI groups with `buildTimeSections` instead.
 *
 * Needs you holds the conversations that wait on the viewer: an open Review
 * item in `waiting`, or a Turn that waits on an authorization. Open work
 * does not move a row. A pinned conversation
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
    waiting?: Waiting;
  },
): ConversationSection[] {
  const nowDay = calendarDay(options.nowMs, options.timeZone);
  const sections = groupSections(conversations, (conversation) =>
    conversation.pinnedAt
      ? PINNED_SECTION
      : options.waiting && waitsOnViewer(conversation, options.waiting)
        ? NEEDS_YOU_SECTION
        : conversationSection(
            activityTime(conversation),
            nowDay,
            options.nowMs,
            options.timeZone,
          ),
  );
  const section = (key: string) =>
    sections.find((candidate) => candidate.key === key)?.conversations;
  section(PINNED_SECTION.key)?.sort(comparePinOrder);
  const waiting = options.waiting;
  if (waiting) section(NEEDS_YOU_SECTION.key)?.sort(compareWaitStart(waiting));
  return sections;
}

/**
 * Put each conversation, newest Message first, in the section that
 * `sectionOf` names, and order the sections by their `order`.
 */
function groupSections(
  conversations: Conversation[],
  sectionOf: (
    conversation: Conversation,
  ) => Pick<ConversationSection, "key" | "label"> & { order: number },
): ConversationSection[] {
  const sections = new Map<string, ConversationSection & { order: number }>();
  for (const conversation of newestFirst(conversations)) {
    const section = sectionOf(conversation);
    const existing = sections.get(section.key);
    if (existing) {
      existing.conversations.push(conversation);
    } else {
      sections.set(section.key, { ...section, conversations: [conversation] });
    }
  }
  return [...sections.values()]
    .sort((left, right) => left.order - right.order)
    .map(({ order: _order, ...section }) => section);
}

/**
 * True when the conversation waits on the viewer: an open Inbox item waits
 * on them, or a Turn waits on a person to finish an authorization.
 */
function waitsOnViewer(conversation: Conversation, waiting: Waiting): boolean {
  return (
    waiting.has(conversation.id) || conversation.awaitingAuthorization === true
  );
}

/**
 * Sort pinned conversations to the front, in the order that
 * `buildConversationSections` shows them without `waiting`: pins in the
 * viewer's order, then the newest Message first. Paginated lists call this
 * before paging, so page 1 holds every pin, and pages split where the
 * sections do.
 */
export function pinnedFirst(conversations: Conversation[]): Conversation[] {
  return newestFirst(conversations).sort((left, right) => {
    const leftRank = left.pinnedAt ? 0 : 1;
    return (
      leftRank - (right.pinnedAt ? 0 : 1) ||
      (leftRank === 0 ? comparePinOrder(left, right) : 0)
    );
  });
}

/** Sort conversations by their last Message, newest first. */
export function newestFirst(conversations: Conversation[]): Conversation[] {
  return [...conversations].sort(
    (left, right) => activityTime(right) - activityTime(left),
  );
}

/**
 * Group conversations by last Message only, as the new UI lists them: a pin
 * or a wait on the viewer stays in its time section, and its row carries
 * the marker. Sections and their rows run newest first.
 */
export function buildTimeSections(
  conversations: Conversation[],
  options: { nowMs: number; timeZone: string },
): ConversationSection[] {
  const nowDay = calendarDay(options.nowMs, options.timeZone);
  return groupSections(conversations, (conversation) =>
    conversationSection(
      activityTime(conversation),
      nowDay,
      options.nowMs,
      options.timeZone,
    ),
  );
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
    conversation.pinnedAt ? 0 : waitsOnViewer(conversation, waiting) ? 1 : 2;
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
    label: formatTime(time, {
      month: "long",
      timeZone,
      ...(month.year === nowMonth.year ? undefined : { year: "numeric" }),
    }),
    // Month sections follow the rolling windows, newest month first.
    order:
      4 + (nowMonth.year - month.year) * 12 + (nowMonth.month - month.month),
  };
}

function yearMonth(
  time: number,
  timeZone: string,
): { month: number; year: number } {
  const parts = dateTimeFormat({
    month: "numeric",
    timeZone,
    year: "numeric",
  }).formatToParts(time);
  const values = new Map(parts.map((part) => [part.type, Number(part.value)]));
  return { month: values.get("month") ?? 1, year: values.get("year") ?? 0 };
}
