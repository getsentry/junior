import { describe, expect, it } from "vitest";

import { heldRows, rowPlaces } from "../src/client/review-desk/heldRows";
import type { ConversationRow } from "../src/client/review-desk/inboxData";
import type { Conversation } from "../src/client/types";

function row(
  conversationId: string,
  time: string,
  pinnedAt?: string,
): ConversationRow {
  return pinnedAt
    ? {
        conversation: {
          cumulativeDurationMs: 0,
          displayTitle: conversationId,
          id: conversationId,
          isParticipant: true,
          kind: "root",
          lastProgressAt: time,
          lastSeenAt: time,
          pinnedAt,
          startedAt: time,
          status: "done",
          turnActive: false,
          surface: "internal",
        } satisfies Conversation,
        conversationId,
        time,
      }
    : { conversationId, time };
}

const shown = (rows: readonly ConversationRow[]) =>
  rows.map((item) => `${item.conversationId}@${item.time}`);

describe("heldRows", () => {
  it("shows the latest rows when nothing holds them", () => {
    const latest = [row("b", "2"), row("a", "1")];
    expect(heldRows(latest, undefined)).toBe(latest);
  });

  it("keeps held rows in the order and section time the reader saw", () => {
    const held = rowPlaces([row("a", "3"), row("b", "2"), row("c", "1")]);
    // A refresh: new activity on "c" moves it to the top.
    const latest = [row("c", "9"), row("a", "3"), row("b", "2")];
    expect(shown(heldRows(latest, held))).toEqual(["a@3", "b@2", "c@1"]);
  });

  it("puts added rows in their own place and drops removed ones", () => {
    const held = rowPlaces([row("a", "3"), row("b", "2"), row("c", "1")]);
    const latest = [
      row("b", "2"),
      row("new", "5"),
      row("a", "4"),
      row("d", "0"),
    ];
    expect(shown(heldRows(latest, held))).toEqual([
      "a@3",
      "new@5",
      "b@2",
      "d@0",
    ]);
  });

  it("shows a pin at once, where the latest order puts it", () => {
    const held = rowPlaces([row("a", "3"), row("b", "2")]);
    const latest = [row("b", "2", "9"), row("a", "3")];
    expect(shown(heldRows(latest, held))).toEqual(["b@2", "a@3"]);
  });
});
