import { describe, expect, it } from "vitest";

import {
  inboxItemAskFromToolCall,
  inboxItemIdFromToolCall,
} from "../src/client/inbox/inboxItemFormat";

const output = JSON.stringify({ created: true, item: { id: "item-1" } });

describe("inboxItemIdFromToolCall", () => {
  it("finds the item that addInboxItem added, directly or through executeTool", () => {
    expect(
      inboxItemIdFromToolCall({
        name: "addInboxItem",
        output,
        status: "completed",
      }),
    ).toBe("item-1");
    expect(
      inboxItemIdFromToolCall({
        input: { tool_name: "addInboxItem", arguments: {} },
        name: "executeTool",
        output,
        status: "completed",
      }),
    ).toBe("item-1");
    // Transcripts from before the rename have the old tool name.
    expect(
      inboxItemIdFromToolCall({
        name: "addReviewItem",
        output,
        status: "completed",
      }),
    ).toBe("item-1");
  });

  it("names the question of the item, or the item's id for an old result", () => {
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
        output,
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
        name: "addInboxItem",
        output,
        status: "running",
      }),
    ).toBeUndefined();
    expect(
      inboxItemIdFromToolCall({ name: "addInboxItem", status: "completed" }),
    ).toBeUndefined();
  });
});
