import { describe, expect, it } from "vitest";

import { reviewItemIdFromToolCall } from "../src/client/review-desk/reviewItemFormat";

const output = JSON.stringify({ created: true, item: { id: "item-1" } });

describe("reviewItemIdFromToolCall", () => {
  it("finds the item that addReviewItem added, directly or through executeTool", () => {
    expect(
      reviewItemIdFromToolCall({
        name: "addReviewItem",
        output,
        status: "completed",
      }),
    ).toBe("item-1");
    expect(
      reviewItemIdFromToolCall({
        input: { tool_name: "addReviewItem", arguments: {} },
        name: "executeTool",
        output,
        status: "completed",
      }),
    ).toBe("item-1");
  });

  it("ignores other tools, unfinished calls, and hidden results", () => {
    expect(
      reviewItemIdFromToolCall({
        input: { tool_name: "updateReviewItem" },
        name: "executeTool",
        output,
        status: "completed",
      }),
    ).toBeUndefined();
    expect(
      reviewItemIdFromToolCall({
        name: "addReviewItem",
        output,
        status: "running",
      }),
    ).toBeUndefined();
    expect(
      reviewItemIdFromToolCall({ name: "addReviewItem", status: "completed" }),
    ).toBeUndefined();
  });
});
