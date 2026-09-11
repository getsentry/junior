import { describe, expect, it } from "vitest";

import { reconcileStoredStates } from "../src/client/conversations/useConversationFinishedIndicators";
import type { Conversation } from "../src/client/types";

function conversation(
  id: string,
  status: Conversation["status"],
): Conversation {
  return {
    cumulativeDurationMs: 0,
    displayTitle: id,
    id,
    lastProgressAt: "2026-09-11T00:00:00.000Z",
    lastSeenAt: "2026-09-11T00:00:00.000Z",
    startedAt: "2026-09-11T00:00:00.000Z",
    status,
    surface: "api",
  };
}

describe("conversation finished indicators", () => {
  it("marks a visible conversation when it changes from active to completed", () => {
    const active = reconcileStoredStates(
      {},
      [conversation("a", "active")],
      undefined,
    );
    const completed = reconcileStoredStates(
      active,
      [conversation("a", "completed")],
      undefined,
    );

    expect(completed.a).toEqual({
      finishedSinceSeen: true,
      status: "completed",
    });
  });

  it("clears selected conversations and removes conversations outside the visible list", () => {
    const current = {
      a: { finishedSinceSeen: true, status: "completed" as const },
      hidden: { finishedSinceSeen: true, status: "completed" as const },
    };

    expect(
      reconcileStoredStates(current, [conversation("a", "completed")], "a"),
    ).toEqual({
      a: { finishedSinceSeen: false, status: "completed" },
    });
  });
});
