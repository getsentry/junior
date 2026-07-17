import { describe, expect, it } from "vitest";
import {
  TurnStepLimitExceededError,
  buildTurnStepLimitResponse,
} from "@/chat/services/turn-step-limit";

describe("turn step limit", () => {
  it("keeps the internal limit in diagnostics", () => {
    expect(new TurnStepLimitExceededError(100)).toMatchObject({
      name: "TurnStepLimitExceededError",
      message: "Agent turn exceeded step limit (100)",
    });
  });

  it("gives users an actionable response without internal implementation details", () => {
    const response = buildTurnStepLimitResponse("abc123");

    expect(response).toContain("reached its step limit");
    expect(response).toContain("smaller or more specific request");
    expect(response).toContain("event_id=abc123");
    expect(response).not.toContain("continuation");
  });
});
