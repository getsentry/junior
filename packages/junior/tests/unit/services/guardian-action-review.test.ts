import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGuardianActionReviewer } from "@/chat/services/guardian-action-review";
import { ProviderError } from "@/chat/services/provider-error";
import type { ToolActionProposal } from "@/chat/tool-support/action-review";

const mocks = vi.hoisted(() => ({
  logWarn: vi.fn(),
}));

vi.mock("@/chat/logging", () => ({
  logWarn: mocks.logWarn,
}));

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
      kind: "local",
      visibility: "private",
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
  beforeEach(() => {
    mocks.logWarn.mockReset();
  });

  it("returns a schema-constrained decision for the exact proposal", async () => {
    const completeObject = vi.fn(async () => ({
      object: {
        decision: "ask" as const,
        reason: "Recurring work should be confirmed.",
        riskLevel: "medium" as const,
        userAuthorization: "low" as const,
      },
      costUsd: 0.0042,
    }));
    const reviewer = createGuardianActionReviewer({
      modelId: "test/guardian",
      completeObject: completeObject as never,
    });

    await expect(reviewer.review(proposal)).resolves.toEqual({
      costUsd: 0.0042,
      decision: "ask",
      reason: "Recurring work should be confirmed.",
      riskLevel: "medium",
      userAuthorization: "low",
    });
    expect(completeObject).toHaveBeenCalledWith(
      expect.objectContaining({
        maxTokens: 2_000,
        modelId: "test/guardian",
        prompt: expect.stringContaining('"cadence": "weekly"'),
        recordTelemetryPayloads: false,
      }),
    );
  });

  it("retries one invalid structured response", async () => {
    const invalidResponse = new ProviderError({
      kind: "invalid_response",
      retryable: false,
    });
    const completeObject = vi
      .fn()
      .mockRejectedValueOnce(invalidResponse)
      .mockResolvedValueOnce({
        object: {
          decision: "allow" as const,
          reason: "The requested report is routine and scoped.",
          riskLevel: "low" as const,
          userAuthorization: "high" as const,
        },
      });
    const reviewer = createGuardianActionReviewer({
      modelId: "test/guardian",
      completeObject: completeObject as never,
    });

    await expect(reviewer.review(proposal)).resolves.toMatchObject({
      decision: "allow",
      riskLevel: "low",
      userAuthorization: "high",
    });
    expect(completeObject).toHaveBeenCalledTimes(2);
    expect(mocks.logWarn).toHaveBeenCalledWith(
      "guardian.action_review.retrying",
      {
        "app.ai.provider_error.kind": "invalid_response",
        "app.guardian.review_attempt": 2,
        "gen_ai.request.model": "test/guardian",
      },
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
