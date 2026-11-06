import { describe, expect, it } from "vitest";

import {
  buildConversationSections,
  pinnedAndAttentionFirst,
} from "../src/client/conversations/conversationSections";
import type { Conversation } from "../src/client/types";

function conversation(id: string, lastSeenAt: string): Conversation {
  return {
    kind: "root",
    cumulativeDurationMs: 0,
    displayTitle: id,
    id,
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
      { ...NOW, attentionIds: new Set() },
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

  it("puts attention conversations in Needs attention before Today", () => {
    const sections = buildConversationSections(
      [
        conversation("today", "2026-08-03T11:00:00-07:00"),
        conversation("today-unread", "2026-08-03T09:00:00-07:00"),
        conversation("yesterday", "2026-08-02T12:00:00-07:00"),
        conversation("waiting-old", "2026-07-31T12:00:00-07:00"),
        conversation("saturday", "2026-08-01T12:00:00-07:00"),
        // An open pull request waits on a person once Junior stops running.
        {
          ...conversation("open-pr", "2026-08-02T08:00:00-07:00"),
          unfinishedWork: true,
        },
        {
          ...conversation("open-pr-running", "2026-08-03T10:00:00-07:00"),
          status: "active",
          unfinishedWork: true,
        },
      ],
      { ...NOW, attentionIds: new Set(["today-unread", "waiting-old"]) },
    );

    expect(sectionIds(sections)).toEqual([
      {
        conversations: ["today-unread", "open-pr", "waiting-old"],
        label: "Needs attention",
      },
      { conversations: ["today", "open-pr-running"], label: "Today" },
      { conversations: ["yesterday"], label: "Yesterday" },
      { conversations: ["saturday"], label: "Previous 7 days" },
    ]);
  });

  it("puts pinned conversations only in Pinned, before Needs attention", () => {
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
        conversation("waiting", "2026-08-03T09:00:00-07:00"),
      ],
      { ...NOW, attentionIds: new Set(["pinned-earlier", "waiting"]) },
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
      { conversations: ["waiting"], label: "Needs attention" },
      { conversations: ["today"], label: "Today" },
    ]);
  });

  it("moves pinned, then attention conversations before paging", () => {
    const feed = ["a", "b", "c", "d", "e"].map((id) =>
      conversation(id, "2026-08-03T12:00:00-07:00"),
    );
    feed[4] = { ...feed[4]!, pinnedAt: "2026-08-03T08:00:00-07:00" };
    feed[2] = { ...feed[2]!, unfinishedWork: true };

    expect(
      pinnedAndAttentionFirst(feed, new Set(["d", "b"])).map((item) => item.id),
    ).toEqual(["e", "b", "c", "d", "a"]);
  });
});
