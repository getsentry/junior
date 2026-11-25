import type { Conversation } from "../types";
import { conversationDisplayState } from "./ConversationStateIcon";
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
 * Order conversations by what they need from the viewer. In flight and a
 * Space's Conversation list both use this order:
 *
 * 1. Pins, in the viewer's order.
 * 2. Conversations that wait on the viewer: an open action Inbox item or a
 *    sign-in in their tree.
 * 3. The rest that are not done: working, watching for an Event or Timer,
 *    or with a failed latest Turn.
 * 4. Done.
 *
 * Each group after the pins runs newest Message first.
 */
export function attentionOrder(conversations: Conversation[]): Conversation[] {
  return newestFirst(conversations).sort((left, right) => {
    const leftRank = attentionRank(left);
    return (
      leftRank - attentionRank(right) ||
      (leftRank === 0 ? comparePinOrder(left, right) : 0)
    );
  });
}

function attentionRank(conversation: Conversation): number {
  if (conversation.pinnedAt) return 0;
  const state = conversationDisplayState(conversation);
  if (state === "needs_you") return 1;
  if (state || conversation.latestTurnFailed) return 2;
  return 3;
}

/** Sort conversations by their last Message, newest first. */
export function newestFirst(conversations: Conversation[]): Conversation[] {
  return [...conversations].sort(
    (left, right) => activityTime(right) - activityTime(left),
  );
}

/**
 * Group conversations by last Message: Today, Yesterday, Previous 7 days,
 * Previous 30 days, then one section per month. A pin or a wait on the
 * viewer stays in its time section, and its row carries the marker.
 * Sections and their rows run newest first.
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
