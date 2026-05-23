import { describe, expect, it } from "vitest";
import { buildUserTurnText } from "@/chat/respond-helpers";

describe("buildUserTurnText", () => {
  it("returns raw input when no context or metadata is provided", () => {
    expect(buildUserTurnText("hello")).toBe("hello");
  });

  it("keeps only causal thread context around the current instruction", () => {
    expect(buildUserTurnText("what now?", "alice: budget is due Friday")).toBe(
      [
        "<thread-background>",
        "alice: budget is due Friday",
        "</thread-background>",
        "",
        "<current-instruction>",
        "what now?",
        "</current-instruction>",
      ].join("\n"),
    );
  });
});
