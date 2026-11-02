import { describe, expect, it } from "vitest";

import {
  attentionFirst,
  buildConversationSections,
} from "../src/client/conversations/conversationSections";
import type { Conversation } from "../src/client/types";

function conversation(
  id: string,
  lastSeenAt: string,
  options: { isPriority?: boolean } = {},
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
    ...(options.isPriority ? { isPriority: true } : undefined),
  };
}

describe("conversation activity sections", () => {
  it("uses the feed isPriority flag for the Priority section", () => {
    const sections = buildConversationSections(
      [
        conversation("older", "2026-06-20T12:00:00-07:00"),
        conversation("two-weeks", "2026-07-19T12:00:00-07:00"),
        conversation("priority-unassigned", "2026-08-03T10:00:00-07:00", {
          isPriority: true,
        }),
        conversation("last-week", "2026-07-26T12:00:00-07:00"),
        conversation("finished-no-update", "2026-08-03T11:30:00-07:00"),
        conversation("finished-then-updated", "2026-08-03T11:40:00-07:00", {
          isPriority: true,
        }),
        conversation("unfinished-recent", "2026-08-03T11:45:00-07:00", {
          isPriority: true,
        }),
        conversation("unfinished-stale", "2026-08-01T11:00:00-07:00"),
        conversation("stale-unassigned", "2026-08-03T08:00:00-07:00"),
        conversation("yesterday", "2026-08-02T12:00:00-07:00"),
        conversation("weekday", "2026-08-01T10:00:00-07:00"),
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
        conversations: [
          "unfinished-recent",
          "finished-then-updated",
          "priority-unassigned",
        ],
        label: "Priority",
      },
      {
        conversations: ["finished-no-update", "stale-unassigned"],
        label: "Today",
      },
      { conversations: ["yesterday"], label: "Yesterday" },
      {
        conversations: ["unfinished-stale", "weekday"],
        label: "Saturday",
      },
      { conversations: ["last-week"], label: "Last week" },
      { conversations: ["two-weeks"], label: "2 weeks ago" },
      { conversations: ["three-weeks"], label: "3 weeks ago" },
      { conversations: ["older"], label: "Older" },
    ]);
  });

  it("puts attention conversations first, ahead of Priority", () => {
    const sections = buildConversationSections(
      [
        conversation("priority", "2026-08-03T11:00:00-07:00", {
          isPriority: true,
        }),
        conversation("waiting-priority", "2026-08-03T10:00:00-07:00", {
          isPriority: true,
        }),
        conversation("finished-unseen", "2026-08-02T12:00:00-07:00"),
        conversation("today", "2026-08-03T09:00:00-07:00"),
      ],
      {
        attentionIds: new Set(["waiting-priority", "finished-unseen"]),
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
        conversations: ["waiting-priority", "finished-unseen"],
        label: "Needs attention",
      },
      { conversations: ["priority"], label: "Priority" },
      { conversations: ["today"], label: "Today" },
    ]);
  });

  it("moves attention conversations before paging and keeps feed order", () => {
    const feed = ["a", "b", "c", "d", "e"].map((id) =>
      conversation(id, "2026-08-03T12:00:00-07:00"),
    );

    expect(
      attentionFirst(feed, new Set(["d", "b"])).map((item) => item.id),
    ).toEqual(["b", "d", "a", "c", "e"]);
  });
});
