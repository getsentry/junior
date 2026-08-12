import { describe, expect, it } from "vitest";

import { isConversationPriority } from "@/api/conversations/priority";

const NOW_MS = Date.parse("2026-08-03T19:00:00.000Z");

describe("isConversationPriority", () => {
  it("keeps unfinished work only while last seen within 48 hours", () => {
    expect(
      isConversationPriority(
        {
          unfinishedWork: true,
          lastSeenAt: "2026-08-03T18:00:00.000Z",
        },
        NOW_MS,
      ),
    ).toBe(true);
    expect(
      isConversationPriority(
        {
          unfinishedWork: true,
          lastSeenAt: "2026-08-01T18:00:00.000Z",
        },
        NOW_MS,
      ),
    ).toBe(false);
  });

  it("keeps finished assigned work only when activity is after the finish time", () => {
    expect(
      isConversationPriority(
        {
          assignedWork: true,
          finishedWorkAt: "2026-08-03T17:00:00.000Z",
          lastSeenAt: "2026-08-03T18:00:00.000Z",
        },
        NOW_MS,
      ),
    ).toBe(true);
    expect(
      isConversationPriority(
        {
          assignedWork: true,
          finishedWorkAt: "2026-08-03T18:00:00.000Z",
          lastSeenAt: "2026-08-03T18:00:00.000Z",
        },
        NOW_MS,
      ),
    ).toBe(false);
  });

  it("keeps conversations with no known work only while last seen within 3 hours", () => {
    expect(
      isConversationPriority(
        {
          lastSeenAt: "2026-08-03T17:00:00.000Z",
        },
        NOW_MS,
      ),
    ).toBe(true);
    expect(
      isConversationPriority(
        {
          lastSeenAt: "2026-08-03T15:00:00.000Z",
        },
        NOW_MS,
      ),
    ).toBe(false);
  });
});
