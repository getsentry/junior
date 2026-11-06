import type { Conversation } from "../types";

export type ConversationSection = {
  conversations: Conversation[];
  key: string;
  label: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;
// Pinned sorts first, then Needs attention, then every time section.
const PINNED_SECTION = { key: "pinned", label: "Pinned", order: -2 };
const ATTENTION_SECTION = {
  key: "attention",
  label: "Needs attention",
  order: -1,
};

/**
 * Group conversations into Pinned, then Needs attention, then by last
 * activity: Today, Yesterday, Previous 7 days, Previous 30 days, then one
 * section per month.
 *
 * A pinned conversation shows only in Pinned, even when it needs attention.
 * Conversations in `attentionIds` go to Needs attention. Pinned follows the
 * viewer's order; every other section lists the newest first.
 */
export function buildConversationSections(
  conversations: Conversation[],
  options: {
    attentionIds?: ReadonlySet<string>;
    nowMs: number;
    timeZone: string;
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
      : options.attentionIds?.has(conversation.id)
        ? ATTENTION_SECTION
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
  return [...sections.values()]
    .sort((left, right) => left.order - right.order)
    .map(({ order: _order, ...section }) => section);
}

/** Join the conversations that wait on the viewer or are unread. */
export function attentionConversationIds(
  conversations: readonly Conversation[],
  waitingConversationIds: Iterable<string>,
): ReadonlySet<string> {
  return new Set([
    ...waitingConversationIds,
    ...conversations
      .filter((conversation) => conversation.unread)
      .map((conversation) => conversation.id),
  ]);
}

/**
 * Sort pinned, then attention conversations to the front. Pinned follows the
 * viewer's order. The sort is stable, so the other groups keep the feed order.
 * Paginated lists call this before paging, so page 1 holds every pinned and
 * attention conversation.
 */
export function pinnedAndAttentionFirst(
  conversations: Conversation[],
  attentionIds: ReadonlySet<string>,
): Conversation[] {
  const rank = (conversation: Conversation) =>
    conversation.pinnedAt ? 0 : attentionIds.has(conversation.id) ? 1 : 2;
  return [...conversations].sort(
    (left, right) =>
      rank(left) - rank(right) ||
      (left.pinnedAt && right.pinnedAt ? comparePinOrder(left, right) : 0),
  );
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

function activityTime(conversation: Conversation): number {
  const time = Date.parse(conversation.lastSeenAt);
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

  const ageInDays = Math.max(
    0,
    Math.round((nowDay - calendarDay(time, timeZone)) / DAY_MS),
  );
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

function calendarDay(time: number, timeZone: string): number {
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
