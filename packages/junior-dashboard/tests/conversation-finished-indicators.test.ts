import { describe, expect, it } from "vitest";

import {
  finishedConversationIds,
  reconcileStoredStates,
} from "../src/client/conversations/useConversationFinishedIndicators";
import type { Conversation } from "../src/client/types";

function conversation(
  id: string,
  status: Conversation["status"],
  lastSeenAt = "2026-09-11T00:00:00.000Z",
): Conversation {
  return {
    cumulativeDurationMs: 0,
    displayTitle: id,
    id,
    lastProgressAt: lastSeenAt,
    lastSeenAt,
    startedAt: "2026-09-11T00:00:00.000Z",
    status,
    surface: "api",
  };
}

describe("conversation finished indicators", () => {
  it("marks an idle conversation when it has activity after the last read", () => {
    const states = reconcileStoredStates(
      {},
      [conversation("a", "active")],
      undefined,
    );
    const updated = conversation("a", "completed", "2026-09-11T00:01:00.000Z");

    expect([...finishedConversationIds(states, [updated], undefined)]).toEqual([
      "a",
    ]);
  });

  it("records a selected conversation as read and removes hidden conversations", () => {
    const current = {
      a: { lastReadAt: "2026-09-11T00:00:00.000Z" },
      hidden: { lastReadAt: "2026-09-11T00:00:00.000Z" },
    };
    const updated = conversation("a", "completed", "2026-09-11T00:01:00.000Z");

    expect(reconcileStoredStates(current, [updated], "a")).toEqual({
      a: { lastReadAt: "2026-09-11T00:01:00.000Z" },
    });
    expect([...finishedConversationIds(current, [updated], "a")]).toEqual([]);
  });

  it("keeps conversations outside filtered results", () => {
    const current = {
      a: { lastReadAt: "2026-09-11T00:00:00.000Z" },
      hidden: { lastReadAt: "2026-09-11T00:00:00.000Z" },
    };

    expect(
      reconcileStoredStates(
        current,
        [conversation("a", "completed")],
        undefined,
        false,
      ),
    ).toEqual(current);
  });
});
