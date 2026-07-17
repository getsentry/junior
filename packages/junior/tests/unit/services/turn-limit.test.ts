import { describe, expect, it } from "vitest";
import {
  TurnSliceLimitExceededError,
  buildTurnLimitResponse,
} from "@/chat/services/turn-limit";

describe("turn execution limit", () => {
  it("keeps the internal limit in diagnostics", () => {
    expect(new TurnSliceLimitExceededError(100)).toMatchObject({
      name: "TurnSliceLimitExceededError",
      message: "Agent turn exceeded execution limit (100 slices)",
    });
  });

  it("gives users an actionable response without internal implementation details", () => {
    const response = buildTurnLimitResponse("abc123");

    expect(response).toContain("reached its execution limit");
    expect(response).toContain("smaller or more specific request");
    expect(response).toContain("event_id=abc123");
    expect(response).not.toContain("continuation");
  });
});
