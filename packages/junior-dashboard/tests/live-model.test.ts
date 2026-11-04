import { describe, expect, it } from "vitest";
import type { ConversationDetailReport } from "@sentry/junior/api/schema";

import { liveModelId } from "../src/client/conversations/ConversationPage";

function detail(
  events: ConversationDetailReport["events"],
): ConversationDetailReport {
  return {
    conversationId: "slack:CQA123:1770003600.000200",
    displayTitle: "Live model resolution",
    startedAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-01T00:01:00.000Z",
    lastProgressAt: "2026-01-01T00:01:00.000Z",
    status: "active",
    surface: "slack",
    isParticipant: false,
    cumulativeDurationMs: 0,
    generatedAt: "2026-01-01T00:01:00.000Z",
    eventHistory: { status: "available" },
    events,
  };
}

function event(
  seq: number,
  data: ConversationDetailReport["events"][number]["data"],
): ConversationDetailReport["events"][number] {
  return {
    seq,
    createdAt: `2026-01-01T00:00:${String(seq).padStart(2, "0")}.000Z`,
    data,
  };
}

function assistantCall(seq: number, modelId: string) {
  return {
    ...event(seq, {
      type: "assistant_message",
      parts: [],
    }),
    model: { modelId },
  };
}

describe("liveModelId", () => {
  it("uses the model of the latest call in the open turn", () => {
    expect(
      liveModelId(
        detail([
          event(0, {
            type: "turn_lifecycle",
            turnId: "turn-1",
            state: "started",
          }),
          assistantCall(1, "openai/gpt-5-mini"),
          assistantCall(2, "xai/grok-4-5"),
        ]),
      ),
    ).toBe("xai/grok-4-5");
  });

  it("clears the live model after the turn ends", () => {
    expect(
      liveModelId(
        detail([
          event(0, {
            type: "turn_lifecycle",
            turnId: "turn-1",
            state: "started",
          }),
          assistantCall(1, "xai/grok-4-5"),
          event(2, {
            type: "turn_lifecycle",
            turnId: "turn-1",
            state: "succeeded",
          }),
        ]),
      ),
    ).toBeUndefined();
  });
});
