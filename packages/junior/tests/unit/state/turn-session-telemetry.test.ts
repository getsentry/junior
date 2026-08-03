import { describe, expect, it } from "vitest";
import { getTurnTelemetryAttributes } from "@/chat/state/turn-session";

describe("turn session telemetry", () => {
  it("uses OTEL GenAI attributes and explicit Junior turn attributes", () => {
    expect(
      getTurnTelemetryAttributes({
        conversationId: "conversation-1",
        cumulativeDurationMs: 90_000,
        cumulativeUsage: {
          inputTokens: 10,
          outputTokens: 4,
          cost: { total: 0.25 },
        },
        modelId: "openai/gpt-test",
        resumeReason: "yield",
        sessionId: "turn-1",
        sliceId: 3,
        state: "completed",
        stepCount: 12,
        surface: "slack",
      }),
    ).toEqual({
      "app.ai.turn.id": "turn-1",
      "app.ai.turn.resume_reason": "yield",
      "app.ai.turn.runtime_ms": 90_000,
      "app.ai.turn.slice_id": 3,
      "app.ai.turn.state": "completed",
      "app.ai.turn.step_count": 12,
      "app.ai.turn.surface": "slack",
      "app.cost.total_usd": 0.25,
      "gen_ai.conversation.id": "conversation-1",
      "gen_ai.request.model": "openai/gpt-test",
      "gen_ai.usage.input_tokens": 10,
      "gen_ai.usage.output_tokens": 4,
    });
  });
});
