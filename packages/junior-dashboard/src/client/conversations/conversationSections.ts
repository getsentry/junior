import type { Conversation } from "../types";

export type ConversationSection = {
  conversations: Conversation[];
  key: string;
  label: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const SECTION_ORDER = [
  "priority",
  "today",
  "yesterday",
  "last-week",
  "2-weeks",
  "3-weeks",
  "older",
] as const;

/** Group conversations into progressively broader activity sections. */
export function buildConversationSections(
  conversations: Conversation[],
  options: { nowMs: number; timeZone: string },
): ConversationSection[] {
  const nowDay = calendarDay(options.nowMs, options.timeZone);
  const sections = new Map<string, ConversationSection>();
  const sorted = [...conversations].sort(
    (left, right) => activityTime(right) - activityTime(left),
  );

  for (const conversation of sorted) {
    const time = activityTime(conversation);
    const section = conversationSection(
      conversation,
      time,
      nowDay,
      options.timeZone,
    );
    const existing = sections.get(section.key);
    if (existing) {
      existing.conversations.push(conversation);
    } else {
      sections.set(section.key, { ...section, conversations: [conversation] });
    }
  }

  return [...sections.values()].sort(
    (left, right) => sectionRank(left.key) - sectionRank(right.key),
  );
}

function activityTime(conversation: Conversation): number {
  const time = Date.parse(conversation.lastSeenAt);
  return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY;
}

function conversationSection(
  conversation: Conversation,
  time: number,
  nowDay: number,
  timeZone: string,
): Pick<ConversationSection, "key" | "label"> {
  if (!Number.isFinite(time)) return { key: "older", label: "Older" };

  // Priority membership is decided by the conversation feed API.
  if (conversation.isPriority) {
    return { key: "priority", label: "Priority" };
  }

  const day = calendarDay(time, timeZone);
  const ageInDays = Math.max(0, Math.floor((nowDay - day) / DAY_MS));
  if (ageInDays === 0) return { key: "today", label: "Today" };
  if (ageInDays === 1) return { key: "yesterday", label: "Yesterday" };
  if (ageInDays < 7) {
    return {
      key: `day-${day}`,
      label: new Intl.DateTimeFormat("en-US", {
        timeZone,
        weekday: "long",
      }).format(time),
    };
  }
  if (ageInDays < 14) return { key: "last-week", label: "Last week" };
  if (ageInDays < 21) return { key: "2-weeks", label: "2 weeks ago" };
  if (ageInDays < 28) return { key: "3-weeks", label: "3 weeks ago" };
  return { key: "older", label: "Older" };
}

function sectionRank(key: string): number {
  const known = SECTION_ORDER.indexOf(key as (typeof SECTION_ORDER)[number]);
  if (known >= 0) return known;
  // Weekday buckets sit between Yesterday and Last week.
  if (key.startsWith("day-")) return SECTION_ORDER.indexOf("yesterday") + 0.5;
  return SECTION_ORDER.length;
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
