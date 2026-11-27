import { describe, expect, it } from "vitest";
import { conversationDisplayState } from "../src/client/conversations/ConversationStateIcon";

const PIN = "2026-08-07T10:00:00.000Z";

describe("conversationDisplayState", () => {
  it("orders needs_you, working, watching, then the pin", () => {
    const row = { pinnedAt: PIN, turnActive: false, watching: true };
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
      conversationDisplayState({ turnActive: false, treeState: "done" }),
    ).toBeUndefined();
  });

  it("works for a row without a tree state while its own Turn runs", () => {
    expect(conversationDisplayState({ turnActive: true })).toBe("working");
    expect(conversationDisplayState({ turnActive: false })).toBeUndefined();
  });
});
