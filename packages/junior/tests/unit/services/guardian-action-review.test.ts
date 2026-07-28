import { describe, expect, it, vi } from "vitest";
import { createGuardianActionReviewer } from "@/chat/services/guardian-action-review";
import type { ToolActionProposal } from "@/chat/tool-support/action-review";

const proposal: ToolActionProposal = {
  context: {
    actor: {
      platform: "local",
      userId: "local-user",
    },
    conversationId: "local:guardian-test",
    destination: {
      platform: "local",
      conversationId: "local:guardian-test",
    },
    source: {
      platform: "local",
      type: "priv",
      conversationId: "local:guardian-test",
    },
    userIntent: "Create a weekly report.",
  },
  input: {
    cadence: "weekly",
  },
  tool: {
    description: "Create a recurring report.",
    name: "createReport",
  },
};

describe("Guardian action review", () => {
  it("returns a schema-constrained decision for the exact proposal", async () => {
    const completeObject = vi.fn(async () => ({
      object: {
        decision: "ask" as const,
        reason: "Recurring work should be confirmed.",
        riskLevel: "medium" as const,
        userAuthorization: "low" as const,
      },
    }));
    const reviewer = createGuardianActionReviewer({
      modelId: "test/guardian",
      completeObject: completeObject as never,
    });

    await expect(reviewer.review(proposal)).resolves.toEqual({
      decision: "ask",
      reason: "Recurring work should be confirmed.",
      riskLevel: "medium",
      userAuthorization: "low",
    });
    expect(completeObject).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: "test/guardian",
        prompt: expect.stringContaining('"cadence": "weekly"'),
        recordTelemetryPayloads: false,
      }),
    );
  });

  it("rejects non-JSON action input before model review", async () => {
    const completeObject = vi.fn();
    const reviewer = createGuardianActionReviewer({
      completeObject: completeObject as never,
      modelId: "test/guardian",
    });

    await expect(
      reviewer.review({
        ...proposal,
        input: { invalid: 1n },
      }),
    ).rejects.toThrow("Invalid input");
    expect(completeObject).not.toHaveBeenCalled();
  });
});
