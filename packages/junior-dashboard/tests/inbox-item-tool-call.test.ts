import { describe, expect, it } from "vitest";

import { inboxItemIdFromToolCall } from "../src/client/inbox/inboxItemFormat";

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
