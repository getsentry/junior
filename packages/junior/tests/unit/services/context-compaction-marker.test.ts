import { describe, expect, it } from "vitest";
import { renderCurrentInstruction } from "@/chat/current-instruction";
import {
  hasCompactedConversationContext,
  MODEL_HANDOFF_SUMMARY_PREFIX,
} from "@/chat/services/context-compaction-marker";

describe("hasCompactedConversationContext", () => {
  it("detects a handoff summary wrapped as the current instruction", () => {
    expect(
      hasCompactedConversationContext([
        {
          role: "user",
          content: [
            {
              type: "text",
              text: renderCurrentInstruction(
                `${MODEL_HANDOFF_SUMMARY_PREFIX}\nContinue the task.`,
              ),
            },
          ],
          timestamp: Date.now(),
        },
      ]),
    ).toBe(true);
  });
});
