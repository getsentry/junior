import { describe, expect, it } from "vitest";
import type { PiMessage } from "@/chat/pi/messages";
import {
  hasRuntimeTurnContext,
  retainRuntimeTurnContext,
  stripRuntimeTurnContext,
} from "@/chat/pi/transcript";

const runtimePart = {
  type: "text",
  text: "<runtime-turn-context>volatile</runtime-turn-context>",
};
const instructionPart = { type: "text", text: "keep me" };

function asPiMessages(messages: unknown[]): PiMessage[] {
  return messages as PiMessage[];
}

describe("Pi runtime turn context", () => {
  it("detects and retains only user runtime context", () => {
    const messages = asPiMessages([
      { role: "assistant", content: [runtimePart] },
      { role: "user", content: [runtimePart, instructionPart] },
    ]);

    expect(hasRuntimeTurnContext(messages)).toBe(true);
    expect(retainRuntimeTurnContext(messages)).toEqual([
      { role: "user", content: [runtimePart] },
    ]);
  });

  it("retains and strips a standalone context message before its instruction", () => {
    const messages = asPiMessages([
      {
        role: "user",
        content: [
          runtimePart,
          {
            type: "text",
            text: "<thread-background>facts</thread-background>",
          },
        ],
        timestamp: 10,
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "<current-instruction>do the work</current-instruction>",
          },
        ],
        timestamp: 10,
      },
    ]);

    expect(retainRuntimeTurnContext(messages)).toEqual([messages[0]]);
    expect(stripRuntimeTurnContext(messages)).toEqual([messages[1]]);
  });

  it("strips runtime context and drops empty user messages", () => {
    const assistant = { role: "assistant", content: [runtimePart] };
    const messages = asPiMessages([
      assistant,
      { role: "user", content: [runtimePart] },
      { role: "user", content: [runtimePart, instructionPart] },
    ]);

    expect(stripRuntimeTurnContext(messages)).toEqual([
      assistant,
      { role: "user", content: [instructionPart] },
    ]);
  });
});
