import { describe, expect, it } from "vitest";
import {
  AgentContinuationSliceLimitError,
  buildAgentContinuationLimitResponse,
} from "@/chat/services/agent-continuation-errors";

describe("agent continuation errors", () => {
  it("keeps the internal limit in diagnostics", () => {
    expect(new AgentContinuationSliceLimitError(48)).toMatchObject({
      name: "AgentContinuationSliceLimitError",
      message: "Agent continuation exceeded slice limit (48)",
    });
  });

  it("gives users an actionable response without internal implementation details", () => {
    const response = buildAgentContinuationLimitResponse("abc123");

    expect(response).toContain("ran for too long");
    expect(response).toContain("smaller or more specific request");
    expect(response).toContain("event_id=abc123");
    expect(response).not.toContain("slice");
  });
});
