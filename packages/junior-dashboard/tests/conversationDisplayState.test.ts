import { describe, expect, it } from "vitest";
import type { ConversationFeedItem } from "@sentry/junior/api/schema";
import { withViewerWaits } from "../src/client/conversations/conversationFeedCache";
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

  it("needs you when the Inbox says the row waits on you", () => {
    const row = { treeState: "working" as const, turnActive: true };
    expect(conversationDisplayState(row, true)).toBe("needs_you");
    expect(conversationDisplayState(row)).toBe("working");
  });

  it("works for a row without a tree state while its own Turn runs", () => {
    expect(conversationDisplayState({ turnActive: true })).toBe("working");
    expect(conversationDisplayState({ turnActive: false })).toBeUndefined();
  });
});

describe("withViewerWaits", () => {
  it("marks each row and Thread that the Inbox says waits on the viewer", () => {
    const row = (conversationId: string, threads?: ConversationFeedItem[]) =>
      ({
        conversationId,
        treeState: "done",
        ...(threads ? { threads } : undefined),
      }) as ConversationFeedItem;
    const feed = {
      conversations: [row("root", [row("thread"), row("other")]), row("idle")],
      generatedAt: PIN,
      source: "conversation_index" as const,
    };
    const marked = withViewerWaits(feed, new Set(["root", "thread"]));
    expect(
      marked.conversations.map((item) => [
        item.treeState,
        item.threads?.map((thread) => thread.treeState),
      ]),
    ).toEqual([
      ["needs_you", ["needs_you", "done"]],
      ["done", undefined],
    ]);
  });
});
