import { describe, expect, it } from "vitest";
import { renderCurrentInstruction } from "@/chat/current-instruction";
import {
  ACTIVE_TURN_COMPACTION_SUMMARY_PREFIX,
  hasCompactedConversationContext,
  MODEL_HANDOFF_SUMMARY_PREFIX,
} from "@/chat/services/context-compaction-marker";

describe("hasCompactedConversationContext", () => {
  it("makes active-turn continuation conditional on no newer instruction", () => {
    expect(ACTIVE_TURN_COMPACTION_SUMMARY_PREFIX).toContain(
      "If a newer user instruction follows",
    );
  });

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
