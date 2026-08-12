import { describe, expect, it } from "vitest";

import { buildConversationSections } from "../src/client/conversations/conversationSections";
import type { Conversation } from "../src/client/types";

function conversation(
  id: string,
  lastSeenAt: string,
  unfinishedWork = false,
): Conversation {
  return {
    cumulativeDurationMs: 0,
    displayTitle: id,
    id,
    lastProgressAt: lastSeenAt,
    lastSeenAt,
    startedAt: lastSeenAt,
    status: "completed",
    surface: "internal",
    ...(unfinishedWork ? { unfinishedWork: true } : {}),
  };
}

describe("conversation activity sections", () => {
  it("keeps recent conversations first and broadens older date groups", () => {
    const sections = buildConversationSections(
      [
        conversation("older", "2026-06-20T12:00:00-07:00"),
        conversation("two-weeks", "2026-07-19T12:00:00-07:00"),
        conversation("priority", "2026-08-03T11:00:00-07:00", true),
        conversation("last-week", "2026-07-26T12:00:00-07:00"),
        conversation("today-earlier", "2026-08-03T08:00:00-07:00"),
        conversation("priority-yesterday", "2026-08-02T13:00:00-07:00", true),
        conversation("yesterday", "2026-08-02T12:00:00-07:00"),
        conversation("weekday", "2026-08-01T12:00:00-07:00"),
        conversation("three-weeks", "2026-07-12T12:00:00-07:00"),
      ],
      {
        nowMs: Date.parse("2026-08-03T12:00:00-07:00"),
        timeZone: "America/Los_Angeles",
      },
    );

    expect(
      sections.map((section) => ({
        conversations: section.conversations.map((item) => item.id),
        label: section.label,
      })),
    ).toEqual([
      {
        conversations: ["priority", "priority-yesterday"],
        label: "Priority",
      },
      {
        conversations: ["today-earlier"],
        label: "Today",
      },
      { conversations: ["yesterday"], label: "Yesterday" },
      { conversations: ["weekday"], label: "Saturday" },
      { conversations: ["last-week"], label: "Last week" },
      { conversations: ["two-weeks"], label: "2 weeks ago" },
      { conversations: ["three-weeks"], label: "3 weeks ago" },
      { conversations: ["older"], label: "Older" },
    ]);
  });
});
