import { describe, expect, it } from "vitest";
import { renderCurrentInstruction } from "@/chat/current-instruction";
import {
  ACTIVE_TURN_COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_PREFIX,
  hasCompactedConversationContext,
} from "@/chat/services/context-compaction-marker";

describe("hasCompactedConversationContext", () => {
  it("detects active-turn continuation state", () => {
    expect(
      hasCompactedConversationContext([
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `${ACTIVE_TURN_COMPACTION_SUMMARY_PREFIX}\nContinue verification.`,
            },
          ],
          timestamp: Date.now(),
        },
      ]),
    ).toBe(true);
  });

  it("detects a compaction summary wrapped as the current instruction", () => {
    expect(
      hasCompactedConversationContext([
        {
          role: "user",
          content: [
            {
              type: "text",
              text: renderCurrentInstruction(
                `${COMPACTION_SUMMARY_PREFIX}\nContinue the task.`,
              ),
            },
          ],
          timestamp: Date.now(),
        },
      ]),
    ).toBe(true);
  });
});
