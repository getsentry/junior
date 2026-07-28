import { describe, expect, it, vi } from "vitest";
import type { AnyToolDefinition } from "@/chat/tools/definition";
import {
  reviewToolAction,
  ToolActionReviewUnavailableError,
  type ToolActionReview,
  type ToolActionReviewer,
} from "@/chat/tool-support/action-review";

const LOCAL_SOURCE = {
  platform: "local",
  type: "priv",
  conversationId: "local:approval-test",
} as const;
const LOCAL_DESTINATION = {
  platform: "local",
  conversationId: "local:approval-test",
} as const;

function reviewContext(
  reviewer: ToolActionReview["reviewer"],
): ToolActionReview {
  return {
    context: {
      actor: {
        platform: "system",
        name: "scheduler",
      },
      conversationId: "local:approval-test",
      credentialContext: {
        actor: {
          platform: "system",
          name: "scheduler",
        },
        subject: {
          type: "user",
          userId: "U123",
          allowedWhen: "scheduled-task",
          taskId: "task-123",
          binding: {
            type: "scheduled-task",
            plugin: "scheduler",
            taskId: "task-123",
            signature: "must-not-reach-guardian",
          },
        },
      },
      destination: LOCAL_DESTINATION,
      source: LOCAL_SOURCE,
      userIntent: () => "Run my scheduled report.",
      evidence: () => ({
        entries: [
          { role: "user", text: "Run the report I described yesterday." },
        ],
        omittedEntries: 2,
      }),
    },
    priorRejections: [],
    pendingRejections: new Map(),
    onUnavailable: vi.fn(),
    rejectedActions: [],
    reviewer,
  };
}

function definition(
  overrides: Partial<AnyToolDefinition> = {},
): AnyToolDefinition {
  return {
    description: "Generate the scheduled report.",
    inputSchema: {},
    execute: async () => ({ ok: true }),
    ...overrides,
  };
}

describe("tool action review", () => {
  it("preserves execution behavior for unclassified tools", async () => {
    const reviewer = { review: vi.fn() };
    const resolveApprovalMetadata = vi.fn();

    await reviewToolAction(
      "generateReport",
      definition({ resolveApprovalMetadata }),
      { reportId: "weekly" },
      reviewContext(reviewer),
    );

    expect(reviewer.review).not.toHaveBeenCalled();
    expect(resolveApprovalMetadata).not.toHaveBeenCalled();
  });

  it("reviews auto plugin actions with exact input and safe credential context", async () => {
    const review = vi.fn<ToolActionReviewer["review"]>(async () => ({
      decision: "allow",
      reason: "Matches the scheduled request.",
      riskLevel: "low",
      userAuthorization: "high",
    }));
    const tool = definition({
      approvalMode: "auto",
      annotations: {
        destructiveHint: false,
        openWorldHint: true,
        readOnlyHint: true,
      },
      describeProposal: ({ reportId }) => `Generate report ${reportId}.`,
      identity: {
        id: "scheduler.generateReport",
        name: "generateReport",
        plugin: "scheduler",
      },
      source: {
        id: "scheduler",
        description: "Scheduled work",
      },
    });

    await reviewToolAction(
      "scheduler_generateReport",
      tool,
      { reportId: "weekly" },
      reviewContext({ review }),
    );

    const proposal = review.mock.calls[0]![0];
    expect(proposal).toMatchObject({
      context: {
        actor: { platform: "system", name: "scheduler" },
        conversationId: "local:approval-test",
        credential: {
          actor: { platform: "system", name: "scheduler" },
          subject: {
            allowedWhen: "scheduled-task",
            taskId: "task-123",
            type: "user",
            userId: "U123",
          },
        },
        userIntent: "Run my scheduled report.",
      },
      evidence: {
        entries: [
          { role: "user", text: "Run the report I described yesterday." },
        ],
        omittedEntries: 2,
      },
      input: { reportId: "weekly" },
      tool: {
        name: "scheduler_generateReport",
        proposalDescription: "Generate report weekly.",
      },
    });
    expect(JSON.stringify(proposal)).not.toContain("must-not-reach-guardian");
  });

  it("returns ask and deny decisions as expected tool rejections", async () => {
    for (const decision of ["ask", "deny"] as const) {
      const action = reviewToolAction(
        "generateReport",
        definition({ approvalMode: "review" }),
        { reportId: "weekly" },
        reviewContext({
          review: async () => ({
            decision,
            reason: "The destination is surprising.",
            riskLevel: "medium",
            userAuthorization: "low",
          }),
        }),
      );

      await expect(action).rejects.toMatchObject({
        decision,
        name: "ToolActionRejectedError",
      });
    }
  });

  it("blocks an exact denied action and shows denials to alternate tools", async () => {
    const review = vi
      .fn<ToolActionReviewer["review"]>()
      .mockResolvedValueOnce({
        decision: "deny",
        reason: "Deleting the workspace is outside the request.",
        riskLevel: "critical",
        userAuthorization: "low",
      })
      .mockResolvedValueOnce({
        decision: "deny",
        reason: "This is an equivalent destructive action.",
        riskLevel: "critical",
        userAuthorization: "low",
      });
    const context = reviewContext({ review });
    const input = { workspaceId: "workspace-123" };

    await expect(
      reviewToolAction(
        "deleteWorkspace",
        definition({ approvalMode: "review" }),
        input,
        context,
      ),
    ).rejects.toMatchObject({ decision: "deny" });
    await expect(
      reviewToolAction(
        "deleteWorkspace",
        definition({ approvalMode: "review" }),
        input,
        context,
      ),
    ).rejects.toThrow("previously rejected this exact action");
    expect(review).toHaveBeenCalledTimes(1);

    await expect(
      reviewToolAction(
        "runWorkspaceCleanup",
        definition({ approvalMode: "review" }),
        { target: "workspace-123", mode: "permanent" },
        context,
      ),
    ).rejects.toMatchObject({ decision: "deny" });
    expect(review.mock.calls[1]?.[0].priorRejectedActions).toEqual([
      expect.objectContaining({
        decision: "deny",
        input,
        reason: "Deleting the workspace is outside the request.",
        tool: expect.objectContaining({ name: "deleteWorkspace" }),
      }),
    ]);
  });

  it("does not re-review an ask without new user intent", async () => {
    let userIntent = "Schedule this every weekday.";
    const review = vi.fn<ToolActionReviewer["review"]>(async () => ({
      decision: "ask",
      reason: "The recurring schedule needs confirmation.",
      riskLevel: "medium",
      userAuthorization: "medium",
    }));
    const context = reviewContext({ review });
    context.context.userIntent = () => userIntent;
    const tool = definition({ approvalMode: "review" });
    const input = { schedule: "0 9 * * 1-5" };

    await expect(
      reviewToolAction("createSchedule", tool, input, context),
    ).rejects.toMatchObject({ decision: "ask" });
    await expect(
      reviewToolAction("createSchedule", tool, input, context),
    ).rejects.toThrow("previously rejected this exact action");
    expect(review).toHaveBeenCalledTimes(1);

    userIntent = "Yes, create that exact weekday schedule.";
    await expect(
      reviewToolAction("createSchedule", tool, input, context),
    ).rejects.toMatchObject({ decision: "ask" });
    expect(review).toHaveBeenCalledTimes(2);
    expect(review.mock.calls[1]?.[0].priorRejectedActions).toEqual([
      expect.objectContaining({
        decision: "ask",
        input,
        reason: "The recurring schedule needs confirmation.",
      }),
    ]);
  });

  it("fails closed before Guardian when authoritative context is missing", async () => {
    const reviewer = { review: vi.fn() };
    const actionReview = reviewContext(reviewer);
    actionReview.context.actor = undefined;

    await expect(
      reviewToolAction(
        "generateReport",
        definition({ approvalMode: "review" }),
        { reportId: "weekly" },
        actionReview,
      ),
    ).rejects.toBeInstanceOf(ToolActionReviewUnavailableError);
    expect(reviewer.review).not.toHaveBeenCalled();
  });

  it.each([
    [
      "approval metadata",
      (
        tool: AnyToolDefinition,
        _actionReview: ToolActionReview,
        failure: Error,
      ) => {
        tool.resolveApprovalMetadata = () => {
          throw failure;
        };
      },
    ],
    [
      "proposal description",
      (
        tool: AnyToolDefinition,
        _actionReview: ToolActionReview,
        failure: Error,
      ) => {
        tool.describeProposal = () => {
          throw failure;
        };
      },
    ],
    [
      "conversation evidence",
      (
        _tool: AnyToolDefinition,
        actionReview: ToolActionReview,
        failure: Error,
      ) => {
        actionReview.context.evidence = () => {
          throw failure;
        };
      },
    ],
  ])(
    "fails closed when %s preparation fails",
    async (_name, arrangeFailure) => {
      const reviewer = { review: vi.fn() };
      const tool = definition({ approvalMode: "review" });
      const actionReview = reviewContext(reviewer);
      const failure = new Error("review setup failed");
      arrangeFailure(tool, actionReview, failure);

      await expect(
        reviewToolAction(
          "generateReport",
          tool,
          { reportId: "weekly" },
          actionReview,
        ),
      ).rejects.toMatchObject({
        cause: failure,
        name: "ToolActionReviewUnavailableError",
      });
      expect(reviewer.review).not.toHaveBeenCalled();
    },
  );

  it("fails closed when Guardian cannot produce a decision", async () => {
    const action = reviewToolAction(
      "generateReport",
      definition({ approvalMode: "review" }),
      { reportId: "weekly" },
      reviewContext({
        review: async () => {
          throw new Error("provider unavailable");
        },
      }),
    );

    await expect(action).rejects.toBeInstanceOf(
      ToolActionReviewUnavailableError,
    );
  });
});
