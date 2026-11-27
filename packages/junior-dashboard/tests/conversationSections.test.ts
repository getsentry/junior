import { describe, expect, it } from "vitest";

import {
  attentionOrder,
  buildTimeSections,
  pinnedFirst,
} from "../src/client/conversations/conversationSections";
import type { Conversation } from "../src/client/types";

function conversation(id: string, lastSeenAt: string): Conversation {
  return {
    kind: "thread",
    cumulativeDurationMs: 0,
    displayTitle: id,
    id,
    isParticipant: true,
    lastProgressAt: lastSeenAt,
    lastSeenAt,
    startedAt: lastSeenAt,
    status: "done",
    turnActive: false,
    surface: "internal",
  };
}

const NOW = {
  nowMs: Date.parse("2026-08-03T12:00:00-07:00"),
  timeZone: "America/Los_Angeles",
};

function sectionIds(sections: ReturnType<typeof buildTimeSections>) {
  return sections.map((section) => ({
    conversations: section.conversations.map((item) => item.id),
    label: section.label,
  }));
}

describe("conversation activity sections", () => {
  it("groups by last activity into rolling windows, then months", () => {
    const sections = buildTimeSections(
      [
        conversation("last-year", "2025-12-01T12:00:00-08:00"),
        conversation("june", "2026-06-20T12:00:00-07:00"),
        conversation("31-days", "2026-07-03T12:00:00-07:00"),
        conversation("30-days", "2026-07-04T12:00:00-07:00"),
        conversation("8-days", "2026-07-26T12:00:00-07:00"),
        conversation("7-days", "2026-07-27T12:00:00-07:00"),
        conversation("saturday", "2026-08-01T10:00:00-07:00"),
        conversation("yesterday", "2026-08-02T23:30:00-07:00"),
        conversation("today-early", "2026-08-03T00:10:00-07:00"),
        conversation("today-late", "2026-08-03T11:45:00-07:00"),
      ],
      NOW,
    );

    expect(sectionIds(sections)).toEqual([
      { conversations: ["today-late", "today-early"], label: "Today" },
      { conversations: ["yesterday"], label: "Yesterday" },
      { conversations: ["saturday", "7-days"], label: "Previous 7 days" },
      { conversations: ["8-days", "30-days"], label: "Previous 30 days" },
      { conversations: ["31-days"], label: "July" },
      { conversations: ["june"], label: "June" },
      { conversations: ["last-year"], label: "December 2025" },
    ]);
  });

  it("keeps conversations that wait on the viewer in their time section", () => {
    const sections = buildTimeSections(
      [
        conversation("today", "2026-08-03T11:00:00-07:00"),
        // A Turn parked for authorization leaves the conversation idle.
        {
          ...conversation("connecting", "2026-08-02T10:00:00-07:00"),
          awaitingAuthorization: true,
        },
        conversation("saturday", "2026-08-01T12:00:00-07:00"),
      ],
      NOW,
    );

    expect(sectionIds(sections)).toEqual([
      { conversations: ["today"], label: "Today" },
      { conversations: ["connecting"], label: "Yesterday" },
      { conversations: ["saturday"], label: "Previous 7 days" },
    ]);
  });

  it("sorts and groups by the last Message, not by later tool or status events", () => {
    const sections = buildTimeSections(
      [
        // A tool event moved its activity today; its last Message was
        // yesterday.
        {
          ...conversation("tool-today", "2026-08-03T11:50:00-07:00"),
          lastMessageAt: "2026-08-02T10:00:00-07:00",
        },
        {
          ...conversation("reply-early", "2026-08-03T11:55:00-07:00"),
          lastMessageAt: "2026-08-03T08:00:00-07:00",
        },
        {
          ...conversation("reply-late", "2026-08-03T09:00:00-07:00"),
          lastMessageAt: "2026-08-03T09:00:00-07:00",
        },
        // No Message yet: it uses its last activity.
        conversation("no-message", "2026-08-03T10:00:00-07:00"),
      ],
      NOW,
    );

    expect(sectionIds(sections)).toEqual([
      {
        conversations: ["no-message", "reply-late", "reply-early"],
        label: "Today",
      },
      { conversations: ["tool-today"], label: "Yesterday" },
    ]);
  });

  it("moves pinned conversations before paging, the rest by last Message", () => {
    const feed = [
      conversation("recent", "2026-08-03T11:00:00-07:00"),
      {
        ...conversation("tool-only", "2026-08-03T11:30:00-07:00"),
        lastMessageAt: "2026-08-01T11:00:00-07:00",
      },
      {
        ...conversation("pinned", "2026-08-01T10:00:00-07:00"),
        pinnedAt: "2026-08-03T08:00:00-07:00",
      },
      conversation("older", "2026-08-02T10:00:00-07:00"),
    ];

    expect(pinnedFirst(feed).map((item) => item.id)).toEqual([
      "pinned",
      "recent",
      "older",
      "tool-only",
    ]);
  });
});

describe("attention order", () => {
  const at = (hour: number) =>
    `2026-08-03T${String(hour).padStart(2, "0")}:00:00-07:00`;
  const feed: Conversation[] = [
    conversation("done-new", at(11)),
    { ...conversation("working-old", at(2)), treeState: "working" },
    {
      ...conversation("waiting", at(9)),
      treeState: "done",
      watching: true,
    },
    { ...conversation("needs-old", at(1)), treeState: "needs_you" },
    { ...conversation("working-new", at(10)), treeState: "working" },
    { ...conversation("failed", at(8)), latestTurnFailed: true },
    {
      ...conversation("pinned-done", at(7)),
      pinnedAt: "2026-08-03T08:00:00-07:00",
    },
    {
      ...conversation("tool-only", at(12)),
      lastMessageAt: at(3),
      treeState: "needs_you",
    },
    conversation("done-old", at(4)),
  ];

  it("orders feed rows by tree state, then last Message", () => {
    expect(attentionOrder(feed).map((item) => item.id)).toEqual([
      // A failed latest Turn needs the viewer. A tool event does not move a
      // row: the last Message sorts it.
      "failed",
      "tool-only",
      "needs-old",
      "working-new",
      "working-old",
      // A watching tree waits.
      "waiting",
      // A pin does not change the group.
      "done-new",
      "pinned-done",
      "done-old",
    ]);
  });
});
