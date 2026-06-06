import { describe, expect, it } from "vitest";
import { truncateStatusText } from "@/chat/slack/status-format";

describe("status formatting", () => {
  it("truncates long status text with ellipsis", () => {
    expect(truncateStatusText("  " + "x".repeat(60) + "  ")).toBe(
      "x".repeat(47) + "...",
    );
  });
});
