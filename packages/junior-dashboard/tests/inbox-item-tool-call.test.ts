import { describe, expect, it } from "vitest";

import {
  inboxItemAskFromToolCall,
  inboxItemIdFromToolCall,
} from "../src/client/inbox/inboxItemFormat";

const output = JSON.stringify({
  question: { id: "item-1", title: "Ship it?" },
  next_step: "End the Turn.",
});

describe("inboxItemIdFromToolCall", () => {
  it("finds the item that askUserQuestion added, directly or through executeTool", () => {
    expect(
      inboxItemIdFromToolCall({
        name: "askUserQuestion",
        output,
        status: "completed",
      }),
    ).toBe("item-1");
    expect(
      inboxItemIdFromToolCall({
        input: { tool_name: "askUserQuestion", arguments: {} },
        name: "executeTool",
        output,
        status: "completed",
      }),
    ).toBe("item-1");
    // Transcripts from before the renames have an old tool name.
    for (const name of ["addInboxItem", "addReviewItem"]) {
      expect(
        inboxItemIdFromToolCall({ name, output, status: "completed" }),
      ).toBe("item-1");
    }
  });

  it("names the question of the item, or the item's id for an old result", () => {
    // The question's item has the question's id.
    expect(
      inboxItemAskFromToolCall({
        name: "askUserQuestion",
        output,
        status: "completed",
      }),
    ).toEqual({ itemId: "item-1", questionId: "item-1" });
    // A result from before core stored questions names the added item.
    expect(
      inboxItemAskFromToolCall({
        name: "addInboxItem",
        output: {
          item: {
            id: "item-1",
            subject: { id: "question-1", kind: "question" },
          },
        },
        status: "completed",
      }),
    ).toEqual({ itemId: "item-1", questionId: "question-1" });
    // A result from before items had subjects. Its question took the item's
    // id.
    expect(
      inboxItemAskFromToolCall({
        name: "addInboxItem",
        output: { created: true, item: { id: "item-1" } },
        status: "completed",
      }),
    ).toEqual({ itemId: "item-1", questionId: "item-1" });
  });

  it("ignores other tools, unfinished calls, and hidden results", () => {
    expect(
      inboxItemIdFromToolCall({
        input: { tool_name: "updateInboxItem" },
        name: "executeTool",
        output,
        status: "completed",
      }),
    ).toBeUndefined();
    expect(
      inboxItemIdFromToolCall({
        name: "askUserQuestion",
        output,
        status: "running",
      }),
    ).toBeUndefined();
    expect(
      inboxItemIdFromToolCall({ name: "askUserQuestion", status: "completed" }),
    ).toBeUndefined();
  });
});
