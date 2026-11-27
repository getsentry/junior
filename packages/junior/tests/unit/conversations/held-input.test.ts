import { describe, expect, it } from "vitest";
import { capHeldInputs } from "@/chat/conversations/held-input";

const texts = (inputs: { text: string }[]) => inputs.map((input) => input.text);

describe("capHeldInputs", () => {
  it("keeps every held text under the cap, oldest first", () => {
    expect(texts(capHeldInputs(["first", "second"]))).toEqual([
      "first",
      "second",
    ]);
  });

  it("drops the oldest held texts over the cap and says how many", () => {
    const old = "a".repeat(9_000);
    const newer = "b".repeat(9_000);
    const newest = "c".repeat(9_000);
    const result = texts(capHeldInputs([old, newer, newest]));
    expect(result).toEqual([
      expect.stringMatching(
        /^2 earlier held Events are not shown\..*readConversationEvent/,
      ),
      newest,
    ]);
  });

  it("cuts one oversized held text to the cap and marks it", () => {
    const [cut] = texts(capHeldInputs(["x".repeat(20_000)]));
    expect(cut).toHaveLength(16_000);
    expect(cut).toMatch(
      /^x+ \[truncated: read the full Message with readConversationEvent\]$/,
    );
  });
});
