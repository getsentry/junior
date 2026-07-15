import { describe, expect, it } from "vitest";
import {
  hasRuntimeTurnContextMessages,
  retainRuntimeTurnContextMessages,
  stripRuntimeTurnContextMessages,
} from "@/chat/conversations/model-messages";

const runtimePart = {
  type: "text",
  text: "<runtime-turn-context>volatile</runtime-turn-context>",
};
const instructionPart = { type: "text", text: "keep me" };

describe("opaque conversation model messages", () => {
  it("detects and retains only user runtime context", () => {
    const messages = [
      { role: "assistant", content: [runtimePart] },
      { role: "user", content: [runtimePart, instructionPart] },
    ];

    expect(hasRuntimeTurnContextMessages(messages)).toBe(true);
    expect(retainRuntimeTurnContextMessages(messages)).toEqual([
      { role: "user", content: [runtimePart] },
    ]);
  });

  it("strips runtime context and drops empty user messages", () => {
    const assistant = { role: "assistant", content: [runtimePart] };
    const messages = [
      assistant,
      { role: "user", content: [runtimePart] },
      { role: "user", content: [runtimePart, instructionPart] },
    ];

    expect(stripRuntimeTurnContextMessages(messages)).toEqual([
      assistant,
      { role: "user", content: [instructionPart] },
    ]);
  });
});
