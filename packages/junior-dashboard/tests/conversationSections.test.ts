import { describe, expect, it } from "vitest";

import {
  buildConversationSections,
  pinnedFirst,
} from "../src/client/conversations/conversationSections";
import type { Conversation } from "../src/client/types";

function conversation(id: string, lastSeenAt: string): Conversation {
  return {
    kind: "root",
    cumulativeDurationMs: 0,
    displayTitle: id,
    id,
    isParticipant: true,
    lastProgressAt: lastSeenAt,
    lastSeenAt,
    startedAt: lastSeenAt,
    status: "completed",
    surface: "internal",
  };
}

const NOW = {
  nowMs: Date.parse("2026-08-03T12:00:00-07:00"),
  timeZone: "America/Los_Angeles",
};

function sectionIds(sections: ReturnType<typeof buildConversationSections>) {
  return sections.map((section) => ({
    conversations: section.conversations.map((item) => item.id),
    label: section.label,
  }));
}

describe("conversation activity sections", () => {
  it("groups by last activity into rolling windows, then months", () => {
    const sections = buildConversationSections(
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
    const sections = buildConversationSections(
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

  it("puts pinned conversations only in Pinned, first", () => {
    const pinned = (
      id: string,
      lastSeenAt: string,
      pinnedAt: string,
      pinPosition?: number,
    ) => ({ ...conversation(id, lastSeenAt), pinnedAt, pinPosition });
    const sections = buildConversationSections(
      [
        conversation("today", "2026-08-03T11:00:00-07:00"),
        // The older pin has the newer activity.
        pinned(
          "pinned-earlier",
          "2026-08-03T10:00:00-07:00",
          "2026-07-01T08:00:00-07:00",
        ),
        pinned(
          "pinned-later",
          "2026-06-20T12:00:00-07:00",
          "2026-08-01T15:00:00Z",
        ),
        pinned(
          "placed-second",
          "2026-08-03T11:30:00-07:00",
          "2026-06-01T08:00:00-07:00",
          1,
        ),
        pinned(
          "placed-first",
          "2026-06-01T12:00:00-07:00",
          "2026-08-02T08:00:00-07:00",
          0,
        ),
        conversation("earlier", "2026-08-03T09:00:00-07:00"),
      ],
      NOW,
    );

    // Pins without a place go first, newest pin first, then the viewer's
    // order. Activity does not move a pin.
    expect(sectionIds(sections)).toEqual([
      {
        conversations: [
          "pinned-later",
          "pinned-earlier",
          "placed-first",
          "placed-second",
        ],
        label: "Pinned",
      },
      { conversations: ["today", "earlier"], label: "Today" },
    ]);
  });

  it("sorts and groups by the last Message, not by later tool or status events", () => {
    const sections = buildConversationSections(
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
