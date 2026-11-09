import { describe, expect, it } from "vitest";

import type { ConversationSection } from "../src/client/conversations/conversationSections";
import {
  holdSectionOrder,
  sectionOrder,
} from "../src/client/conversations/heldListOrder";
import type { Conversation } from "../src/client/types";

function conversation(id: string, title = id): Conversation {
  return {
    kind: "root",
    cumulativeDurationMs: 0,
    displayTitle: title,
    id,
    lastProgressAt: "2026-08-03T12:00:00Z",
    lastSeenAt: "2026-08-03T12:00:00Z",
    startedAt: "2026-08-03T12:00:00Z",
    status: "completed",
    surface: "internal",
  };
}

function section(key: string, ...rows: Conversation[]): ConversationSection {
  return { conversations: rows, key, label: key };
}

function shown(sections: ConversationSection[]) {
  return sections.map((item) => [
    item.key,
    item.conversations.map((row) => row.displayTitle),
  ]);
}

const a = conversation("a");
const b = conversation("b");
const c = conversation("c");
const d = conversation("d");

describe("held list order", () => {
  it("keeps the held order and shows the latest row data", () => {
    const held = sectionOrder([section("today", a, b, c)]);
    const latest = [
      section("attention", { ...c, displayTitle: "c, now unread" }),
      section("today", b, a),
    ];

    const view = holdSectionOrder(held, latest);

    expect(shown(view.sections)).toEqual([
      ["today", ["a", "b", "c, now unread"]],
    ]);
    // c changed section, and one of a and b must move.
    expect(view.pending).toBe(2);
  });

  it("counts a new row as pending and drops a row that is gone", () => {
    const held = sectionOrder([section("today", a, b, c)]);
    const view = holdSectionOrder(held, [section("today", d, a, c)]);

    expect(shown(view.sections)).toEqual([["today", ["a", "c"]]]);
    expect(view.pending).toBe(1);
  });

  it("counts one move as one update", () => {
    const held = sectionOrder([section("today", a, b, c, d)]);
    const view = holdSectionOrder(held, [section("today", d, a, b, c)]);

    expect(view.pending).toBe(1);
  });

  it("has nothing pending when the order did not change", () => {
    const sections = [section("pinned", a), section("today", b, c)];
    const view = holdSectionOrder(sectionOrder(sections), sections);

    expect(shown(view.sections)).toEqual(shown(sections));
    expect(view.pending).toBe(0);
  });
});
