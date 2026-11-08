import { describe, expect, it } from "vitest";
import { isConversationWorkDone } from "@/api/conversations/auto-archive";

const cutoffMs = Date.parse("2026-01-02T00:00:00.000Z");

describe("isConversationWorkDone", () => {
  it("requires finished assigned work before the cutoff", () => {
    expect(
      isConversationWorkDone(
        { assignedWork: true, finishedWorkAt: "2026-01-01T00:00:00.000Z" },
        cutoffMs,
      ),
    ).toBe(true);
    expect(
      isConversationWorkDone(
        {
          assignedWork: true,
          finishedWorkAt: "2026-01-01T00:00:00.000Z",
          unfinishedWork: true,
        },
        cutoffMs,
      ),
    ).toBe(false);
    expect(
      isConversationWorkDone(
        { assignedWork: true, finishedWorkAt: "2026-01-03T00:00:00.000Z" },
        cutoffMs,
      ),
    ).toBe(false);
  });

  it("treats a conversation without reported work as done", () => {
    expect(isConversationWorkDone({}, cutoffMs)).toBe(true);
  });

  it("keeps conversations where a person replied after the work finished", () => {
    expect(
      isConversationWorkDone(
        {
          assignedWork: true,
          finishedWorkAt: "2026-01-01T00:00:00.000Z",
          lastUserMessageAt: "2026-01-01T06:00:00.000Z",
        },
        cutoffMs,
      ),
    ).toBe(false);
  });
});
