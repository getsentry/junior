import { describe, expect, it } from "vitest";

import {
  conversationOutlineItems,
  mergeConversationOutlineItems,
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
      message(2, "user", "**url** local para   verlo?", {
        actorIdentityId: "identity-asker",
        timestamp: 20,
      }),
      message(3, "assistant", "Checking."),
      message(4, "assistant", "Es la misma URL."),
      message(5, "user", "a Slack message", { context: true }),
      message(6, "user", "an Event", { eventType: "issue.created" }),
      message(7, "user", "second question"),
      message(8, "user", "pending send", { pending: true }),
    ]);

    expect(items).toEqual([
      {
        author: { actorIdentityId: "identity-asker" },
        seq: 2,
        timestamp: 20,
        title: "url local para verlo?",
        reply: "Es la misma URL.",
      },
      { author: {}, seq: 7, title: "second question" },
    ]);
  });

  it("joins the whole outline with the loaded items", () => {
    const outline = {
      items: [
        {
          createdAt: "2026-01-01T00:00:00.000Z",
          actorIdentityId: "identity-asker",
          agentInvocationId: "invocation-1",
          seq: 2,
          text: "**old** question",
          reply: "_old_ answer",
        },
        {
          createdAt: "2026-01-01T00:01:00.000Z",
          seq: 7,
          text: "loaded question cut",
        },
      ],
    };

    expect(
      mergeConversationOutlineItems(outline, [
        {
          author: {},
          seq: 7,
          title: "loaded question in full",
          reply: "Done.",
        },
        // Newer than the outline, from a live poll.
        { author: {}, seq: 12, title: "new question" },
      ]),
    ).toEqual([
      {
        author: {
          actorIdentityId: "identity-asker",
          agentInvocationId: "invocation-1",
        },
        seq: 2,
        timestamp: Date.parse("2026-01-01T00:00:00.000Z"),
        title: "old question",
        reply: "old answer",
      },
      {
        author: {},
        seq: 7,
        title: "loaded question in full",
        reply: "Done.",
      },
      { author: {}, seq: 12, title: "new question" },
    ]);
    expect(mergeConversationOutlineItems(undefined, [])).toEqual([]);
  });

  it("finds the item whose section holds a row", () => {
    const items = [
      { author: {}, seq: 2, title: "a" },
      { author: {}, seq: 7, title: "b" },
    ];

    expect(outlineItemAtSeq(items, 1)).toBeUndefined();
    expect(outlineItemAtSeq(items, 6)?.seq).toBe(2);
    expect(outlineItemAtSeq(items, 7)?.seq).toBe(7);
  });
});
