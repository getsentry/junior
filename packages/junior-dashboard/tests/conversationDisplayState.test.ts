import { describe, expect, it } from "vitest";
import { conversationDisplayState } from "../src/client/conversations/ConversationStateIcon";

const PIN = "2026-08-07T10:00:00.000Z";

describe("conversationDisplayState", () => {
  it("orders needs_you, working, watching, then the pin", () => {
    const row = { pinnedAt: PIN, status: "done" as const, watching: true };
    expect(conversationDisplayState({ ...row, treeState: "needs_you" })).toBe(
      "needs_you",
    );
    expect(conversationDisplayState({ ...row, treeState: "working" })).toBe(
      "working",
    );
    expect(conversationDisplayState({ ...row, treeState: "done" })).toBe(
      "watching",
    );
    expect(
      conversationDisplayState({ ...row, treeState: "done", watching: false }),
    ).toBe("pinned");
  });

  it("shows nothing for a done tree that is not pinned", () => {
    expect(
      conversationDisplayState({ status: "needs_input", treeState: "done" }),
    ).toBeUndefined();
  });

  it("works for a row without a tree state while its own status works", () => {
    expect(conversationDisplayState({ status: "working" })).toBe("working");
    expect(conversationDisplayState({ status: "done" })).toBeUndefined();
  });
});
