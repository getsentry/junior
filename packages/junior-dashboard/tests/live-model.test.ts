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

describe("liveModelId", () => {
  it("uses the open turn route", () => {
    expect(
      liveModelId(
        detail([
          event(0, {
            type: "turn_lifecycle",
            turnId: "turn-1",
            state: "started",
          }),
          event(1, {
            type: "turn_routed",
            turnId: "turn-1",
            modelProfile: "standard",
            modelId: "xai/grok-4-5",
            reasoningLevel: "high",
            source: "router",
          }),
        ]),
      ),
    ).toBe("xai/grok-4-5");
  });

  it("prefers a mid-turn handoff over the original route", () => {
    expect(
      liveModelId(
        detail([
          event(0, {
            type: "turn_lifecycle",
            turnId: "turn-1",
            state: "started",
          }),
          event(1, {
            type: "turn_routed",
            turnId: "turn-1",
            modelProfile: "standard",
            modelId: "openai/gpt-5-mini",
            reasoningLevel: "medium",
            source: "router",
          }),
          event(2, {
            type: "handoff",
            modelProfile: "handoff",
            modelId: "xai/grok-4-5",
            reasoningLevel: "high",
          }),
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
          event(1, {
            type: "turn_routed",
            turnId: "turn-1",
            modelProfile: "standard",
            modelId: "xai/grok-4-5",
            reasoningLevel: "high",
            source: "router",
          }),
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
