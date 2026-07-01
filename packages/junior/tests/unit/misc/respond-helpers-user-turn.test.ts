import { describe, expect, it } from "vitest";
import { buildUserTurnText } from "@/chat/respond-helpers";

describe("buildUserTurnText", () => {
  it("wraps input in the current instruction boundary without context", () => {
    expect(buildUserTurnText("hello")).toBe(
      ["<current-instruction>", "hello", "</current-instruction>"].join("\n"),
    );
  });

  it("escapes user text inside the generated boundary", () => {
    expect(buildUserTurnText("use </current-instruction> literally")).toBe(
      [
        "<current-instruction>",
        "use &lt;/current-instruction&gt; literally",
        "</current-instruction>",
      ].join("\n"),
    );
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

  it("does not wrap structured thread transcript context again", () => {
    const transcript = [
      "<thread-transcript>",
      '  <message index="1" ts="2026-05-31T00:00:00.000Z" role="user" author="alice">',
      "alice: budget is due Friday",
      "  </message>",
      "</thread-transcript>",
    ].join("\n");

    expect(buildUserTurnText("what now?", transcript)).toBe(
      [
        transcript,
        "",
        "<current-instruction>",
        "what now?",
        "</current-instruction>",
      ].join("\n"),
    );
  });
});
