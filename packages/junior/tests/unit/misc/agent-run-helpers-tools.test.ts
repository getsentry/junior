import { describe, expect, it } from "vitest";
import { getSuccessfulToolCalls } from "@/chat/agent-run-helpers";

describe("getSuccessfulToolCalls", () => {
  it("omits failed tool results", () => {
    expect(
      getSuccessfulToolCalls([
        { role: "toolResult", toolName: "createMemory", isError: true },
        { role: "toolResult", toolName: "searchMemories", isError: false },
        { role: "toolResult", name: "removeMemory" },
      ]),
    ).toEqual(["searchMemories", "removeMemory"]);
  });
});
