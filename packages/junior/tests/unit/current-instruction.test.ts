import { describe, expect, it } from "vitest";
import {
  EMPTY_INSTRUCTION_TEXT,
  normalizeLiveInstructionText,
} from "@/chat/current-instruction";

describe("normalizeLiveInstructionText", () => {
  it("keeps non-empty instruction text", () => {
    expect(normalizeLiveInstructionText("fix the type issue")).toBe(
      "fix the type issue",
    );
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeLiveInstructionText("  keep going  ")).toBe("keep going");
  });

  it("uses the empty marker when the live instruction has no text", () => {
    expect(normalizeLiveInstructionText("")).toBe(EMPTY_INSTRUCTION_TEXT);
    expect(normalizeLiveInstructionText("   ")).toBe(EMPTY_INSTRUCTION_TEXT);
  });
});
