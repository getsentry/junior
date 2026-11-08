import { describe, expect, it } from "vitest";

import {
  conversationOutlineItems,
  outlineItemAtSeq,
} from "../src/client/conversations/conversationOutlineItems";
import type { TranscriptViewMessage } from "../src/client/types";

function message(
  sourceSeq: number,
  role: TranscriptViewMessage["role"],
  text: string,
  extra: Partial<TranscriptViewMessage> = {},
): TranscriptViewMessage {
  return { parts: [{ type: "text", text }], role, sourceSeq, ...extra };
}

describe("conversation outline", () => {
  it("lists person messages with the last Junior reply to each", () => {
    const items = conversationOutlineItems([
      message(1, "assistant", "before any person message"),
      message(2, "user", "**url** local para   verlo?"),
      message(3, "assistant", "Checking."),
      message(4, "assistant", "Es la misma URL."),
      message(5, "user", "a Slack message", { context: true }),
      message(6, "user", "an Event", { eventType: "issue.created" }),
      message(7, "user", "second question"),
      message(8, "user", "pending send", { pending: true }),
    ]);

    expect(items).toEqual([
      { seq: 2, title: "url local para verlo?", reply: "Es la misma URL." },
      { seq: 7, title: "second question" },
    ]);
  });

  it("finds the item whose section holds a row", () => {
    const items = [
      { seq: 2, title: "a" },
      { seq: 7, title: "b" },
    ];

    expect(outlineItemAtSeq(items, 1)).toBeUndefined();
    expect(outlineItemAtSeq(items, 6)?.seq).toBe(2);
    expect(outlineItemAtSeq(items, 7)?.seq).toBe(7);
  });
});
